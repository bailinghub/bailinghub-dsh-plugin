import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin } from '../lib/index.js'
import { createFileSessionScopeStore, createMemorySessionScopeStore } from '../lib/session-scope-store.js'
import { createFileConversationArchiveStore, createMemoryConversationArchiveStore } from '../lib/conversation-archive-store.js'
import { baseAssembly, callsFor, createMockAgent, createMockHost, createMockTransport, turnResponse, userMessage } from './helpers/mock-host.mjs'

const HUB = 'https://hub.example.com'
const A = `conn_${'1'.repeat(32)}`
const B = `conn_${'2'.repeat(32)}`
const C = `conn_${'3'.repeat(32)}`
const uuid = (number) => `123e4567-e89b-42d3-a456-${String(number).padStart(12, '0')}`
const CAPABILITY = { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
const BUSINESS = new Set(['startTurn', 'searchCapabilities', 'invoke', 'resume', 'completeRun'])
const config = { hubUrl: HUB, clientAppId: 'cashier_app', workspace: 'cashier', connectionName: 'Cashier A' }

function server() {
  return {
    entries: [
      { connectionKey: A, ...config },
      { connectionKey: B, hubUrl: HUB, clientAppId: 'crm_app', workspace: 'crm', connectionName: 'CRM A' },
      { connectionKey: C, hubUrl: HUB, clientAppId: 'erp_app', workspace: 'erp', connectionName: 'Unselected ERP' },
    ].map((item, index) => ({ ...item, state: 'authorized', current: index === 2, sessionId: uuid(index + 1) })),
    offline: false, supported: true, pending: false, loseAck: false,
    runs: new Map(), invocations: new Map(), received: new Map(), count: 100,
  }
}

function fixture(t, options = {}) {
  const backend = options.backend ?? server()
  const host = createMockHost()
  const client = createMockAgent('cross-system')
  client.agent.session = options.session ?? Session.create('cross-system-session', [])
  const scopeStore = options.scopeStore ?? createMemorySessionScopeStore()
  const archiveStore = options.archiveStore ?? createMemoryConversationArchiveStore()
  const target = (metadata) => {
    assert.ok([A, B].includes(metadata.connectionKey), 'no unselected or implicit target may be inspected')
    const entry = backend.entries.find((item) => item.connectionKey === metadata.connectionKey)
    assert.ok(entry)
    if (metadata.expectedBinding) assert.deepEqual(metadata.expectedBinding, {
      hubUrl: entry.hubUrl, clientAppId: entry.clientAppId, workspace: entry.workspace, sessionId: entry.sessionId,
    })
    return entry
  }
  const toolFor = (targetKey) => {
    const key = options.identicalTools ? A : targetKey
    return {
    name: 'record_update', description: key === A ? 'Update a cashier record note.' : 'Update a CRM lifecycle stage.',
    input_schema: { type: 'object', properties: { record_id: { type: 'string' },
      [key === A ? 'note' : 'stage']: { type: 'string' } }, required: ['record_id', key === A ? 'note' : 'stage'], additionalProperties: false },
    scope: key === A ? 'cashier.record.write' : 'crm.record.write', risk: 'medium', approval_required: true, readonly: false, idempotent: false,
    }
  }
  const result = (input, key) => ({
    schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocationId,
    route: target({ connectionKey: key }).workspace, tool: input.tool, state: backend.pending ? 'awaiting_approval' : 'executed',
    ok: !backend.pending, auto_retry_allowed: false, text: `${key === A ? 'CASHIER' : 'CRM'}_ONLY_RESULT`,
  })
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: C, connections: structuredClone(backend.entries) }),
    status: async (metadata) => {
      await options.beforeStatus?.(metadata, backend)
      if (backend.offline) throw new Error('synthetic connection timeout')
      const entry = target(metadata)
      return { state: entry.state, connectionKey: entry.connectionKey, workspace: entry.workspace, sessionId: entry.sessionId }
    },
    getConversationArchiveCapabilities: async ({ members }) => {
      assert.deepEqual(members.map((item) => item.connectionKey), [A, B])
      for (const member of members) target({ connectionKey: member.connectionKey, expectedBinding: {
        hubUrl: member.hubUrl, clientAppId: member.clientAppId, workspace: member.workspace, sessionId: member.expectedSessionId,
      } })
      if (backend.offline) throw new Error('synthetic offline')
      return { ...CAPABILITY, cross_binding_members: backend.supported }
    },
    startTurn: async (input, metadata) => {
      const entry = target(metadata)
      assert.equal(metadata.workspace, entry.workspace)
      assert.ok(metadata.expectedBinding, 'cross-system calls carry the original complete binding')
      const runId = uuid(++backend.count)
      const response = turnResponse({ runId, tools: [toolFor(entry.connectionKey)], capabilityRevision: (entry.connectionKey === A ? 'a' : 'b').repeat(64) })
      response.context.memory = [{ fact: entry.connectionKey === A ? 'CASHIER_ONLY_MEMORY' : 'CRM_ONLY_MEMORY' }]
      response.context.knowledge = []
      backend.runs.set(runId, { key: entry.connectionKey, input: structuredClone(input), response })
      await options.beforeStartReturn?.(input, metadata, backend)
      return response
    },
    searchCapabilities: async (input, metadata) => {
      const entry = target(metadata)
      assert.equal(backend.runs.get(input.runId)?.key, entry.connectionKey)
      const response = backend.runs.get(input.runId).response
      response.capability_revision = (entry.connectionKey === A ? 'c' : 'd').repeat(64)
      return { schema: 'bailing.agent-capability-search.v1', capability_revision: response.capability_revision, tools: [toolFor(entry.connectionKey)] }
    },
    invoke: async (input, metadata) => {
      const entry = target(metadata)
      const run = backend.runs.get(input.agentRunId)
      assert.equal(run?.key, entry.connectionKey)
      assert.equal(input.capabilityRevision, run.response.capability_revision)
      assert.equal(input.tool, 'record_update', 'only the original capability name reaches the server')
      assert.equal(Object.hasOwn(input.arguments, 'authorization_ref'), false)
      backend.invocations.set(input.invocationId, { input: structuredClone(input), key: entry.connectionKey })
      return result(input, entry.connectionKey)
    },
    resume: async (invocationId, input, metadata) => {
      const entry = target(metadata)
      const original = backend.invocations.get(invocationId)
      assert.equal(original?.key, entry.connectionKey)
      assert.deepEqual(input, {})
      return result(original.input, entry.connectionKey)
    },
    completeRun: async (runId, input, metadata) => {
      const entry = target(metadata)
      assert.equal(backend.runs.get(runId)?.key, entry.connectionKey)
      return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status }
    },
    syncConversationArchive: async (input, { members }) => {
      for (const member of members) target({ connectionKey: member.connectionKey, expectedBinding: {
        hubUrl: member.hubUrl, clientAppId: member.clientAppId, workspace: member.workspace, sessionId: member.expectedSessionId,
      } })
      if (backend.offline) throw new Error('synthetic offline')
      backend.archiveId ??= input.clientArchiveId
      assert.equal(input.clientArchiveId, backend.archiveId)
      for (const event of input.events) {
        if (backend.received.has(event.sequence)) assert.deepEqual(event, backend.received.get(event.sequence))
        else backend.received.set(event.sequence, structuredClone(event))
      }
      if (backend.loseAck) throw new Error('synthetic acknowledgement loss after commit')
      return { schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: uuid(999), last_sequence: backend.received.size }
    },
  })
  if (options.oldSdk) delete mock.transport.getConversationArchiveCapabilities
  createAgentClientPlugin({ transport: mock.transport, scopeStore, archiveStore,
    recovery: { maxAttempts: 1, maxWaitMilliseconds: 1000, pollIntervalMilliseconds: 1, sleep: async () => {} },
  }).apply(host.ctx, config)
  host.emit('session/created', client.agent.session)
  t.after(() => host.dispose())
  const runtime = host.services.get('bailingHubAgentClient')
  return { ...client, host, runtime, mock, backend, scopeStore, archiveStore, session: client.agent.session }
}

const exec = (f, callId) => ({ agent: f.agent, callId, signal: new AbortController().signal })
const assemble = (f) => f.host.waterfall('system-prompt/assemble', baseAssembly(), exec(f, 'assembly'), async () => baseAssembly())
function emit(f, type, data) {
  const event = f.session.append(type, data, ['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : undefined)
  f.host.emit('session/event', f.session, event)
}
async function begin(f, turn = 1) {
  const message = userMessage(`user-${turn}`, 'PRIVATE_INPUT_FOR_LOCAL_ONLY: use the selected cashier and CRM as needed.')
  emit(f, 'turn/start', { turn }); emit(f, 'user/message', message)
  f.host.emit('agent/inbox/claimed', { agent: f.agent, message, turn })
  return assemble(f)
}
async function select(f) {
  const view = await f.runtime.setSessionScope(f.session.id, { connectionKeys: [A, B] })
  assert.equal(view.targetMode, 'multi_system')
  return Object.fromEntries(view.authorizations.map((item) => [item.connectionKey, item.authorizationRef]))
}
async function search(f, ref, query = 'Find the permitted record update capability') {
  return f.local.get('search_business_capabilities').execute({ authorization_ref: ref, query }, exec(f, `search-${ref}`))
}
function typed(f, ref) { return [...f.local.values()].find((tool) => tool.name.startsWith('bh_') && tool.parameters.properties.authorization_ref.enum.includes(ref)) }
async function finish(f, turn = 1) {
  emit(f, 'assistant/message', { turn, message: { id: `answer-${turn}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'synthetic' }, content: [{ type: 'text', text: 'COMBINED_VISIBLE_REPLY' }] } })
  emit(f, 'turn/end', { turn, reason: { kind: 'completed' } })
  await f.runtime.syncSessionArchive(f.session.id)
  await new Promise((resolve) => setImmediate(resolve))
}

test('real Session exposes a target directory without broadcasting input or loading another system', async (t) => {
  const f = fixture(t); const refs = await select(f); const initial = await begin(f)
  assert.equal(f.mock.calls.filter((call) => BUSINESS.has(call.method)).length, 0)
  assert.doesNotMatch(JSON.stringify(initial), /CASHIER_ONLY_MEMORY|CRM_ONLY_MEMORY|conn_[a-f0-9]{32}|hub\.example\.com/)
  assert.match(JSON.stringify(initial), /not_loaded|sys_/)
  await assert.rejects(f.local.get('search_business_capabilities').execute({ query: 'all systems' }, exec(f, 'implicit')))
  await assert.rejects(search(f, 'unknown-target'))
  await search(f, refs[A], 'Update the cashier record note')
  const calls = f.mock.calls.filter((call) => BUSINESS.has(call.method))
  assert.deepEqual(calls.map((call) => call.args[1].connectionKey), [A, A])
  assert.equal(calls[0].args[0].userInput, 'Update the cashier record note')
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_INPUT_FOR_LOCAL_ONLY|CRM_ONLY/)
  const loaded = await assemble(f)
  assert.match(JSON.stringify(loaded), /CASHIER_ONLY_MEMORY/)
  assert.doesNotMatch(JSON.stringify(loaded), /CRM_ONLY_MEMORY/)
  await finish(f)
  for (const call of callsFor(f.mock.calls, 'completeRun')) assert.equal(call.args[2].connectionKey, A)
  assert.match(JSON.stringify([...f.backend.received.values()]), /PRIVATE_INPUT_FOR_LOCAL_ONLY|COMBINED_VISIBLE_REPLY/)
})

test('same named capabilities stay separate and A/B calls retain target, original name, revision and replay identity', async (t) => {
  const f = fixture(t); const refs = await select(f); await begin(f)
  await search(f, refs[A]); const oldA = typed(f, refs[A])
  await search(f, refs[B]); const a = typed(f, refs[A]); const b = typed(f, refs[B])
  assert.equal(a.name, oldA.name); assert.notEqual(a.name, b.name)
  assert.deepEqual(a.parameters.properties.authorization_ref.enum, [refs[A]])
  assert.deepEqual(b.parameters.properties.authorization_ref.enum, [refs[B]])
  const argsA = { authorization_ref: refs[A], arguments: { record_id: 'cashier-42', note: 'synthetic note' } }
  const resultA = await a.execute(argsA, exec(f, 'call-a'))
  const resultB = await b.execute({ authorization_ref: refs[B], arguments: { record_id: 'crm-42', stage: 'new' } }, exec(f, 'call-b'))
  assert.notEqual(resultA.system_ref, resultB.system_ref)
  await a.execute(argsA, exec(f, 'call-a'))
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 2)
  await assert.rejects(b.execute({ authorization_ref: refs[B], arguments: argsA.arguments }, exec(f, 'call-a')))
  await assert.rejects(a.execute({ authorization_ref: refs[B], arguments: argsA.arguments }, exec(f, 'wrong-target')))
  await assert.rejects(a.execute({ ...argsA, arguments: { ...argsA.arguments, note: 'changed' } }, exec(f, 'call-a')))
  await finish(f)
  for (const call of callsFor(f.mock.calls, 'completeRun')) {
    const text = JSON.stringify(call.args[1])
    assert.doesNotMatch(text, /COMBINED_VISIBLE_REPLY/)
    assert.doesNotMatch(text, call.args[2].connectionKey === A ? /CRM_ONLY_RESULT/ : /CASHIER_ONLY_RESULT/)
  }
})

test('identical schemas in two business systems still have different aliases and target sets', async (t) => {
  const f = fixture(t, { identicalTools: true }); const refs = await select(f); await begin(f)
  await search(f, refs[A]); await search(f, refs[B])
  const a = typed(f, refs[A]); const b = typed(f, refs[B])
  assert.notEqual(a.name, b.name)
  assert.deepEqual(a.parameters.properties.arguments, b.parameters.properties.arguments)
  assert.deepEqual(a.parameters.properties.authorization_ref.enum, [refs[A]])
  assert.deepEqual(b.parameters.properties.authorization_ref.enum, [refs[B]])
})

test('ending a turn aborts its business dispatch signal but still permits original completion and archive upload', async (t) => {
  const f = fixture(t); const refs = await select(f); await begin(f); await search(f, refs[A])
  const startSignal = callsFor(f.mock.calls, 'startTurn')[0].args[1].signal
  assert.equal(startSignal.aborted, false)
  await finish(f)
  assert.equal(startSignal.aborted, true)
  for (const call of callsFor(f.mock.calls, 'completeRun')) assert.equal(call.args[2].signal?.aborted ?? false, false)
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'synced')
})

test('an unactivated selected member revocation blocks all writes while temporary offline verification remains retryable', async (t) => {
  const f = fixture(t); const refs = await select(f); await begin(f); await search(f, refs[A])
  const a = typed(f, refs[A]); const input = { authorization_ref: refs[A], arguments: { record_id: '42', note: 'test' } }
  f.backend.offline = true
  await assert.rejects(a.execute(input, exec(f, 'offline')))
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  f.backend.offline = false
  assert.equal((await f.runtime.restoreSessionScope(f.session.id)).mode, 'business')
  await a.execute(input, exec(f, 'online'))
  f.backend.entries.find((entry) => entry.connectionKey === B).state = 'revoked'
  await assert.rejects(a.execute(input, exec(f, 'after-revoke')))
  assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'blocked')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
})

test('pending recovery in a later turn uses only the original target and invocation without replaying the write', async (t) => {
  const f = fixture(t); const refs = await select(f); await begin(f); await search(f, refs[A])
  f.backend.pending = true
  const pending = await typed(f, refs[A]).execute({ authorization_ref: refs[A], arguments: { record_id: '42', note: 'test' } }, exec(f, 'pending-write'))
  await finish(f); await begin(f, 2)
  await assert.rejects(f.local.get('resume_governed_tool_invocation').execute({ invocation_id: 'f'.repeat(64) }, exec(f, 'unknown')))
  f.backend.pending = false
  const recovered = await f.local.get('resume_governed_tool_invocation').execute({ invocation_id: pending.result.invocation_id }, exec(f, 'resume'))
  assert.equal(recovered.result.state, 'executed')
  assert.equal(recovered.authorization_ref, refs[A])
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.ok(callsFor(f.mock.calls, 'resume').every((call) => call.args[2].connectionKey === A))
  assert.ok(callsFor(f.mock.calls, 'startTurn').every((call) => call.args[1].connectionKey === A))
  await finish(f, 2)
})

test('cross-system file snapshots restore in the same offline-opened runtime and lost ACKs never replay business calls', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-cross-system-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stores = () => ({ scopeStore: createFileSessionScopeStore({ directory: join(directory, 'scope') }),
    archiveStore: createFileConversationArchiveStore({ directory: join(directory, 'archive') }) })
  const f = fixture(t, stores()); f.backend.loseAck = true
  const refs = await select(f); await begin(f); await search(f, refs[A])
  await typed(f, refs[A]).execute({ authorization_ref: refs[A], arguments: { record_id: '42', note: 'test' } }, exec(f, 'write'))
  await finish(f)
  // Quiesce the old process's event-driven upload before simulating its exit.
  await f.runtime.getSessionArchiveStatus(f.session.id)
  await f.runtime.conversationOutbox.entries.get(f.session.id)?.syncing
  await f.runtime.conversationOutbox.drain(f.session.id)
  const before = await f.archiveStore.load(f.session.id)
  assert.equal(before.schema, 'bailing.agent-conversation-outbox.v2')
  assert.equal((await f.scopeStore.load(f.session.id)).schema, 'bailing.agent-session-scope.v2')
  f.backend.offline = true
  const reopened = fixture(t, { ...stores(), backend: f.backend, session: Session.create(f.session.id, f.session.events) })
  for (let i = 0; i < 3; i++) {
    assert.equal((await reopened.runtime.restoreSessionScope(reopened.session.id)).mode, 'blocked')
    assert.equal((await reopened.runtime.syncSessionArchive(reopened.session.id)).state, 'blocked')
    assert.deepEqual(await reopened.archiveStore.load(reopened.session.id), before)
  }
  f.backend.offline = false; f.backend.loseAck = false
  assert.equal((await reopened.runtime.restoreSessionScope(reopened.session.id)).mode, 'business')
  assert.equal((await reopened.runtime.syncSessionArchive(reopened.session.id)).state, 'synced')
  const after = await reopened.archiveStore.load(reopened.session.id)
  assert.deepEqual(after.events, before.events); assert.deepEqual(after.context, before.context)
  assert.equal(after.clientArchiveId, before.clientArchiveId)
  assert.equal(after.acknowledged, after.events.length)
  assert.equal(f.backend.invocations.size, 1)
  assert.equal(reopened.mock.calls.filter((call) => BUSINESS.has(call.method)).length, 0)
})

test('cancelled late start cannot load another target, reactivate tools or overwrite the next turn', async (t) => {
  let release; let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  let once = true
  const f = fixture(t, { beforeStartReturn: async () => { if (once) { once = false; entered(); await wait } } })
  const refs = await select(f); await begin(f)
  const late = search(f, refs[A]); await enteredPromise
  emit(f, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } })
  await begin(f, 2); release()
  await assert.rejects(late)
  assert.equal([...f.local.keys()].filter((name) => name.startsWith('bh_')).length, 0)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 0)
  await search(f, refs[B], 'Find the CRM stage update')
  assert.ok(typed(f, refs[B])); assert.equal(typed(f, refs[A]), undefined)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  await finish(f, 2)
  assert.equal([...f.backend.received.values()].filter((event) => event.kind === 'run_link').length, 2)
})

test('old SDK or Core explicitly refuses cross-system scope while empty and same-system scopes still work', async (t) => {
  for (const oldSdk of [true, false]) {
    const f = fixture(t, { oldSdk }); if (!oldSdk) f.backend.supported = false
    await assert.rejects(select(f), { code: 'CROSS_SYSTEM_SCOPE_UNSUPPORTED' })
    assert.equal((await f.runtime.getSessionScope(f.session.id)).reason, 'CROSS_SYSTEM_SCOPE_UNSUPPORTED')
    assert.equal((await f.runtime.getSessionArchiveStatus(f.session.id)).state, 'unsupported')
    const selected = await f.runtime.setSessionScope(f.session.id, { connectionKeys: [A] })
    assert.equal(selected.mode, 'business')
    assert.equal(f.mock.calls.filter((call) => BUSINESS.has(call.method)).length, 0)
  }
  const empty = fixture(t); await empty.runtime.setSessionScope(empty.session.id, { connectionKeys: [] }); await begin(empty)
  assert.deepEqual(empty.mock.calls, [])
})

test('cross Hub, duplicate Sessions and changed original bindings never adopt a default or surviving subset', async (t) => {
  const foreign = fixture(t); foreign.backend.entries[1].hubUrl = 'https://other.example.com'
  await assert.rejects(select(foreign), { code: 'CROSS_HUB_SCOPE_UNSUPPORTED' })
  assert.equal(callsFor(foreign.mock.calls, 'status').length, 0)
  const duplicate = fixture(t); duplicate.backend.entries[1].sessionId = duplicate.backend.entries[0].sessionId
  await assert.rejects(select(duplicate))
  for (const field of ['hubUrl', 'clientAppId', 'workspace', 'sessionId']) {
    const f = fixture(t); await select(f); await begin(f)
    f.backend.entries[1][field] = { hubUrl: 'https://other.example.com', clientAppId: 'replacement', workspace: 'replacement', sessionId: uuid(888) }[field]
    assert.equal((await f.runtime.restoreSessionScope(f.session.id)).mode, 'blocked')
    assert.equal(f.mock.calls.filter((call) => BUSINESS.has(call.method)).length, 0)
  }
})

test('cross-system local write gaps remain visible when capability availability later becomes unsupported', async (t) => {
  const memory = createMemoryConversationArchiveStore()
  const archiveStore = { load: (...args) => memory.load(...args), save: async (id, record, revision) => {
    if (record.events.some(({ event }) => event.kind === 'assistant_message')) throw new Error('synthetic final-message disk failure')
    return memory.save(id, record, revision)
  } }
  const f = fixture(t, { archiveStore }); await select(f); await begin(f); await finish(f)
  const failed = await f.runtime.getSessionArchiveStatus(f.session.id)
  assert.ok(['storage_error', 'recovery_gap'].includes(failed.state))
  assert.ok(failed.unsavedEvents > 0)
  f.backend.supported = false
  const unavailable = await f.runtime.getSessionArchiveStatus(f.session.id)
  assert.ok(['storage_error', 'recovery_gap'].includes(unavailable.state))
  assert.equal(unavailable.availability, 'unsupported')
})

test('failed first replacement write cannot restore a saved v2 draft as already confirmed', async (t) => {
  const memory = createMemorySessionScopeStore(); let fail = false
  const scopeStore = { load: (...args) => memory.load(...args), save: async (...args) => {
    if (fail) throw new Error('synthetic first replacement write failure')
    return memory.save(...args)
  } }
  const f = fixture(t, { scopeStore }); await select(f)
  assert.equal((await memory.load(f.session.id)).schema, 'bailing.agent-session-scope.v2')
  fail = true
  await assert.rejects(f.runtime.setSessionScope(f.session.id, { connectionKeys: [A] }))
  fail = false
  const reopened = fixture(t, { scopeStore: memory, backend: f.backend, session: Session.create(f.session.id, f.session.events) })
  const view = await reopened.runtime.restoreSessionScope(reopened.session.id)
  assert.equal(view.mode, 'blocked'); assert.equal(view.locked, false)
  assert.deepEqual(reopened.mock.calls, [])
  assert.equal((await reopened.runtime.setSessionScope(reopened.session.id, { connectionKeys: [A] })).mode, 'business')
})
