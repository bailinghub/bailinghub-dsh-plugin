import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, tool, keys, revision, deferred, callsFor } from './helpers/cross-turn-host.mjs'
import { createAgentClientPlugin } from '../lib/index.js'
import { activeTool, baseAssembly, createMockAgent, createMockHost, createMemorySessionScopeStore,
  selectSessionScope, MOCK_CONNECTION_KEY, createMockTransport, SEARCH_CAPABILITY_REVISION, userMessage } from './helpers/mock-host.mjs'

const sample = () => tool('product_update', { description: 'Short decoration description.', description_truncated: true, usage_guidance_available: true })
const detail = (definition = sample()) => ({ schema_version: 'bailing.agent-tool-detail.v1', route: 'shop', capability_revision: revision('a'),
  tool: definition, usage_guidance: { text: 'Bind the page to settings before publishing. 先确认绑定。', truncated: false,
    source_chars: 56, max_chars: 32768, source_bytes: 72, max_bytes: 65536 } })
function validDetail(definition = sample()) {
  const value = detail(definition)
  value.usage_guidance.source_chars = [...value.usage_guidance.text].length
  value.usage_guidance.source_bytes = Buffer.byteLength(value.usage_guidance.text)
  return value
}
const read = (f, extra = {}) => f.execute('search_business_capabilities', { query: 'Read this exact capability guidance.', tool_name: 'product_update',
  include_usage_guidance: true, ...extra })

test('guidance is visible but loaded only by an explicit exact-name read under its original authorization', async t => {
  const f = await fixture(t)
  f.page('write', [sample()])
  const calls = []
  f.mock.transport.getToolDetail = async (input, options) => { calls.push({ input, options }); return { ...validDetail(), secret: 'PRIVATE', usage_guidance: { ...validDetail().usage_guidance, private: 'PRIVATE' } } }
  const searched = await f.search('write')
  const schema = searched.value.tool_schemas[0]
  assert.equal(schema.description_truncated, true)
  assert.equal(schema.usage_guidance_available, true)
  assert.equal(Object.hasOwn(searched.value, 'usage_guidance'), false)
  assert.equal(calls.length, 0, 'broad discovery does not load full guidance')
  const explicit = await read(f)
  assert.equal(explicit.isError, false)
  assert.equal(explicit.value.dispatch, 'not_dispatched')
  assert.equal(explicit.value.business_operation_performed, false)
  assert.equal(explicit.value.authorizations[0].source, 'cache')
  assert.equal(explicit.value.usage_guidance.original_name, 'product_update')
  assert.equal(explicit.value.usage_guidance.authorization_ref, f.refs[keys[0]])
  assert.match(explicit.value.usage_guidance.text, /先确认绑定/)
  assert.doesNotMatch(JSON.stringify(explicit.value.usage_guidance), /PRIVATE/)
  assert.deepEqual(calls[0].input, { name: 'product_update', capabilityRevision: revision('a') })
  assert.equal(calls[0].options.connectionKey, keys[0])
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
  assert.equal((await f.execute('search_business_capabilities', { query: 'write', include_usage_guidance: true })).isError, true)
  assert.equal(calls.length, 1)
})

test('older SDK guidance support fails explicitly without pretending the business capability is absent', async t => {
  const f = await fixture(t)
  f.page('write', [sample()]); await f.search('write')
  const returned = await read(f)
  assert.equal(returned.value.preparation.state, 'unavailable')
  assert.equal(returned.value.authorizations[0].feedback.code, 'agent_schema_unsupported')
  assert.equal(returned.value.next_action, 'check_compatibility')
  assert.ok(f.state().active_tools.length)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})

test('custom transport details must match the authorized route, revision, complete declaration and text bounds', async t => {
  const f = await fixture(t)
  f.page('write', [sample()]); await f.search('write')
  for (const mutate of [
    value => { value.route = 'other_account' },
    value => { value.capability_revision = revision('b') },
    value => { value.schema_version = 'bailing.agent-tool-detail.v0' },
    value => { value.tool.name = 'other_tool' },
    value => { value.tool.readonly = true },
    value => { value.usage_guidance.text = 'PRIVATE\0' },
    value => { value.usage_guidance.source_bytes = 1 },
    value => { value.usage_guidance.truncated = true },
    value => { value.usage_guidance.text = '中'.repeat(23000); value.usage_guidance.source_chars = 23000; value.usage_guidance.source_bytes = 69000 },
  ]) {
    const value = validDetail(); mutate(value)
    f.mock.transport.getToolDetail = async () => value
    const returned = await read(f)
    assert.equal(returned.value.preparation.state, 'unavailable')
    assert.equal(returned.value.authorizations[0].feedback.code, 'agent_invalid_response')
    assert.equal(Object.hasOwn(returned.value, 'usage_guidance'), false)
    assert.doesNotMatch(JSON.stringify(returned.value), /PRIVATE/)
  }
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})

test('late guidance after cancellation cannot expose details or reactivate a completed turn', async t => {
  const f = await fixture(t)
  f.page('write', [sample()]); await f.search('write')
  const entered = deferred(); const release = deferred()
  t.after(() => release.resolve())
  f.mock.transport.getToolDetail = async () => { entered.resolve(); await release.promise; return validDetail() }
  const pending = read(f)
  await entered.promise
  await f.end('cancelled'); release.resolve()
  const returned = await pending
  assert.equal(returned.isError, true)
  assert.equal(returned.value?.usage_guidance, undefined)
  assert.equal(f.state().active_tools.length, 0)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})

test('a declaration invalidated while guidance is in flight cannot return stale usage as current', async t => {
  const f = await fixture(t)
  f.page('write', [sample()]); await f.search('write')
  const entered = deferred(); const release = deferred()
  t.after(() => release.resolve())
  f.mock.transport.getToolDetail = async () => { entered.resolve(); await release.promise; return validDetail() }
  const pending = read(f)
  await entered.promise
  f.backend.beforeInvoke = async () => { throw Object.assign(new Error('Synthetic declaration changed'), { publicCode: 'capability_changed', disposition: 'refresh_required' }) }
  const rejected = await f.business('product_update')
  assert.equal(rejected.isError, true)
  release.resolve()
  const returned = await pending
  assert.equal(returned.value.preparation.state, 'unavailable')
  assert.equal(returned.value.authorizations[0].feedback.code, 'capability_changed')
  assert.equal(Object.hasOwn(returned.value, 'usage_guidance'), false)
  assert.equal(f.backend.invocations.size, 0)
})

for (const selected of [1, 2]) test(`active-turn exact guidance lookup remains read only with ${selected} selected targets`, async t => {
  const f = await fixture(t, { toolLifecycle: 'active_turn', selected, cross: selected > 1 })
  f.page('write', [sample()]); await f.search('write')
  let reads = 0
  f.mock.transport.getToolDetail = async (input, options) => { reads++; assert.equal(options.connectionKey, keys[0]); return validDetail() }
  const returned = await read(f, selected > 1 ? { authorization_ref: f.refs[keys[0]] } : {})
  assert.equal(returned.isError, false)
  assert.equal(returned.value.result_type, 'capability_preparation')
  assert.equal(returned.value.dispatch, 'not_dispatched')
  assert.equal(returned.value.usage_guidance.original_name, 'product_update')
  assert.equal(reads, 1)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1, 'known exact declarations do not need another discovery request')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
})

test('legacy single-target active-turn entry can fetch details without changing business invocation shape', async t => {
  const host = createMockHost()
  const definition = { ...activeTool(), description_truncated: true, usage_guidance_available: true }
  const mock = createMockTransport({ searchCapabilities: async () => ({ schema: 'bailing.agent-capability-search.v1',
    capability_revision: SEARCH_CAPABILITY_REVISION, tools: [definition] }) })
  createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore() }).apply(host.ctx,
    { hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo', connectionName: 'personal' })
  const { agent, local } = createMockAgent('guidance-single-legacy')
  await selectSessionScope(host, agent, [MOCK_CONNECTION_KEY])
  host.emit('agent/inbox/claimed', { agent, turn: 1, message: userMessage('guidance-user', 'Read this tool safely.') })
  await host.waterfall('system-prompt/assemble', baseAssembly(), { agent, signal: new AbortController().signal }, async () => baseAssembly())
  t.after(() => host.dispose())
  const exec = { agent, callId: 'explicit-guidance', signal: new AbortController().signal }
  const search = local.get('search_business_capabilities')
  await search.execute({ query: 'employee' }, exec)
  mock.transport.getToolDetail = async () => ({ ...validDetail(definition), route: 'demo', capability_revision: SEARCH_CAPABILITY_REVISION })
  const returned = await local.get('search_business_capabilities').execute({ query: 'employee', tool_name: definition.name, include_usage_guidance: true }, exec)
  assert.equal(returned.schema, 'bailing.agent-capability-search.v1', 'existing search schema is preserved')
  assert.equal(returned.result_type, 'capability_preparation')
  assert.equal(returned.business_operation_performed, false)
  assert.equal(returned.usage_guidance.original_name, definition.name)
  assert.equal(callsFor(mock.calls, 'invoke').length, 0)
})
