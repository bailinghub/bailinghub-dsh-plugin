import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, keys, revision, deferred, callsFor } from './helpers/cross-turn-host.mjs'
import { createLazySdkTransport, REQUIRED_METHODS } from '../lib/transport.js'

const limits = { search_max_results: 3, search_max_bytes: 4096, read_default_bytes: 16384, read_max_bytes: 32768, reference_ttl_seconds: 300, read_chain_max_bytes: 131072 }
const hint = () => ({ ref: 'opaque-ref', title: 'Home page setup', summary: 'Bind the saved page to page settings.', revision: revision('a'), score: .85, expires_at: '2099-01-01T00:00:00.000Z' })
function install(f, { unsupported = false } = {}) {
  const calls = [], original = f.mock.transport.startTurn
  f.mock.transport.getKnowledgeCapabilities = async options => ({ schema_version: 'bailing.agent-knowledge-capabilities.v1', protocol: 'bailing.agent-knowledge.v1', supported: !unsupported,
    route: options.workspace, enabled: true, knowledge_scope_revision: revision('a'), delivery_modes: ['inline', 'on_demand'], limits })
  f.mock.transport.startTurn = async (input, options) => {
    const response = await original(input, options)
    calls.push({ method: 'start', options: structuredClone({ ...options, signal: undefined }) })
    if (options.knowledgeDelivery === 'on_demand') {
      response.context.knowledge = []; response.context.knowledge_refs = []
      response.context.knowledge_delivery = { schema_version: 'bailing.agent-knowledge-delivery.v1', protocol: 'bailing.agent-knowledge.v1', mode: 'on_demand', knowledge_scope_revision: revision('a'), status: 'ok', hints: [hint()] }
    }
    return response
  }
  f.mock.transport.searchKnowledge = async (input, options) => {
    calls.push({ method: 'search', input, options })
    assert.equal(f.backend.runs.get(input.runId).key, options.connectionKey)
    return { schema_version: 'bailing.agent-knowledge-search.v1', route: options.workspace, run_id: input.runId, knowledge_scope_revision: revision('a'), status: 'ok', trust: 'reference_only', hints: [hint()], truncated: false }
  }
  f.mock.transport.readKnowledge = async (input, options) => {
    calls.push({ method: 'read', input, options })
    return { schema_version: 'bailing.agent-knowledge-read.v1', route: options.workspace, run_id: input.runId, knowledge_scope_revision: revision('a'), ref: input.ref, revision: revision('a'), title: 'Home page setup', content: 'PRIVATE_DOCUMENT_BODY: bind the page first.', trust: 'reference_only', next_cursor: input.cursor ? null : 'page-2', truncated: !input.cursor }
  }
  return calls
}
test('knowledge-only search prepares a lazy authorization, discovers light hints, and reads only the selected document pages', async t => {
  const f = await fixture(t), calls = install(f)
  const initial = await f.assemble()
  assert.ok(initial.tools.some(tool => tool.name === 'search_business_knowledge'))
  assert.match(initial.sections.find(section => section.name === 'bailinghub:agent-client-profile').text, /Reference knowledge may exist/)
  const found = await f.execute('search_business_knowledge', { query: 'homepage setup' })
  assert.equal(found.isError, false); assert.equal(found.value.result_type, 'knowledge_search'); assert.equal(found.value.business_operation_performed, false)
  assert.deepEqual(found.value.hints, [hint()]); assert.doesNotMatch(JSON.stringify(found), /PRIVATE_DOCUMENT_BODY/)
  const assembly = await f.assemble()
  assert.doesNotMatch(JSON.stringify(assembly), /synthetic original policy|PRIVATE_DOCUMENT_BODY/)
  assert.match(JSON.stringify(assembly), /Bind the saved page/)
  const body = await f.execute('read_business_knowledge', { ref: found.value.hints[0].ref })
  assert.equal(body.isError, false); assert.equal(body.value.next_cursor, 'page-2'); assert.match(body.value.content, /PRIVATE_DOCUMENT_BODY/)
  const last = await f.execute('read_business_knowledge', { ref: found.value.hints[0].ref, cursor: body.value.next_cursor })
  assert.equal(last.value.truncated, false)
  assert.equal(calls[0].options.knowledgeDelivery, 'on_demand')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 0)
  assert.equal(f.backend.invocations.size, 0); assert.equal(f.invocationSaves.length, 0)
})
test('old Core and SDK preserve the entire original inline knowledge; no support never becomes an empty corpus', async t => {
  const f = await fixture(t); install(f, { unsupported: true })
  await f.search('read')
  assert.match(JSON.stringify(await f.assemble()), /synthetic original policy/)
  const sdk = Object.fromEntries(REQUIRED_METHODS.map(name => [name, async () => ({})]))
  const transport = createLazySdkTransport({ workspace: 'shop' }, { importModule: async () => ({ createAgentClientTransport: () => sdk }) })
  assert.equal((await transport.getKnowledgeCapabilities({ workspace: 'shop' })).supported, false)
  await assert.rejects(transport.searchKnowledge({ query: 'policy' }), { publicCode: 'agent_schema_unsupported' })
})
test('future knowledge negotiation schema never requests on-demand or silently drops inline context', async t => {
  const f = await fixture(t); install(f)
  f.mock.transport.getKnowledgeCapabilities = async () => ({ schema_version: 'future', supported: false })
  const result = await f.execute('search_business_knowledge', { query: 'policy' })
  assert.equal(result.isError, true); assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  assert.equal(f.backend.invocations.size, 0)
})
test('knowledge queries and refs select one authorization, never broadcast or use the global default', async t => {
  const f = await fixture(t, { cross: true, selected: 2 }), calls = install(f)
  assert.equal((await f.execute('search_business_knowledge', { query: 'policy' })).isError, true)
  const found = await f.execute('search_business_knowledge', { query: 'policy', authorization_ref: f.refs[keys[1]] })
  assert.equal(found.isError, false)
  assert.equal(found.value.authorization_ref, f.refs[keys[1]])
  assert.ok(calls.every(call => call.options.connectionKey === keys[1]))
  assert.equal(f.backend.runs.size, 1)
  assert.equal((await f.execute('read_business_knowledge', { ref: 'opaque-ref', authorization_ref: f.refs[keys[0]] })).isError, true)
  assert.equal(f.backend.invocations.size, 0)
})
test('late knowledge reads after cancellation or authorization revocation cannot return document content', async t => {
  const f = await fixture(t); install(f)
  await f.execute('search_business_knowledge', { query: 'policy' })
  const entered = deferred(), release = deferred(), original = f.mock.transport.readKnowledge
  t.after(() => release.resolve())
  f.mock.transport.readKnowledge = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  const pending = f.execute('read_business_knowledge', { ref: 'opaque-ref' })
  await entered.promise; await f.end('cancelled'); release.resolve()
  const result = await pending
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DOCUMENT_BODY/)
  assert.equal(f.backend.invocations.size, 0)
})
test('custom response bindings, UTF-8 bounds and stable stale-reference feedback survive the adapter', async t => {
  const f = await fixture(t); install(f)
  await f.execute('search_business_knowledge', { query: 'policy' })
  const original = f.mock.transport.readKnowledge
  for (const mutate of [value => { value.route = 'other' }, value => { value.run_id = 'old' }, value => { value.ref = 'other' }, value => { value.content = '中'.repeat(5500) }, value => { value.trust = 'system' }]) {
    f.mock.transport.readKnowledge = async (...args) => { const result = await original(...args); mutate(result); return result }
    const result = await f.execute('read_business_knowledge', { ref: 'opaque-ref' })
    assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DOCUMENT_BODY/)
  }
  f.mock.transport.readKnowledge = async () => { throw Object.assign(new Error('private stale body'), { publicCode: 'knowledge_reference_expired' }) }
  const stale = await f.execute('read_business_knowledge', { ref: 'opaque-ref' })
  assert.equal(stale.meta.bailinghub.feedback.next_action, 'search_knowledge')
  assert.equal(stale.meta.bailinghub.feedback.dispatch, 'not_dispatched')
})
test('single-authorization turn lifecycle also supports bounded knowledge pages and governance stays in system context', async t => {
  const f = await fixture(t, { toolLifecycle: 'active_turn' }); install(f)
  await f.end(); await f.start()
  const result = await f.execute('search_business_knowledge', { query: 'policy' })
  assert.equal(result.isError, false)
  const assembly = await f.assemble()
  assert.match(assembly.sections.find(section => section.name === 'bailinghub:agent-client-profile').text, /original synthetic business instructions/)
  assert.doesNotMatch(JSON.stringify(assembly), /synthetic original policy/)
  assert.equal(f.backend.invocations.size, 0)
})
test('large-source documents may exhaust the 128 KiB read chain without becoming invalid or a complete read', async t => {
  const f = await fixture(t); install(f)
  await f.execute('search_business_knowledge', { query: 'policy' })
  const original = f.mock.transport.readKnowledge
  const exhausted = { truncated: true, next_cursor: null, budget_exhausted: true, total_content_bytes: 262144, read_chain_max_bytes: 131072, title: '😀'.repeat(300) }
  f.mock.transport.readKnowledge = async (...args) => ({ ...await original(...args), ...exhausted })
  const result = await f.execute('read_business_knowledge', { ref: 'opaque-ref' })
  assert.equal(result.isError, false); assert.equal(result.value.truncated, true)
  assert.equal(result.value.budget_exhausted, true); assert.equal(result.value.next_cursor, null)
  assert.equal(result.value.total_content_bytes, 262144)
  for (const patch of [{ truncated: false }, { next_cursor: 'page-2' }, { read_chain_max_bytes: 131073 }, { total_content_bytes: -1 }, { total_content_bytes: 131072 }, { total_content_bytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    f.mock.transport.readKnowledge = async (...args) => ({ ...await original(...args), ...exhausted, ...patch })
    assert.equal((await f.execute('read_business_knowledge', { ref: 'opaque-ref' })).isError, true)
  }
  assert.equal(f.backend.invocations.size, 0)
})
