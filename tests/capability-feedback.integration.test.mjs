import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin } from '../lib/index.js'
import { normalizeCapabilitySearchResponse } from '../lib/runtime.js'
import { describeFailure, normalizeDiscovery } from '../lib/capability-feedback.js'
import { callsFor, createMemorySessionScopeStore, createMockTransport, turnResponse, userMessage } from './helpers/mock-host.mjs'

const keys = [1, 2, 3].map((n) => `conn_${String(n).repeat(32)}`)
const uuid = (n) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const tool = (name) => ({ name, description: 'Read or update a synthetic product.',
  input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, additionalProperties: false },
  scope: 'product.manage', risk: 'medium', approval_required: true, readonly: false, idempotent: false })
const metadata = (count, total = count, limit = 12) => ({
  mode: 'ranked_candidates', scope: 'current_authorization', returned_count: count, authorized_total: total,
  matched_total: null, matched_total_exact: false, limit, truncated: total > count, has_more: total > count,
  truncation_scope: 'authorized_catalog', pagination: 'unsupported',
})

async function fixture(t, { cross = false, selected = 1 } = {}) {
  const ctx = new Context()
  const entries = keys.map((connectionKey, index) => ({
    connectionKey, hubUrl: 'https://hub.example.com', clientAppId: cross && index === 1 ? 'warehouse_app' : 'shop_app',
    workspace: cross && index === 1 ? 'warehouse' : 'shop', connectionName: `Synthetic account ${index + 1}`,
    sessionId: uuid(index + 1), state: 'authorized', current: index === 2,
  }))
  const config = { ...entries[0] }
  const server = { error: null, total: 8, count: 8, metadata: true, unknownWrite: false, runCounter: 10, calls: new Map() }
  const target = (options) => {
    assert.ok(keys.slice(0, selected).includes(options.connectionKey), 'unselected C receives zero requests')
    return entries.find((entry) => entry.connectionKey === options.connectionKey)
  }
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: keys[2], connections: structuredClone(entries) }),
    status: async (options) => {
      const entry = target(options)
      if (server.statusError) throw server.statusError
      return { state: entry.state, connectionKey: entry.connectionKey, workspace: entry.workspace, sessionId: entry.sessionId }
    },
    getConversationArchiveCapabilities: async ({ members }) => {
      assert.deepEqual(members.map((entry) => entry.connectionKey), keys.slice(0, selected))
      return { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
    },
    startTurn: async (_input, options) => { target(options); return turnResponse({ runId: uuid(++server.runCounter), tools: [tool('product_update')] }) },
    searchCapabilities: async (_input, options) => {
      target(options)
      if (server.error) throw server.error
      return { schema: 'bailing.agent-capability-search.v1', capability_revision: 'c'.repeat(64),
        tools: Array.from({ length: server.count }, (_, i) => tool(`product_${i}`)),
        ...(server.metadata ? { discovery: metadata(server.count, server.total) } : {}) }
    },
    invoke: async (input, options) => {
      target(options)
      server.calls.set(input.invocationId, { input, key: options.connectionKey })
      if (server.unknownWrite) throw new Error('synthetic confirmation loss after send')
      return result(input.invocationId)
    },
    resume: async (id, _input, options) => {
      target(options)
      assert.equal(server.calls.get(id)?.key, options.connectionKey)
      return result(id)
    },
  })
  function result(id) {
    return { schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: id, route: 'shop', tool: 'product_update',
      state: 'executed', ok: true, auto_retry_allowed: false, text: 'Synthetic result.' }
  }
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(CommandRuntime, {})
  await ctx.plugin(createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore(),
    recovery: { maxAttempts: 1, maxWaitMilliseconds: 100, pollIntervalMilliseconds: 1, sleep: async () => {} },
  }), config)
  const runtime = ctx.get('bailingHubAgentClient')
  const session = Session.create(`feedback-${cross}-${selected}`, [])
  const agent = { id: session.id, session }
  const scope = createScope(runtime.ctx, agent)
  agent.ctx = scope.ctx
  runtime.observeSession(session)
  const selectedScope = await runtime.setSessionScope(session.id, { connectionKeys: keys.slice(0, selected) })
  const refs = Object.fromEntries(selectedScope.authorizations.map((entry) => [entry.connectionKey, entry.authorizationRef]))
  const message = userMessage('synthetic-user', 'Check selected products and stock.')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  runtime.onInboxClaimed({ agent, turn: 1, message })
  await ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
  t.after(async () => { await scope.dispose(); await ctx.fiber.dispose() })
  const execute = (name, args = {}, callId = `call-${name}-${mock.calls.length}`) => agent.ctx.tools.execute({ name, arguments: args, callId, agent, signal: new AbortController().signal })
  const search = (ref) => execute('search_business_capabilities', { query: 'product', ...(ref ? { authorization_ref: ref } : {}) })
  return { ctx, runtime, agent, session, entries, refs, server, mock, execute, search }
}

test('real host preserves empty, complete, capped and legacy-unknown discovery semantics', async (t) => {
  const f = await fixture(t)
  for (const [count, total] of [[0, 0], [3, 3], [12, 30]]) {
    f.server.count = count; f.server.total = total
    const response = await f.search()
    assert.equal(response.isError, false)
    assert.deepEqual(response.value.discovery, metadata(count, total))
    assert.equal(response.value.toolset.active_count, count)
    assert.equal(response.value.toolset.scope, 'dsh_session')
    assert.equal(response.value.toolset.update, 'merge')
    assert.equal(response.value.discovery.matched_total, null)
    assert.ok(response.content[0].text.includes('authorized_catalog'))
  }
  f.server.metadata = false; f.server.count = 2
  const legacy = await f.search()
  assert.equal(legacy.value.discovery.authorized_total, null)
  assert.equal(legacy.value.discovery.truncated, null)
  assert.equal(legacy.value.discovery.mode, 'unknown')
  assert.equal(legacy.value.active_tools.length, 12)
  const before = f.mock.calls.length
  assert.equal(f.runtime.getSessionToolState(f.session.id).toolset.active_count, 12)
  assert.equal(f.mock.calls.length, before, 'host inspection makes no requests')
})

test('cross-system search retains old callable tools outside the model schema window', async (t) => {
  const f = await fixture(t, { cross: true, selected: 2 })
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  const a = await f.search(f.refs[keys[0]])
  assert.equal(a.value.authorizations[0].discovery.returned_count, 8)
  const oldName = a.value.active_tools.at(-1).name
  const oldRegistration = f.agent.ctx.tools.get(oldName, f.agent)
  const b = await f.search(f.refs[keys[1]])
  assert.equal(b.value.authorizations[0].authorization_ref, f.refs[keys[1]])
  assert.equal(b.value.authorizations[0].discovery.returned_count, 8)
  assert.equal(b.value.toolset.active_count, 16)
  assert.equal(f.runtime.inspectSession(f.session.id).activeToolCount, 16)
  assert.equal(b.value.toolset.visible_count, 12)
  assert.equal(b.value.toolset.retained_outside_window_count, 4)
  assert.equal(b.value.toolset.omitted_tool_count, 0)
  assert.equal(b.value.omitted_tool_count, 0)
  assert.equal(b.value.toolset.update, 'merge')
  assert.ok(b.value.toolset.generation > a.value.toolset.generation)
  assert.equal(b.value.active_tools.some(entry => entry.name === oldName), true)
  assert.equal(b.value.visible_tools.some(entry => entry.name === oldName), false)
  assert.equal(f.agent.ctx.tools.get(oldName, f.agent), oldRegistration, 'unchanged registration is never unloaded')
  const returned = await f.execute(oldName, { authorization_ref: f.refs[keys[0]], arguments: {} })
  assert.equal(returned.isError, false)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2, 'no extra discovery to return to the first tool')
  assert.equal(f.runtime.getToolDispatchFeedback(f.session.id, { toolName: 'another_plugin', errorCode: 'UNKNOWN_TOOL' }), null)
  assert.equal(f.runtime.getToolDispatchFeedback(f.session.id, { toolName: oldName, errorCode: 'UNKNOWN_TOOL' }), null)
})

test('actual host carries safe network, authorization and unsupported errors without string parsing', async (t) => {
  const f = await fixture(t)
  for (const [code, statusCode, category, action] of [
    ['agent_transport_unavailable', 0, 'transport_unavailable', 'retry_discovery'],
    ['unauthorized', 401, 'authorization_unavailable', 'reauthorize'],
    ['agent_schema_unsupported', 0, 'unsupported', 'check_compatibility'],
    ['agent_tools_unavailable', 503, 'unknown_failure', 'none'],
  ]) {
    f.server.error = Object.assign(new Error('PRIVATE_SYNTHETIC_ERROR_BODY'), { publicCode: code, statusCode })
    const failed = await f.search()
    assert.equal(failed.isError, true)
    const feedback = failed.meta.bailinghub.feedback
    assert.equal(feedback.category, category)
    assert.equal(feedback.next_action, action)
    assert.equal(feedback.operation, 'search')
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_SYNTHETIC_ERROR_BODY/)
    assert.deepEqual(JSON.parse(failed.content[0].text).feedback, feedback)
  }
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})

test('multi-target search preserves per-target failure reasons instead of only unavailable', async (t) => {
  const f = await fixture(t, { cross: true, selected: 2 })
  f.server.error = Object.assign(new Error('synthetic'), { publicCode: 'agent_transport_unavailable' })
  const failed = await f.search(f.refs[keys[0]])
  assert.equal(failed.isError, false, 'partial discovery is represented in target outcomes')
  assert.equal(failed.value.authorizations[0].state, 'unavailable')
  assert.equal(failed.value.authorizations[0].feedback.category, 'transport_unavailable')
  assert.equal(failed.value.authorizations[0].feedback.next_action, 'retry_discovery')
  assert.equal(failed.value.toolset.active_count, 1, 'a search transport failure retains the valid tool from startTurn')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 1)
})

test('unknown write outcome retains original call through unloading and replay, without another invoke', async (t) => {
  const f = await fixture(t)
  f.server.unknownWrite = true
  const failed = await f.execute('product_update', {}, 'original-write')
  assert.equal(failed.isError, true)
  const original = failed.meta.bailinghub.feedback.invocation_id
  assert.match(original, /^[0-9a-f]{64}$/)
  assert.equal(failed.meta.bailinghub.feedback.next_action, 'resume_original')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  await f.search()
  const stale = await f.execute('product_update', {}, 'original-write')
  assert.equal(stale.meta.bailinghub.feedback.invocation_id, original)
  assert.equal(stale.meta.bailinghub.feedback.next_action, 'resume_original')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  const resumed = await f.execute('resume_governed_tool_invocation', { invocation_id: original })
  assert.equal(resumed.value.invocation_id, original)
  assert.equal(resumed.value.state, 'executed')
  assert.equal(callsFor(f.mock.calls, 'resume').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
})

test('malformed optional counts cannot make false complete-catalog claims or disable tools', () => {
  const response = normalizeCapabilitySearchResponse({ schema: 'bailing.agent-capability-search.v1', capability_revision: 'a'.repeat(64), tools: [tool('product_read')],
    discovery: { ...metadata(1, 20), truncated: false, has_more: false } })
  assert.equal(response.tools.length, 1)
  assert.equal(response.discovery.authorized_total, null)
  assert.equal(normalizeDiscovery({ ...metadata(1), secret: 'OMIT_EXTRA' }, 1).secret, undefined)
})

test('legacy SDK definitive pre-dispatch rejection stays distinct from an unknown write', () => {
  for (const code of ['capability_changed', 'tool_not_found', 'invalid_request']) {
    const feedback = describeFailure({ publicCode: code, disposition: 'definitive_rejection' }, { operation: 'invoke', invocationId: 'a'.repeat(64) })
    assert.equal(feedback.dispatch, 'not_dispatched')
    assert.notEqual(feedback.next_action, 'resume_original')
  }
  const unknown = describeFailure({ publicCode: 'agent_tool_internal_error', disposition: 'definitive_rejection' }, { operation: 'invoke', invocationId: 'a'.repeat(64) })
  assert.equal(unknown.dispatch, 'unknown')
  assert.equal(unknown.next_action, 'resume_original')
})


test('SDK public codes and dispositions survive the DSH host projection', () => {
  for (const code of ['invocation_conflict', 'invocation_not_found', 'route_not_allowed', 'audience_not_allowed', 'invalid_request']) {
    for (const disposition of ['accepted_unknown', 'definitive_rejection', 'refresh_required']) {
      const feedback = describeFailure({ feedback: { schema: 'bailing.agent-feedback.v1',
        category: 'unknown_failure', code, origin: 'sdk', operation: 'resume', dispatch: 'unknown',
        next_action: 'inspect_original', disposition, invocation_id: 'a'.repeat(64), message: 'PRIVATE_EXTRA',
      } }, { operation: 'resume' })
      assert.equal(feedback.code, code)
      assert.equal(feedback.disposition, disposition)
      assert.equal(feedback.invocation_id, 'a'.repeat(64))
      assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_EXTRA/)
    }
  }
})

test('retired tool with a repeated call ID restores only this turn invocation', async (t) => {
  const f = await fixture(t)
  f.server.unknownWrite = true
  const first = await f.execute('product_update', {}, 'same-call-id')
  const firstId = first.meta.bailinghub.feedback.invocation_id
  await f.search()
  f.runtime.onSessionEvent(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setImmediate(resolve))
  const message = userMessage('synthetic-second-user', 'Update another synthetic product.')
  f.session.append('turn/start', { turn: 2 })
  f.session.append('user/message', message, { surfaceOp: 'append' })
  f.runtime.onInboxClaimed({ agent: f.agent, turn: 2, message })
  await f.ctx.systemPrompt.assemble({ scope: f.agent, agent: f.agent, signal: new AbortController().signal })
  const second = await f.execute('product_update', {}, 'same-call-id')
  const secondId = second.meta.bailinghub.feedback.invocation_id
  assert.notEqual(firstId, secondId)
  await f.search()
  const failed = await f.execute('product_update', {}, 'same-call-id')
  assert.equal(failed.meta.bailinghub.feedback.invocation_id, secondId)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 2)
})


test('local invocation binding without dispatch does not instruct a nonexistent remote resume', async (t) => {
  const f = await fixture(t)
  f.server.statusError = Object.assign(new Error('synthetic offline before invoke'), { publicCode: 'agent_transport_unavailable' })
  const blocked = await f.execute('product_update', {}, 'never-dispatched')
  assert.equal(blocked.isError, true)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  f.server.statusError = null
  await f.runtime.restoreSessionScope(f.session.id)
  await f.search()
  const stale = await f.execute('product_update', {}, 'never-dispatched')
  assert.equal(stale.meta.bailinghub.feedback.dispatch, 'not_dispatched')
  assert.equal(stale.meta.bailinghub.feedback.next_action, 'rediscover')
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})
