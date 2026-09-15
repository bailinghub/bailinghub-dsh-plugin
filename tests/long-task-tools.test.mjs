import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin } from '../lib/index.js'
import { callsFor, createMemorySessionScopeStore, createMockTransport, turnResponse, userMessage } from './helpers/mock-host.mjs'

const keys = [1, 2, 3].map(n => `conn_${String(n).repeat(32)}`)
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = letter => letter.repeat(64)
const tool = (name, overrides = {}) => ({
  name, description: `Use the synthetic ${name} capability.`,
  input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, additionalProperties: false },
  scope: 'product.manage', risk: 'medium', approval_required: true, readonly: false, idempotent: false,
  ...overrides,
})
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const nextTick = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t, { cross = false, selected = 1 } = {}) {
  const ctx = new Context()
  const entries = keys.map((connectionKey, index) => ({
    connectionKey, hubUrl: 'https://hub.example.com',
    clientAppId: cross && index === 1 ? 'inventory_app' : 'shop_app',
    workspace: cross && index === 1 ? 'inventory' : 'shop',
    connectionName: `Synthetic account ${index + 1}`, sessionId: uuid(index + 1),
    state: 'authorized', current: index === 2,
  }))
  const backend = {
    pages: new Map(), revisions: new Map(keys.map(key => [key, revision('a')])),
    runs: new Map(), invocations: new Map(), runCounter: 100, pending: false, loseConfirmation: false,
    beforeSearchReturn: undefined,
  }
  const target = options => {
    assert.ok(keys.slice(0, selected).includes(options.connectionKey), 'unselected/default C receives no target request')
    const entry = entries.find(value => value.connectionKey === options.connectionKey)
    if (options.expectedBinding) assert.deepEqual(options.expectedBinding, {
      hubUrl: entry.hubUrl, clientAppId: entry.clientAppId, workspace: entry.workspace, sessionId: entry.sessionId,
    })
    return entry
  }
  const invocationResult = (id, original) => ({
    schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: id,
    route: entries.find(entry => entry.connectionKey === original.key).workspace, tool: original.input.tool,
    state: backend.pending ? 'awaiting_approval' : 'executed', ok: !backend.pending,
    auto_retry_allowed: false, text: 'Synthetic business result.',
  })
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: keys[2], connections: structuredClone(entries) }),
    status: async options => {
      const entry = target(options)
      return { state: entry.state, connectionKey: entry.connectionKey, workspace: entry.workspace, sessionId: entry.sessionId }
    },
    getConversationArchiveCapabilities: async ({ members }) => {
      assert.deepEqual(members.map(entry => entry.connectionKey), keys.slice(0, selected))
      return { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
    },
    startTurn: async (input, options) => {
      const entry = target(options)
      const runId = uuid(++backend.runCounter)
      backend.runs.set(runId, { key: entry.connectionKey, input: structuredClone(input) })
      return turnResponse({ runId, tools: [], capabilityRevision: backend.revisions.get(entry.connectionKey) })
    },
    searchCapabilities: async (input, options) => {
      const entry = target(options)
      assert.equal(backend.runs.get(input.runId)?.key, entry.connectionKey)
      const result = { schema: 'bailing.agent-capability-search.v1',
        capability_revision: backend.revisions.get(entry.connectionKey),
        tools: structuredClone(backend.pages.get(`${entry.connectionKey}:${input.query}`) ?? []) }
      await backend.beforeSearchReturn?.(input, options)
      return result
    },
    invoke: async (input, options) => {
      const entry = target(options)
      assert.equal(backend.runs.get(input.agentRunId)?.key, entry.connectionKey)
      assert.equal(input.capabilityRevision, backend.revisions.get(entry.connectionKey))
      assert.equal(backend.invocations.has(input.invocationId), false, 'business invocation is never dispatched twice')
      const original = { key: entry.connectionKey, input: structuredClone(input) }
      backend.invocations.set(input.invocationId, original)
      if (backend.loseConfirmation) throw new Error('synthetic response loss after dispatch')
      return invocationResult(input.invocationId, original)
    },
    resume: async (id, input, options) => {
      const entry = target(options)
      const original = backend.invocations.get(id)
      assert.equal(original?.key, entry.connectionKey)
      assert.deepEqual(input, {})
      return invocationResult(id, original)
    },
    completeRun: async (runId, input, options) => {
      const entry = target(options)
      assert.equal(backend.runs.get(runId)?.key, entry.connectionKey)
      return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status }
    },
  })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(CommandRuntime, {})
  await ctx.plugin(createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore(),
    recovery: { maxAttempts: 1, maxWaitMilliseconds: 100, pollIntervalMilliseconds: 1, sleep: async () => {} },
  }), { ...entries[0] })
  const runtime = ctx.get('bailingHubAgentClient')
  const session = Session.create(`long-tools-${cross}-${selected}`, [])
  const agent = { id: session.id, session }
  const scope = createScope(runtime.ctx, agent)
  agent.ctx = scope.ctx
  runtime.observeSession(session)
  const selectedScope = await runtime.setSessionScope(session.id, { connectionKeys: keys.slice(0, selected) })
  const refs = Object.fromEntries(selectedScope.authorizations.map(entry => [entry.connectionKey, entry.authorizationRef]))
  const message = userMessage('synthetic-user', 'Add products, check inventory, and continue adding products.')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  runtime.onInboxClaimed({ agent, turn: 1, message })
  const assemble = () => ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
  await assemble()
  t.after(async () => { await scope.dispose(); await ctx.fiber.dispose() })
  let counter = 0
  const execute = (name, args = {}, callId = `synthetic-call-${++counter}`, signal = new AbortController().signal) =>
    agent.ctx.tools.execute({ name, arguments: args, callId, agent, signal })
  const search = (query, key = keys[0], signal) => execute('search_business_capabilities', {
    query, ...(selected > 1 ? { authorization_ref: refs[key] } : {}),
  }, `search-${++counter}`, signal)
  const business = (name, key = keys[0], callId, args = { product_id: 'synthetic-product' }) => execute(name,
    selected > 1 ? { authorization_ref: refs[key], arguments: args } : args, callId)
  const page = (query, definitions, key = keys[0]) => backend.pages.set(`${key}:${query}`, definitions)
  const end = reason => {
    const event = session.append('turn/end', { turn: 1, reason: { kind: reason } })
    runtime.onSessionEvent(session, event)
  }
  const state = () => runtime.getSessionToolState(session.id)
  const nameFor = (result, original, key = keys[0]) => result.active_tools.find(entry =>
    (entry.original_name ?? entry.name) === original && (!entry.authorization_refs || entry.authorization_refs.includes(refs[key])))?.name
  return { ctx, runtime, session, agent, entries, refs, backend, mock, execute, search, business, page, end, state, assemble, nameFor }
}

test('long task adds, queries, then adds again without another discovery or losing the original tool', async t => {
  const f = await fixture(t)
  f.page('add', [tool('product_add')]); f.page('query', [tool('product_query', { readonly: true })])
  assert.equal((await f.search('add')).isError, false)
  assert.equal((await f.business('product_add', keys[0], 'first-add')).isError, false)
  const query = await f.search('query')
  assert.equal(query.isError, false)
  assert.equal(query.value.candidate_update, 'merge')
  assert.deepEqual(new Set(query.value.active_tools.map(entry => entry.name)), new Set(['product_add', 'product_query']))
  assert.equal((await f.business('product_query')).isError, false)
  assert.equal((await f.business('product_add', keys[0], 'second-add')).isError, false)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
  assert.deepEqual(callsFor(f.mock.calls, 'invoke').map(call => call.args[0].tool), ['product_add', 'product_query', 'product_add'])
})

test('same-system A/B retain shared declarations while each call keeps the explicit original account', async t => {
  const f = await fixture(t, { selected: 2 })
  for (const key of keys.slice(0, 2)) { f.page('add', [tool('product_add')], key); f.page('query', [tool('product_query')], key) }
  await f.search('add', keys[0]); const initial = await f.search('add', keys[1])
  assert.deepEqual(new Set(initial.value.active_tools.find(entry => entry.name === 'product_add').authorization_refs), new Set(Object.values(f.refs)))
  await f.business('product_add', keys[0], 'add-A')
  await f.search('query', keys[1])
  assert.equal((await f.business('product_query', keys[1], 'query-B')).isError, false)
  assert.equal((await f.business('product_add', keys[1], 'add-B')).isError, false)
  assert.equal((await f.business('product_add', keys[0], 'add-A-again')).isError, false)
  assert.deepEqual(callsFor(f.mock.calls, 'invoke').map(call => call.args[1].connectionKey), [keys[0], keys[1], keys[1], keys[0]])
})

test('cross-system same-name tools remain isolated while alternating targets retains both tools', async t => {
  const f = await fixture(t, { cross: true, selected: 2 })
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  f.page('update', [tool('product_update', { description: 'Update a synthetic shop product.' })])
  f.page('update', [tool('product_update', { description: 'Update a synthetic inventory record.' })], keys[1])
  const a = await f.search('update'); const aName = f.nameFor(a.value, 'product_update')
  const b = await f.search('update', keys[1]); const bName = f.nameFor(b.value, 'product_update', keys[1])
  assert.ok(aName); assert.ok(bName); assert.notEqual(aName, bName)
  for (const [name, key] of [[aName, keys[0]], [bName, keys[1]], [aName, keys[0]]]) {
    assert.equal((await f.business(name, key)).isError, false)
  }
  assert.equal((await f.business(aName, keys[1])).isError, true, 'same-name capability cannot be moved to another system')
  assert.deepEqual(callsFor(f.mock.calls, 'invoke').map(call => call.args[1].connectionKey), [keys[0], keys[1], keys[0]])
  assert.ok(callsFor(f.mock.calls, 'invoke').every(call => call.args[0].tool === 'product_update'))
})

test('the 12-schema model window does not unload retained tools or inflate capability totals', async t => {
  const f = await fixture(t)
  for (let group = 0; group < 2; group++) f.page(`group-${group}`, Array.from({ length: 12 }, (_, index) => tool(`product_${group}_${index}`)))
  await f.search('group-0'); const next = await f.search('group-1')
  assert.equal(next.value.active_tools.length, 24)
  assert.equal(next.value.toolset.active_count, 24)
  assert.equal(next.value.toolset.limit, 64)
  assert.equal(next.value.toolset.visible_count, 12)
  assert.equal(next.value.toolset.visible_limit, 12)
  assert.equal(next.value.visible_tools.length, 12)
  assert.equal(next.value.discovery.returned_count, 12)
  assert.equal(next.value.discovery.authorized_total, null)
  const hidden = next.value.active_tools.find(entry => !next.value.visible_tools.some(visible => visible.name === entry.name))
  assert.ok(hidden)
  const assembly = await f.assemble()
  assert.equal(assembly.tools.filter(entry => entry.name.startsWith('product_')).length, 12)
  assert.equal(assembly.tools.some(entry => entry.name === hidden.name), false)
  assert.ok(f.agent.ctx.tools.get(hidden.name, f.agent), 'retained handle stays in the native host registry')
  assert.equal((await f.business(hidden.name)).isError, false)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
})

test('a changed target revision invalidates that target only, preserving another target and its run', async t => {
  const f = await fixture(t, { cross: true, selected: 2 })
  f.page('old', [tool('product_add')]); f.page('other', [tool('inventory_query')], keys[1])
  const a = await f.search('old'); const old = f.nameFor(a.value, 'product_add')
  const b = await f.search('other', keys[1]); const other = f.nameFor(b.value, 'inventory_query', keys[1])
  f.backend.revisions.set(keys[0], revision('b')); f.page('new', [tool('product_query')])
  const changed = await f.search('new')
  assert.equal(changed.value.authorizations[0].candidate_update, 'reset')
  assert.equal(changed.value.active_tools.some(entry => entry.name === old), false)
  assert.equal(changed.value.active_tools.some(entry => entry.name === other), true)
  assert.equal((await f.business(old)).isError, true)
  assert.equal((await f.business(other, keys[1])).isError, false)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 2)
})

test('same-revision conflicting declarations are quarantined instead of changing the meaning of a loaded name', async t => {
  const f = await fixture(t)
  f.page('original', [tool('product_add')])
  await f.search('original')
  f.page('conflict', [tool('product_add', { scope: 'inventory.manage', description: 'A conflicting declaration.' })])
  const conflict = await f.search('conflict')
  assert.ok(conflict.isError || conflict.value.conflicting_tools?.includes('product_add'), 'conflict must be explicit')
  assert.equal(f.state().active_tools.some(entry => entry.name === 'product_add'), false)
  assert.equal((await f.business('product_add')).isError, true)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  await f.search('original')
  assert.equal(f.state().active_tools.some(entry => entry.name === 'product_add'), false, 'another page cannot clear a same-revision conflict')
  f.backend.revisions.set(keys[0], revision('b'))
  await f.search('original')
  assert.equal((await f.business('product_add')).isError, false, 'a new authoritative revision can restore the declaration')
})

for (const outcome of ['unknown', 'approval']) test(`${outcome} invocation survives catalog eviction and resumes only its original write`, async t => {
  const f = await fixture(t, { cross: true, selected: 2 })
  f.page('write', [tool('product_add')])
  const first = await f.search('write'); const originalName = f.nameFor(first.value, 'product_add')
  f.backend.loseConfirmation = outcome === 'unknown'; f.backend.pending = outcome === 'approval'
  const written = await f.business(originalName, keys[0], 'original-write')
  const invocationId = outcome === 'unknown' ? written.meta.bailinghub.feedback.invocation_id : written.value.result.invocation_id
  assert.match(invocationId, /^[a-f0-9]{64}$/)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  for (let batch = 0; batch < 6; batch++) {
    f.page(`batch-${batch}`, Array.from({ length: 12 }, (_, index) => tool(`inventory_${batch}_${index}`)), keys[1])
    const loaded = await f.search(`batch-${batch}`, keys[1])
    assert.ok(loaded.value.active_tools.length <= 64)
    assert.ok(loaded.value.visible_tools.length <= 12)
  }
  assert.equal(f.state().active_tools.some(entry => entry.name === originalName), false, 'exercise an original invocation whose tool really left the registry')
  const stale = await f.business(originalName, keys[0], 'original-write')
  assert.equal(stale.isError, true)
  assert.equal(stale.meta.bailinghub.feedback.invocation_id, invocationId)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  f.backend.loseConfirmation = false; f.backend.pending = false
  const recovered = await f.execute('resume_governed_tool_invocation', { invocation_id: invocationId })
  assert.equal(recovered.isError, false)
  assert.equal(recovered.value.result.invocation_id, invocationId)
  assert.equal(recovered.value.result.state, 'executed')
  assert.equal(recovered.value.authorization_ref, f.refs[keys[0]])
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.ok(callsFor(f.mock.calls, 'resume').every(call => call.args[0] === invocationId && call.args[2].connectionKey === keys[0]))
})

test('an unactivated selected member revocation blocks retained calls for the whole group', async t => {
  const f = await fixture(t, { cross: true, selected: 2 })
  f.page('add', [tool('product_add')]); f.page('query', [tool('product_query')])
  const first = await f.search('add'); const name = f.nameFor(first.value, 'product_add')
  await f.search('query')
  f.entries[1].state = 'revoked'
  assert.equal((await f.business(name)).isError, true)
  assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'blocked')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.ok(callsFor(f.mock.calls, 'startTurn').every(call => call.args[1].connectionKey === keys[0]))
})

for (const selected of [1, 2]) for (const ending of ['signal', 'cancelled', 'completed']) {
  test(`late search after ${ending} cannot restore ${selected === 1 ? 'single' : 'cross-system'} tools`, async t => {
    const f = await fixture(t, { selected, cross: selected === 2 })
    f.page('base', [tool('product_add')]); await f.search('base')
    f.page('late', [tool('product_query')])
    const entered = deferred(); const release = deferred()
    f.backend.beforeSearchReturn = async input => { if (input.query === 'late') { entered.resolve(); await release.promise } }
    const controller = new AbortController()
    const late = f.search('late', keys[0], controller.signal)
    await entered.promise
    if (ending === 'signal') controller.abort()
    else f.end(ending)
    release.resolve()
    const result = await late
    assert.equal(result.isError, true)
    await nextTick()
    const state = f.state()
    assert.equal(state.active_tools.some(entry => (entry.original_name ?? entry.name) === 'product_query'), false)
    if (ending !== 'signal') {
      assert.equal(state.active_tools.length, 0)
      assert.notEqual(state.state, 'active')
    }
    assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  })
}

test('searches serialize while retained calls execute during a slow search and stay available afterwards', async t => {
  const f = await fixture(t)
  f.page('base', [tool('product_add')]); await f.search('base')
  f.page('query', [tool('product_query')]); f.page('stock', [tool('inventory_query')])
  const entered = deferred(); const release = deferred()
  f.backend.beforeSearchReturn = async input => { if (input.query === 'query') { entered.resolve(); await release.promise } }
  const first = f.search('query'); await entered.promise
  const second = f.search('stock')
  assert.equal((await f.business('product_add', keys[0], 'during-search')).isError, false)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').filter(call => call.args[0].query === 'stock').length, 0)
  release.resolve()
  assert.equal((await first).isError, false); assert.equal((await second).isError, false)
  assert.equal((await f.business('product_add', keys[0], 'after-search')).isError, false)
  assert.deepEqual(new Set(f.state().active_tools.map(entry => entry.name)), new Set(['product_add', 'product_query', 'inventory_query']))
})

for (const selected of [1, 2]) test(`empty and failed searches preserve ${selected === 1 ? 'single' : 'cross-system'} retained capabilities`, async t => {
  const f = await fixture(t, { selected, cross: selected === 2 })
  f.page('base', [tool('product_add')])
  const found = await f.search('base'); const name = f.nameFor(found.value, 'product_add')
  const empty = await f.search('no-match')
  assert.equal(empty.isError, false)
  const discovery = selected > 1 ? empty.value.authorizations[0].discovery : empty.value.discovery
  assert.equal(discovery.returned_count, 0)
  assert.ok(empty.value.active_tools.some(entry => entry.name === name), 'zero results describes this search, not an empty active registry')
  f.backend.beforeSearchReturn = async () => {
    throw Object.assign(new Error('synthetic discovery transport unavailable'), { publicCode: 'agent_transport_unavailable' })
  }
  const failure = await f.search('interrupted')
  if (selected === 1) {
    assert.equal(failure.isError, true)
    assert.equal(failure.meta.bailinghub.feedback.category, 'transport_unavailable')
  } else {
    assert.equal(failure.isError, false)
    assert.equal(failure.value.authorizations[0].state, 'unavailable')
    assert.equal(failure.value.authorizations[0].feedback.category, 'transport_unavailable')
  }
  assert.ok(f.state().active_tools.some(entry => entry.name === name))
  assert.equal((await f.business(name)).isError, false)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
})

test('differential discovery keeps native registered handles stable across unrelated searches', async t => {
  const f = await fixture(t)
  f.page('base', [tool('product_add')]); await f.search('base')
  const original = f.agent.ctx.tools.get('product_add', f.agent)
  const searchHandle = f.agent.ctx.tools.get('search_business_capabilities', f.agent)
  assert.ok(original); assert.ok(searchHandle)
  for (let index = 0; index < 3; index++) {
    f.page(`next-${index}`, [tool(`product_query_${index}`)])
    await f.search(`next-${index}`)
    assert.equal(f.agent.ctx.tools.get('product_add', f.agent), original, 'unrelated discovery must not dispose and replace a usable registration')
    assert.equal(f.agent.ctx.tools.get('search_business_capabilities', f.agent), searchHandle)
    assert.equal((await f.business('product_add')).isError, false)
  }
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 3)
})

test('cross-system declaration conflict quarantines only its original target while another system still executes', async t => {
  const f = await fixture(t, { cross: true, selected: 2 })
  f.page('base', [tool('product_add'), tool('product_query')])
  f.page('other', [tool('product_add')], keys[1])
  const first = await f.search('base'); const conflicting = f.nameFor(first.value, 'product_add')
  const second = await f.search('other', keys[1]); const other = f.nameFor(second.value, 'product_add', keys[1])
  f.page('conflict', [tool('product_add', { readonly: true })])
  const conflict = await f.search('conflict')
  assert.equal(conflict.isError, false)
  assert.ok(conflict.value.authorizations[0].conflicting_tools.includes('product_add'))
  assert.equal(conflict.value.active_tools.some(entry => entry.name === conflicting), false)
  assert.ok(conflict.value.active_tools.some(entry => entry.name === other))
  assert.ok(conflict.value.active_tools.some(entry => entry.original_name === 'product_query' && entry.authorization_refs.includes(f.refs[keys[0]])))
  assert.equal((await f.business(conflicting)).isError, true)
  assert.equal((await f.business(other, keys[1])).isError, false)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
})

for (const selected of [1, 2]) for (const outcome of ['unknown', 'approval']) {
  test(`a retired ${selected === 1 ? 'single' : 'cross-system'} host handle preserves ${outcome} original invocation recovery`, async t => {
    const f = await fixture(t, { selected, cross: selected === 2 })
    f.page('original', [tool('product_add')])
    const discovered = await f.search('original'); const name = f.nameFor(discovered.value, 'product_add')
    const originalHandle = f.agent.ctx.tools.get(name, f.agent)
    assert.ok(originalHandle)
    f.backend.loseConfirmation = outcome === 'unknown'; f.backend.pending = outcome === 'approval'
    const original = await f.business(name, keys[0], 'original-write')
    const result = selected === 1 ? original.value : original.value?.result
    const invocationId = outcome === 'unknown' ? original.meta.bailinghub.feedback.invocation_id : result.invocation_id
    assert.match(invocationId, /^[a-f0-9]{64}$/)
    assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
    f.backend.revisions.set(keys[0], revision('b'))
    f.page('changed', [tool('product_add', {
      input_schema: { type: 'object', properties: { product_id: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false },
    })])
    assert.equal((await f.search('changed')).isError, false)
    assert.notEqual(f.agent.ctx.tools.get(name, f.agent), originalHandle, 'exercise a genuinely retired definition rather than the latest slot')
    const args = selected === 1 ? { product_id: 'synthetic-product' }
      : { authorization_ref: f.refs[keys[0]], arguments: { product_id: 'synthetic-product' } }
    await assert.rejects(originalHandle.execute(args, {
      agent: f.agent, callId: 'original-write', signal: new AbortController().signal,
    }), error => {
      assert.equal(error.feedback.invocation_id, invocationId)
      assert.ok(['attempted', 'unknown'].includes(error.feedback.dispatch))
      assert.ok(['resume_original', 'inspect_original'].includes(error.feedback.next_action))
      assert.notEqual(error.feedback.next_action, 'rediscover')
      return true
    })
    assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
    f.backend.loseConfirmation = false; f.backend.pending = false
    const resumed = await f.execute('resume_governed_tool_invocation', { invocation_id: invocationId })
    assert.equal(resumed.isError, false)
    const recovered = selected === 1 ? resumed.value : resumed.value.result
    assert.equal(recovered.invocation_id, invocationId)
    assert.equal(recovered.state, 'executed')
    assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  })
}
