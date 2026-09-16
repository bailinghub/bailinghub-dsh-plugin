import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { BailingHubAgentClientRuntime, createMemorySessionScopeStore,
  createMemorySessionTaskStore, createMemoryInvocationStore, createMemoryConversationArchiveStore } from '../lib/index.js'

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const key = n => `conn_${String(n).repeat(32)}`
const config = { hubUrl: 'https://hub.example.com', clientAppId: 'shop_app', workspace: 'shop' }
const error = code => Object.assign(new Error('Synthetic read failure; do not project this text.'), { publicCode: code })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture({ sameSystem = false, stores: previous, session: original } = {}) {
  const calls = []
  const accounts = [1, 2, 3].map(n => ({ connectionKey: key(n), sessionId: uuid(n),
    ...config, ...(n === 2 && !sameSystem ? { clientAppId: 'inventory_app', workspace: 'inventory' } : {}),
    state: 'authorized', label: 'Display only', current: n === 3 }))
  const control = {}
  const stores = previous ?? { scopeStore: createMemorySessionScopeStore(), taskStore: createMemorySessionTaskStore(),
    invocationStore: createMemoryInvocationStore(), archiveStore: createMemoryConversationArchiveStore() }
  const taskId = uuid(90)
  const transport = {
    async connectionsList() { calls.push(['directory']); return { connections: accounts } },
    async status({ connectionKey }) {
      calls.push(['status', connectionKey])
      if (control.statusWait) await control.statusWait
      if (control.offline) throw error('agent_transport_unavailable')
      if (control.statusError) throw control.statusError
      return structuredClone(accounts.find(a => a.connectionKey === connectionKey))
    },
    async getConversationArchiveCapabilities({ members }) {
      calls.push(['archive_capabilities', members.map(m => m.connectionKey)])
      return { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
    },
    async getTaskControlCapabilities(options) {
      calls.push(['task_capabilities', options.connectionKey])
      if (control.capWait) await control.capWait
      if (control.capError) throw control.capError
      return { supported: control.supported !== false, mode: 'optional', inspect_invocation: true }
    },
    async inspectInvocation() { assert.fail('coordinate reads cannot inspect or resume business calls') },
    async getTask(id, options) {
      calls.push(['task', options.connectionKey])
      assert.equal(id, taskId)
      const member = accounts.find(a => a.connectionKey === options.connectionKey)
      return { schema_version: 'bailing.agent-task.v1', task_id: taskId, scope_hash: 'f'.repeat(64),
        state: control.taskState ?? 'active', revision: 1, ledger_sequence: 0, member_count: 2,
        metering: 'write_invocation', snapshot_is_dispatch_permission: false,
        member: { session_id: member.sessionId, client_app_id: member.clientAppId, workspace: member.workspace,
          client_conversation_id: options.clientConversationId, allowed_tools: ['product_query'] },
        policy: { max_write_calls: 2 }, counters: { write_consumed: 0 } }
    },
  }
  const runtime = new BailingHubAgentClientRuntime({}, config, async () => transport, {}, stores)
  const session = original ?? Session.create('coordinates-synthetic-session', [])
  runtime.observeSession(session)
  return { runtime, session, stores, accounts, calls, control, transport, taskId,
    select: (keys = [key(1), key(2)]) => runtime.setSessionScope(session.id, { connectionKeys: keys }),
    get: () => runtime.getSessionTaskCoordinates(session) }
}

function noCoordinates(value) {
  for (const field of ['sessionId', 'clientConversationId', 'scopeRevision', 'scopeLocked', 'members']) assert.equal(Object.hasOwn(value, field), false, field)
  assert.equal(value.snapshot_is_dispatch_permission, false)
}

for (const [name, keys, sameSystem] of [['single', [key(1)], false], ['same system', [key(1), key(2)], true], ['cross system', [key(1), key(2)], false]]) {
  test(`host coordinates project only original selected ${name} members without locking or writing`, async () => {
    const f = fixture({ sameSystem }); await f.select(keys)
    const before = await f.stores.scopeStore.load(f.session.id)
    const history = structuredClone(f.session.events)
    f.calls.length = 0
    const value = await f.get()
    assert.equal(value.schema, 'bailing.agent-session-task-coordinates.v1')
    assert.equal(value.state, 'ready', JSON.stringify(value))
    assert.equal(value.availability, 'supported')
    assert.equal(value.scopeLocked, false)
    assert.equal(value.scopeRevision, before.revision)
    assert.equal(value.snapshot_is_dispatch_permission, false)
    assert.deepEqual(value.members, keys.map((key, n) => ({ connectionKey: key, agentSessionId: uuid(n + 1),
      clientAppId: n === 1 && !sameSystem ? 'inventory_app' : 'shop_app', workspace: n === 1 && !sameSystem ? 'inventory' : 'shop' })))
    assert.deepEqual(await f.stores.scopeStore.load(f.session.id), before)
    for (const name of ['taskStore', 'invocationStore', 'archiveStore']) assert.equal(await f.stores[name].load(f.session.id), null)
    assert.deepEqual(f.session.events, history)
    assert.equal(JSON.stringify(value).includes('hub.example.com'), false)
    assert.equal(JSON.stringify(value).includes('Display only'), false)
    assert.equal(f.calls.some(call => call[1] === key(3)), false)
    assert.deepEqual(f.calls.filter(c => c[0] === 'status').map(c => c[1]), keys)
    value.members[0].agentSessionId = uuid(999)
    assert.equal((await f.get()).members[0].agentSessionId, uuid(1))
    await f.select([key(2)]) // Reading coordinates must not make a draft immutable.
    assert.equal((await f.get()).members[0].agentSessionId, uuid(2))
  })
}

test('empty, unselected and invalid session return no coordinates and make no Hub request', async () => {
  const f = fixture()
  let result = await f.get(); assert.equal(result.reason, 'SESSION_SCOPE_UNSELECTED'); noCoordinates(result)
  await f.select([]); result = await f.get(); assert.equal(result.reason, 'SESSION_SCOPE_CHAT_ONLY'); noCoordinates(result)
  assert.deepEqual(f.calls, [])
  result = await f.runtime.getSessionTaskCoordinates({ id: null })
  assert.equal(result.reason, 'INVALID_SESSION_ID'); noCoordinates(result)
})

test('bound task coordinates survive reopen without task mutations or storage revisions', async () => {
  const f = fixture(); await f.select(); await f.runtime.setSessionTaskBinding(f.session, { taskId: f.taskId })
  const before = await f.get(); assert.equal(before.state, 'ready', JSON.stringify(before))
  const scope = await f.stores.scopeStore.load(f.session.id), task = await f.stores.taskStore.load(f.session.id)
  const reopened = fixture({ stores: f.stores, session: Session.create(f.session.id, f.session.events) })
  reopened.control.taskState = 'cancelled'
  assert.deepEqual(await reopened.get(), before) // Coordinates are not an active-task grant.
  assert.deepEqual(await f.stores.scopeStore.load(f.session.id), scope)
  assert.deepEqual(await f.stores.taskStore.load(f.session.id), task)
  assert.deepEqual(await reopened.runtime.getSessionTaskCoordinates(f.session.id), before)
})

test('reopened unlocked draft needs explicit reconfirmation; projection cannot lock or guess it', async () => {
  const f = fixture(); await f.select()
  const reopened = fixture({ stores: f.stores })
  const value = await reopened.get(); assert.equal(value.state, 'blocked'); noCoordinates(value)
  assert.deepEqual(reopened.calls, [])
  await reopened.select([key(2)])
  assert.equal((await reopened.get()).state, 'ready')
  assert.equal((await reopened.stores.scopeStore.load(reopened.session.id)).locked, false)
})

test('offline reopen retries the whole original scope in the same runtime without rewriting coordinates', async () => {
  const f = fixture(); await f.select(); await f.runtime.setSessionTaskBinding(f.session, { taskId: f.taskId })
  const original = await f.get(), scope = await f.stores.scopeStore.load(f.session.id)
  const reopened = fixture({ stores: f.stores })
  reopened.control.offline = true
  for (let i = 0; i < 3; i++) {
    const value = await reopened.get(); assert.equal(value.state, 'unavailable'); assert.equal(value.reason, 'agent_transport_unavailable'); noCoordinates(value)
  }
  reopened.control.offline = false; reopened.calls.length = 0
  assert.deepEqual(await reopened.get(), original)
  assert.deepEqual(reopened.calls.filter(c => c[0] === 'status').map(c => c[1]), [key(1), key(2)])
  assert.deepEqual(await reopened.stores.scopeStore.load(reopened.session.id), scope)
})

for (const change of ['revoked', 'identity', 'binding']) test(`a ${change} original member blocks the entire coordinate projection`, async () => {
  const f = fixture(); await f.select()
  if (change === 'revoked') f.accounts[1].state = 'revoked'
  else if (change === 'identity') f.accounts[1].sessionId = uuid(999)
  else f.accounts[1].workspace = 'elsewhere'
  const result = await f.get(); assert.equal(result.state, 'blocked'); assert.equal(result.reason, 'AUTHORIZATION_CHANGED'); noCoordinates(result)
  const next = await f.get(); assert.equal(next.state, 'blocked'); noCoordinates(next)
  assert.equal(f.calls.some(call => call[1] === key(3)), false)
})

for (const kind of ['sdk', 'core']) test(`old ${kind} is explicitly unsupported without breaking selected business scope`, async () => {
  const f = fixture(); await f.select([key(1)])
  if (kind === 'sdk') delete f.transport.getTaskControlCapabilities
  else f.control.supported = false
  const result = await f.get(); assert.equal(result.state, 'unsupported'); assert.equal(result.reason, 'TASK_UNSUPPORTED'); noCoordinates(result)
  const scope = await f.runtime.getSessionScope(f.session.id)
  assert.equal(scope.mode, 'business'); assert.equal(scope.locked, false)
})

test('temporary task negotiation failure is retryable and not unsupported', async () => {
  const f = fixture(); await f.select()
  f.control.capError = error('TASK_UNAVAILABLE')
  const value = await f.get(); assert.equal(value.state, 'unavailable'); assert.equal(value.feedback.retryable, true); noCoordinates(value)
  delete f.control.capError; assert.equal((await f.get()).state, 'ready')
})

test('selection changed during awaited negotiation returns conflict, never mixed or old coordinates', async () => {
  const f = fixture(); await f.select()
  const gate = deferred(); f.control.capWait = gate.promise
  const pending = f.get()
  while (!f.calls.some(c => c[0] === 'task_capabilities')) await new Promise(done => setImmediate(done))
  await f.select([key(2)])
  gate.resolve()
  const value = await pending; assert.equal(value.reason, 'SESSION_SCOPE_CONFLICT'); noCoordinates(value)
  delete f.control.capWait; const current = await f.get()
  assert.equal(current.members.length, 1); assert.equal(current.members[0].agentSessionId, uuid(2))
})

test('external scope CAS change during network validation is classified and coordinates stay absent', async () => {
  const f = fixture(); await f.select()
  const gate = deferred(); f.control.capWait = gate.promise
  const pending = f.get()
  while (!f.calls.some(c => c[0] === 'task_capabilities')) await new Promise(done => setImmediate(done))
  const scope = await f.stores.scopeStore.load(f.session.id)
  await f.stores.scopeStore.save(f.session.id, { ...scope, revision: scope.revision + 1 }, scope.revision)
  gate.resolve()
  const value = await pending; assert.equal(value.reason, 'SESSION_SCOPE_CONFLICT'); noCoordinates(value)
})

for (const field of ['scopeStore', 'taskStore']) test(`${field} read failure is storage_error, never ready or ordinary offline`, async () => {
  const f = fixture(); await f.select()
  f.stores[field].load = async () => { throw new Error('Private storage detail must not be returned') }
  const value = await f.get(); assert.equal(value.state, 'storage_error'); noCoordinates(value)
  assert.equal(value.reason, field === 'scopeStore' ? 'SCOPE_STORE_UNAVAILABLE' : 'TASK_STORE_UNAVAILABLE')
  assert.equal(JSON.stringify(value).includes('Private'), false)
})

test('known unsaved session events remain primary and avoid all remote probes', async () => {
  const f = fixture(); await f.select()
  const session = { id: f.session.id, events: [], unsavedEvents: [{ type: 'assistant/message' }] }
  f.calls.length = 0; f.control.offline = true
  const result = await f.runtime.getSessionTaskCoordinates(session)
  assert.equal(result.state, 'storage_error'); assert.equal(result.reason, 'SESSION_LOCAL_STORAGE_ERROR'); noCoordinates(result)
  assert.deepEqual(f.calls, [])
})

test('late local persistence failure overrides a successful network projection', async () => {
  const f = fixture(); await f.select()
  const session = { id: f.session.id, events: [], unsavedEvents: [] }
  const gate = deferred(); f.control.capWait = gate.promise
  const pending = f.runtime.getSessionTaskCoordinates(session)
  while (!f.calls.some(c => c[0] === 'task_capabilities')) await new Promise(done => setImmediate(done))
  session.unsavedEvents.push({ type: 'assistant/message' }); gate.resolve()
  const result = await pending; assert.equal(result.state, 'storage_error'); noCoordinates(result)
})

for (const statusCode of [429, 503, 401, 403]) test(`SDK-shaped identity HTTP ${statusCode} preserves temporary versus revoked semantics`, async () => {
  const f = fixture(); await f.select()
  f.control.statusError = Object.assign(error('unknown_failure'), { name: 'AgentAuthHttpError', statusCode, retryable: statusCode >= 429 })
  const result = await f.get(); noCoordinates(result)
  assert.equal(result.state, statusCode >= 429 ? 'unavailable' : 'blocked')
  assert.equal(result.reason, statusCode >= 429 ? 'agent_transport_unavailable' : 'AUTHORIZATION_CHANGED')
  delete f.control.statusError
  assert.equal((await f.get()).state, statusCode >= 429 ? 'ready' : 'blocked')
})

test('incomplete visible archive remains recovery_gap instead of returning usable coordinates', async () => {
  const f = fixture(); await f.select()
  f.session.append('turn/start', { turn: 1 })
  f.calls.length = 0
  const result = await f.get(); assert.equal(result.state, 'recovery_gap'); noCoordinates(result)
  assert.deepEqual(f.calls, [])
})

test('scope replacement while identity validation waits cannot return stale coordinates', async () => {
  const f = fixture(); await f.select()
  const gate = deferred(); f.control.statusWait = gate.promise
  f.calls.length = 0
  const pending = f.get()
  while (!f.calls.some(c => c[0] === 'status')) await new Promise(done => setImmediate(done))
  delete f.control.statusWait
  await f.select([key(2)])
  gate.resolve()
  const value = await pending; assert.equal(value.reason, 'SESSION_SCOPE_CONFLICT'); noCoordinates(value)
  assert.equal((await f.get()).members[0].agentSessionId, uuid(2))
})

test('task store CAS conflict stays distinct from unavailable storage', async () => {
  const f = fixture(); await f.select()
  f.stores.taskStore.load = async () => { throw Object.assign(new Error('Synthetic CAS conflict'), { code: 'TASK_STORE_CONFLICT' }) }
  const value = await f.get(); assert.equal(value.state, 'storage_error'); assert.equal(value.reason, 'TASK_STORE_CONFLICT'); noCoordinates(value)
})

test('missing or corrupt original scope is not reconstructed from task metadata', async () => {
  const f = fixture(); await f.select(); await f.runtime.setSessionTaskBinding(f.session, { taskId: f.taskId })
  for (const value of [null, { revision: 99 }]) {
    const reopened = fixture({ stores: { ...f.stores, scopeStore: { load: async () => value, save: async () => assert.fail('must not reconstruct') } } })
    const result = await reopened.get(); noCoordinates(result)
    assert.notEqual(result.state, 'ready')
    assert.deepEqual(reopened.calls, [])
  }
})

test('same-system aliases cannot duplicate one original Agent Session as task members', async () => {
  const f = fixture({ sameSystem: true }); f.accounts[1].sessionId = f.accounts[0].sessionId
  await f.select()
  const value = await f.get(); assert.equal(value.reason, 'TASK_MEMBER_MISMATCH'); noCoordinates(value)
})

test('a late visible-history gap cannot replace a detected persistent storage error', async () => {
  const f = fixture(); await f.select()
  f.stores.taskStore.load = async () => {
    f.session.append('turn/start', { turn: 1 })
    throw Object.assign(new Error('Synthetic storage failure'), { code: 'TASK_STORE_CONFLICT' })
  }
  const value = await f.get(); assert.equal(value.state, 'storage_error'); assert.equal(value.reason, 'TASK_STORE_CONFLICT'); noCoordinates(value)
})
