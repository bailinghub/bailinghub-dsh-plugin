import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createAgentClientPlugin, createMemoryArtifactStore, createFileArtifactStore } from '../lib/index.js'
import { deliverArtifact } from '../lib/artifacts.js'
import { createMemorySessionScopeStore, createMockHost, createMockAgent, createMockTransport, baseAssembly, userMessage, MOCK_CONNECTION_KEY, turnResponse, settle } from './helpers/mock-host.mjs'
const body = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const sha256 = createHash('sha256').update(body).digest('hex')
const binding = { hubUrl: 'https://hub.example.com', clientAppId: 'shop', workspace: 'shop', sessionId: '123e4567-e89b-42d3-a456-426614179001' }
const options = { connectionKey: MOCK_CONNECTION_KEY, workspace: 'shop', expectedBinding: binding }
const source = { list: async () => [{ artifactRef: 'user-image', name: 'image.png', mime: 'image/png', bytes: body.length, sha256 }], read: async () => body }
const oldMetadata = { clientConversationId: 'conversation', clientTurnId: 'turn-5', runId: '123e4567-e89b-42d3-a456-426614174004' }
const failure = publicCode => Object.assign(new Error(publicCode), { publicCode })
const receipt = input => ({ state: 'ready', upload_id: input.uploadId, name: input.name, mime: input.mime, bytes: body.length, sha256,
  client_conversation_id: input.clientConversationId, client_turn_id: input.clientTurnId, ...(input.runId ? { run_id: input.runId } : {}), url: 'https://cdn.example.com/image.png' })
function fixture(store = createMemoryArtifactStore()) {
  const remote = new Map(), sent = []; let code = 'artifact_run_mismatch', loseAck = false
  const transport = {
    async getArtifact(id) { if (!remote.has(id)) throw failure('artifact_not_found'); return structuredClone(remote.get(id)) },
    async uploadArtifact(input) { sent.push(structuredClone(input)); if (input.runId) throw failure(code)
      const result = receipt(input); remote.set(input.uploadId, result); if (loseAck) throw failure('agent_transport_unavailable'); return result },
  }
  const args = { source, store, transport, sessionId: 'session', artifactRef: 'user-image', binding, options, metadata: oldMetadata, assertActive: async () => {} }
  return { args, transport, sent, remote, enable: () => { code = 'artifact_run_turn_mismatch' }, lose: () => { loseAck = true } }
}
async function seed(f) { await assert.rejects(deliverArtifact(f.args), { publicCode: 'artifact_run_mismatch' }); f.enable() }
test('old record recovers same upload identity and original turn; correction survives reopen and missing source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-link-'))
  try {
    const store = createFileArtifactStore({ directory }), f = fixture(store)
    await seed(f); const uploadId = f.sent[0].uploadId, original = await store.get(uploadId)
    const result = await deliverArtifact({ ...f.args, metadata: { clientConversationId: 'conversation', clientTurnId: 'turn-6' } })
    assert.equal(result.state, 'ready'); assert.equal(result.upload_id, uploadId); assert.equal(result.client_turn_id, 'turn-5'); assert.equal(result.run_id, undefined)
    assert.deepEqual(await store.get(uploadId), original); assert.equal(new Set(f.sent.map(x => x.uploadId)).size, 1); assert.equal(f.remote.size, 1)
    const count = f.sent.length
    const recovered = await deliverArtifact({ ...f.args, store: createFileArtifactStore({ directory }), source: { read: () => { throw Error('unavailable') } }, metadata: { clientConversationId: 'conversation', clientTurnId: 'turn-7' } })
    assert.deepEqual(recovered, result); assert.equal(f.sent.length, count)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('lost corrected ACK only reads original receipt without another upload', async () => {
  const f = fixture(); await seed(f); f.lose(); await assert.rejects(deliverArtifact(f.args), { publicCode: 'agent_transport_unavailable' })
  const count = f.sent.length; assert.equal((await deliverArtifact(f.args)).state, 'ready'); assert.equal(f.sent.length, count); assert.equal(f.remote.size, 1)
})
test('generic mismatch from old Core or wrong identity never repairs', async () => {
  const f = fixture(); for (let i = 0; i < 2; i++) await assert.rejects(deliverArtifact(f.args), { publicCode: 'artifact_run_mismatch' })
  assert.ok(f.sent.every(x => x.runId === oldMetadata.runId)); assert.equal(f.remote.size, 0)
})
test('404 proof must be explicit; network failure cannot detach run', async () => {
  const f = fixture(); await seed(f); let reads = 0
  f.transport.getArtifact = async () => { if (++reads === 1) throw failure('artifact_not_found'); throw failure('agent_transport_unavailable') }
  await assert.rejects(deliverArtifact(f.args), { publicCode: 'agent_transport_unavailable' }); assert.ok(f.sent.every(x => x.runId)); assert.equal(f.remote.size, 0)
})
test('correction storage failure stops before corrected upload', async () => {
  const base = createMemoryArtifactStore(), f = fixture({ get: id => base.get(id), reserve: record => { if (record.runLinkRepair) throw Error('disk full'); return base.reserve(record) } })
  await seed(f); await assert.rejects(deliverArtifact(f.args), { code: 'storage_error' }); assert.ok(f.sent.every(x => x.runId)); assert.equal(f.remote.size, 0)
})
test('lost or tampered correction is storage_error, not reconstructed from remote', async () => {
  for (const mode of ['missing', 'changed']) {
    const base = createMemoryArtifactStore(); let corrupt = false
    const f = fixture({ reserve: x => base.reserve(x), get: async id => { const x = await base.get(id); if (corrupt && x?.runLinkRepair) return mode === 'missing' ? null : { ...x, metadata: { ...x.metadata, clientTurnId: 'changed' } }; return x } })
    await seed(f); await deliverArtifact(f.args); corrupt = true; const count = f.sent.length
    await assert.rejects(deliverArtifact(f.args), { code: 'storage_error' }); assert.equal(f.sent.length, count)
  }
})
test('changed original authorization or content blocks correction', async () => {
  const f = fixture(); await seed(f)
  await assert.rejects(deliverArtifact({ ...f.args, binding: { ...binding, sessionId: 'replacement' } }), { code: 'artifact_conflict' })
  await assert.rejects(deliverArtifact({ ...f.args, source: { ...source, read: async () => Buffer.from('changed') } }), { code: 'artifact_content_changed' }); assert.equal(f.sent.length, 1)
})
test('revocation or cancellation after proof blocks corrected upload', async () => {
  const f = fixture(); await seed(f); let aborted = false; const get = f.transport.getArtifact
  f.transport.getArtifact = async id => { try { return await get(id) } finally { if (f.sent.length > 1) aborted = true } }
  await assert.rejects(deliverArtifact({ ...f.args, assertActive: async () => { if (aborted) throw failure('agent_request_cancelled') } }), { publicCode: 'agent_request_cancelled' })
  assert.ok(f.sent.every(x => x.runId)); assert.equal(f.remote.size, 0)
})
test('concurrent correction uses one local record and original upload identity', async () => {
  const f = fixture(); await seed(f); const values = await Promise.all([deliverArtifact(f.args), deliverArtifact(f.args)])
  assert.deepEqual(values[0], values[1]); assert.equal(new Set(f.sent.map(x => x.uploadId)).size, 1); assert.equal(f.remote.size, 1)
})
test('next cross-system turn uploads user and generated images without stale run or broadcast', async t => {
  const A = MOCK_CONNECTION_KEY, B = `conn_${'2'.repeat(32)}`, C = `conn_${'3'.repeat(32)}`
  const entries = [A, B, C].map((connectionKey, i) => ({ connectionKey, hubUrl: binding.hubUrl, clientAppId: ['shop', 'inventory', 'other'][i], workspace: ['shop', 'inventory', 'other'][i], sessionId: `123e4567-e89b-42d3-a456-42661417900${i+1}`, state: 'authorized', connectionName: `Synthetic ${i}` }))
  const host = createMockHost(), { agent, local } = createMockAgent('artifact-turn'), uploads = [], runs = new Map(); let seq = 0, newImage = false
  const mock = createMockTransport({ connectionsList: async () => ({ connections: entries, currentConnectionKey: C }), status: async opts => { assert.notEqual(opts.connectionKey, C); return entries.find(x => x.connectionKey === opts.connectionKey) },
    getConversationArchiveCapabilities: async () => ({ schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }),
    startTurn: async input => { const runId = `123e4567-e89b-42d3-a456-${426614174000+(++seq)}`; runs.set(runId, input); return turnResponse({ runId, tools: [] }) },
    uploadArtifact: async (input, opts) => { assert.equal(opts.connectionKey, A); if (input.runId) { const r = runs.get(input.runId); assert.equal(r.clientConversationId, input.clientConversationId); assert.equal(r.clientTurnId, input.clientTurnId) }; uploads.push(input); return receipt(input) },
    getArtifact: async () => { throw failure('artifact_not_found') },
  })
  const fileSource = { ...source, list: async () => ['user-image', ...(newImage ? ['generated-image'] : [])].map(artifactRef => ({ artifactRef, name: 'image.png', mime: 'image/png', bytes: body.length, sha256 })) }
  createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore(), artifactSource: fileSource, artifactStore: createMemoryArtifactStore() }).apply(host.ctx, { hubUrl: binding.hubUrl, clientAppId: 'shop', workspace: 'shop' }); t.after(() => host.dispose())
  const view = await host.services.get('bailingHubAgentClient').setSessionScope(agent.session.id, { connectionKeys: [A, B] }), ref = view.authorizations.find(x => x.connectionKey === A).authorizationRef
  const exec = { agent, callId: 'synthetic', signal: new AbortController().signal }
  const begin = async turn => { host.emit('agent/inbox/claimed', { agent, turn, message: userMessage(`m${turn}`, 'Use a selected image') }); await host.waterfall('system-prompt/assemble', baseAssembly(), exec, async () => baseAssembly()) }
  await begin(1); await local.get('search_business_capabilities').execute({ authorization_ref: ref, query: 'Find a permitted catalog tool' }, exec)
  host.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }); await settle()
  await begin(2); newImage = true
  const result = await local.get('upload_generated_artifacts').execute({ authorization_ref: ref, artifact_refs: ['user-image', 'generated-image'] }, exec)
  assert.equal(result.all_ready, true); assert.equal(seq, 1); assert.ok(uploads.every(x => x.runId === undefined)); assert.equal(mock.calls.filter(x => x.method === 'invoke').length, 0)
  assert.match(local.get('upload_generated_artifacts').description, /user-provided/)
})
