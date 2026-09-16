import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentClientPlugin, createFileArtifactStore, createMemoryArtifactStore } from '../lib/index.js'
import { deliverArtifact } from '../lib/artifacts.js'
import { baseAssembly, callsFor, createMockAgent, createMockHost, createMockTransport, createMemorySessionScopeStore, selectSessionScope, userMessage, MOCK_CONNECTION_KEY } from './helpers/mock-host.mjs'

const body = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const sha = createHash('sha256').update(body).digest('hex')
const source = { list: async () => ['front', 'side', 'detail'].map(artifactRef => ({ artifactRef, name: `${artifactRef}.png`, mime: 'image/png', bytes: body.length, sha256: sha })), read: async () => body }
const binding = { hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo', sessionId: '123e4567-e89b-42d3-a456-426614179001' }
const config = { hubUrl: binding.hubUrl, clientAppId: binding.clientAppId, workspace: 'demo' }
const options = { connectionKey: MOCK_CONNECTION_KEY, workspace: 'demo', expectedBinding: binding }
const metadata = { clientConversationId: 'conversation', clientTurnId: 'turn' }
function backend() {
  const records = new Map(); let uploads = 0; let loseAck = false
  const transport = { async uploadArtifact(input) {
    uploads++
    const receipt = { schema_version: 'bailing.agent-artifact.v1', upload_id: input.uploadId, workspace: 'demo', session_id: binding.sessionId,
      state: 'ready', name: input.name, mime: input.mime, bytes: input.body.length, sha256: sha, client_conversation_id: input.clientConversationId, client_turn_id: input.clientTurnId,
      ...(input.runId ? { run_id: input.runId } : {}),
      visibility: 'public', url: `https://cdn.example.com/${input.name}`, next_action: 'use_url' }
    records.set(input.uploadId, receipt)
    if (loseAck) throw Object.assign(new Error('synthetic lost ACK'), { publicCode: 'agent_transport_unavailable' })
    return receipt
  }, async getArtifact(id) { if (!records.has(id)) throw Object.assign(new Error('missing'), { publicCode: 'artifact_not_found' }); return records.get(id) } }
  return { transport, records, count: () => uploads, lose: () => { loseAck = true } }
}
test('persistent original receipt recovers a lost ACK after reopen without another upload or original file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-artifacts-'))
  try {
    const back = backend(); back.lose()
    const args = { source, store: createFileArtifactStore({ directory }), transport: back.transport, sessionId: 'session', artifactRef: 'front', binding, options, metadata, assertActive: async () => {} }
    await assert.rejects(deliverArtifact(args), { publicCode: 'agent_transport_unavailable' })
    const record = [...back.records.values()][0]
    const result = await deliverArtifact({ ...args, source: { read: () => { throw new Error('original file removed') } }, store: createFileArtifactStore({ directory }), metadata: { ...metadata, clientTurnId: 'new-turn' } })
    assert.equal(result.upload_id, record.upload_id); assert.equal(result.client_turn_id, 'turn'); assert.equal(back.count(), 1)
    await assert.rejects(deliverArtifact({ ...args, binding: { ...binding, sessionId: 'replacement' } }), { code: 'artifact_conflict' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('local save failure and generated content changes stop before upload', async () => {
  const back = backend(); const args = { source, store: { get: async () => null, reserve: async () => { throw new Error('disk full') } }, transport: back.transport, sessionId: 'session', artifactRef: 'front', binding, options, metadata, assertActive: async () => {} }
  await assert.rejects(deliverArtifact(args), { code: 'storage_error' }); assert.equal(back.count(), 0)
  await assert.rejects(deliverArtifact({ ...args, store: createMemoryArtifactStore(), source: { ...source, read: async () => Buffer.from('changed') } }), { code: 'artifact_content_changed' }); assert.equal(back.count(), 0)
})
async function fixture(t, overrides = {}, selected = true) {
  const host = createMockHost(); const { agent, local } = createMockAgent('artifacts'); const back = backend()
  const mock = createMockTransport({ ...back.transport, ...overrides })
  createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore(), artifactSource: source, artifactStore: createMemoryArtifactStore() }).apply(host.ctx, config)
  if (selected) await selectSessionScope(host, agent)
  host.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('message', 'Generate product images') })
  await host.waterfall('system-prompt/assemble', baseAssembly(), { agent, signal: new AbortController().signal }, async () => baseAssembly())
  t.after(() => host.dispose())
  return { host, agent, local, back, mock, exec: { agent, callId: 'upload-call', signal: new AbortController().signal } }
}
test('model can list images and upload a batch; partial failure is explicit and business invocation stays zero', async t => {
  const back = backend()
  const f = await fixture(t, { getArtifact: back.transport.getArtifact, uploadArtifact: async (input, opts) => {
    assert.equal(opts.connectionKey, MOCK_CONNECTION_KEY); assert.deepEqual(opts.expectedBinding, binding)
    if (input.name === 'side.png') throw Object.assign(new Error('offline'), { publicCode: 'agent_transport_unavailable' })
    return back.transport.uploadArtifact(input)
  } })
  const list = await f.local.get('list_generated_artifacts').execute({}, f.exec); assert.equal(list.artifacts.length, 3)
  const upload = f.local.get('upload_generated_artifacts'); const ref = upload.parameters.properties.authorization_ref.enum[0]
  const result = await upload.execute({ authorization_ref: ref, artifact_refs: ['front', 'side', 'detail'] }, f.exec)
  assert.deepEqual(result.results.map(x => x.state), ['ready', 'pending', 'ready']); assert.equal(result.all_ready, false)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(JSON.stringify(result).includes('access_token'), false)
})
test('empty scope exposes no upload tool and makes zero Hub requests', async t => {
  const f = await fixture(t, {}, false)
  assert.equal(f.local.has('upload_generated_artifacts'), false); assert.equal(f.mock.calls.length, 0)
})
test('cancel while upload is pending does not return actionable late URLs or restore tools', async t => {
  let release; const pending = new Promise(r => { release = r }); const back = backend()
  let entered; const started = new Promise(r => { entered = r })
  const f = await fixture(t, { uploadArtifact: async input => { entered(); await pending; return back.transport.uploadArtifact(input) } })
  const upload = f.local.get('upload_generated_artifacts'); const ref = upload.parameters.properties.authorization_ref.enum[0]
  const result = upload.execute({ authorization_ref: ref, artifact_refs: ['front'] }, f.exec)
  await started
  f.host.emit('session/event', f.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } })
  release(); await assert.rejects(result)
  assert.equal(f.local.has('upload_generated_artifacts'), false); assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})
test('old SDK has explicit unsupported upload result without breaking business tool registration', async t => {
  const f = await fixture(t)
  delete f.mock.transport.uploadArtifact; delete f.mock.transport.getArtifact
  const upload = f.local.get('upload_generated_artifacts'); const ref = upload.parameters.properties.authorization_ref.enum[0]
  const result = await upload.execute({ authorization_ref: ref, artifact_refs: ['front'] }, f.exec)
  assert.equal(result.results[0].error, 'artifact_unsupported'); assert.ok(f.local.has('employee_update'))
})

test('cross-system upload chooses only A; unselected C gets zero requests; revoked B blocks the whole group', async t => {
  const host = createMockHost(); const { agent, local } = createMockAgent('artifact-cross')
  const A = MOCK_CONNECTION_KEY; const B = `conn_${'2'.repeat(32)}`; const C = `conn_${'3'.repeat(32)}`
  const entries = [A, B, C].map((connectionKey, index) => ({ connectionKey, hubUrl: binding.hubUrl, clientAppId: ['dsh_client', 'inventory', 'other'][index],
    workspace: ['demo', 'inventory', 'other'][index], sessionId: `123e4567-e89b-42d3-a456-${String(426614179001 + index)}`, state: 'authorized', connectionName: `Account ${index}`, current: index === 2 }))
  let revoke = false; const back = backend()
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: C, connections: entries }),
    status: async opts => {
      assert.notEqual(opts.connectionKey, C)
      const entry = entries.find(x => x.connectionKey === opts.connectionKey)
      return { state: revoke && entry.connectionKey === B ? 'logged_out' : 'authorized', sessionId: entry.sessionId, workspace: entry.workspace, connectionKey: entry.connectionKey }
    },
    getConversationArchiveCapabilities: async () => ({ schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }),
    uploadArtifact: async (input, opts) => { assert.equal(opts.connectionKey, A); return back.transport.uploadArtifact(input) },
    getArtifact: back.transport.getArtifact,
  })
  createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore(), artifactSource: source, artifactStore: createMemoryArtifactStore() }).apply(host.ctx, config)
  t.after(() => host.dispose())
  const runtime = host.services.get('bailingHubAgentClient')
  await runtime.setSessionScope(agent.session.id, { connectionKeys: [A, B] })
  host.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('cross-message', 'Prepare product images') })
  await host.waterfall('system-prompt/assemble', baseAssembly(), { agent, signal: new AbortController().signal }, async () => baseAssembly())
  const upload = local.get('upload_generated_artifacts'); assert.ok(upload)
  const authorization_ref = upload.parameters.properties.authorization_ref.enum[0]
  const exec = { agent, callId: 'cross-upload', signal: new AbortController().signal }
  assert.equal((await upload.execute({ authorization_ref, artifact_refs: ['front'] }, exec)).all_ready, true)
  assert.equal(callsFor(mock.calls, 'startTurn').length, 0, 'image delivery alone never creates business runs in other systems')
  assert.equal(callsFor(mock.calls, 'invoke').length, 0)
  revoke = true
  await assert.rejects(upload.execute({ authorization_ref, artifact_refs: ['side'] }, exec))
  assert.equal(back.count(), 1)
})
