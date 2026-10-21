import assert from 'node:assert/strict'
import test from 'node:test'
import { describeFailure, BUSINESS_EXECUTION_GUIDANCE } from '../lib/capability-feedback.js'
import { SESSION_TOOL_GUIDANCE } from '../lib/session-tools.js'
import { fixture, tool, keys, callsFor, feedback, resultBody } from './helpers/cross-turn-host.mjs'

function assertPreparation(value, reason, nextAction = 'review_context_then_call') {
  assert.equal(value.schema, 'bailing.agent-capability-preparation.v1')
  assert.equal(value.result_type, 'capability_preparation')
  assert.equal(value.dispatch, 'not_dispatched')
  assert.equal(value.reason, reason)
  assert.equal(value.next_action, nextAction)
  assert.equal(value.business_operation_performed, false)
  assert.equal(value.preparation.business_operation_performed, false)
  assert.equal(Object.hasOwn(value, 'invocation_id'), false)
}

for (const selected of [1, 2]) test(`preparation receipt stays distinct from a business receipt with ${selected} selected targets`, async t => {
  const f = await fixture(t, { selected, cross: selected > 1 })
  f.page('write', [tool('product_update')])
  const discovery = await f.search('write')
  assertPreparation(discovery.value, 'capability_search')
  const name = f.nameFor(discovery.value, 'product_update')
  await f.end(); await f.start()
  const prepared = await f.business(name, { callId: 'prepare-original' })
  assertPreparation(prepared.value, 'target_not_prepared')
  assert.equal(prepared.value.preparation.state, 'ready')
  assert.ok(prepared.value.contexts[0].context.knowledge.length, 'current knowledge remains available until a replacement context contract exists')
  const replay = await f.business(name, { callId: 'prepare-original' })
  assert.deepEqual(replay.value, prepared.value)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
  const business = await f.business(name, { callId: 'reviewed-new-decision' })
  assert.equal(resultBody(business).state, 'executed')
  assert.equal(resultBody(business).schema_version, 'bailing.agent-tool-invocation.v1')
  assert.equal(Object.hasOwn(business.value, 'result_type'), false, 'business success keeps its existing result shape')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
})

test('preparation gives a bounded next step when no exact tool was returned or preparation failed', async t => {
  const f = await fixture(t)
  const empty = await f.search('not found', { toolName: 'missing_tool' })
  assertPreparation(empty.value, 'capability_search', 'refine_capability_search')
  assert.equal(empty.value.authorizations[0].requested_tool_available, false)
  await f.end(); await f.start()
  f.backend.beforeStartReturn = async () => { throw Object.assign(new Error('private synthetic error'), { publicCode: 'agent_transport_unavailable' }) }
  const unavailable = await f.search('retry later')
  assertPreparation(unavailable.value, 'capability_search', unavailable.value.authorizations[0].feedback.next_action)
  assert.equal(unavailable.value.preparation.state, 'unavailable')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
})

test('preparing one target does not claim another target is ready or dispatch its requested operation', async t => {
  const f = await fixture(t, { selected: 2, cross: true })
  for (const key of keys.slice(0, 2)) f.page('write', [tool('product_update')], key)
  const a = await f.search('write')
  const b = await f.search('write', { key: keys[1] })
  const aName = f.nameFor(a.value, 'product_update')
  const bName = f.nameFor(b.value, 'product_update', keys[1])
  await f.end(); await f.start()
  const first = await f.business(aName)
  assertPreparation(first.value, 'target_not_prepared')
  assert.equal(first.value.targets.find(entry => entry.authorization_ref === f.refs[keys[1]]).preparation_state, 'not_prepared')
  const second = await f.business(bName, { key: keys[1] })
  assertPreparation(second.value, 'target_not_prepared')
  assert.equal(second.value.contexts.length, 1)
  assert.equal(second.value.contexts[0].authorization_ref, f.refs[keys[1]])
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})

for (const lifecycle of ['session', 'active_turn']) test(`common guidance is assembled once while ${lifecycle} tool declarations retain local safety facts`, async t => {
  const f = await fixture(t, { toolLifecycle: lifecycle })
  f.page('write', [tool('product_update', { description: 'Bind the decoration to page settings before checking the storefront.' }), tool('product_read')])
  await f.search('write')
  const assembled = await f.assemble()
  const profile = assembled.sections.find(section => section.name === 'bailinghub:agent-client-profile').text
  assert.equal(profile.split(BUSINESS_EXECUTION_GUIDANCE).length - 1, 1)
  if (lifecycle === 'session') assert.equal(profile.split(SESSION_TOOL_GUIDANCE).length - 1, 1)
  for (const definition of assembled.tools.filter(entry => entry.name.startsWith('product_'))) {
    assert.ok(!definition.description.includes(SESSION_TOOL_GUIDANCE))
    assert.ok(!definition.description.includes(BUSINESS_EXECUTION_GUIDANCE))
    assert.match(definition.description, /scope=product.manage, risk=medium, approval_required=true, readonly=false, idempotent=false/)
    assert.match(definition.description, /original invocation_id; never create a replacement call/)
  }
  assert.match(assembled.tools.find(entry => entry.name === 'product_update').description, /Bind the decoration to page settings/)
  assert.ok(assembled.contexts.some(entry => entry.name.startsWith('bailinghub:knowledge')), 'named knowledge context is retained')
})

test('size diagnostics survive host feedback without exposing arbitrary details or changing dispatch facts', async t => {
  const f = await fixture(t)
  f.page('write', [tool('product_update')]); await f.search('write')
  f.backend.beforeInvoke = async () => { throw Object.assign(new Error('PRIVATE_SOURCE'), {
    publicCode: 'arguments_too_large', statusCode: 413, disposition: 'definitive_rejection',
    details: { origin: 'core', dispatch: 'not_dispatched', limitScope: 'arguments', actualBytes: 1048577, maxBytes: 1048576,
      arguments: { html: 'PRIVATE_DESIGN' }, secret: 'PRIVATE_CREDENTIAL', largest_field: 'PRIVATE_PATH' },
  }) }
  const rejected = await f.business('product_update')
  assert.equal(rejected.isError, true)
  const projected = feedback(rejected)
  assert.equal(projected.origin, 'core')
  assert.equal(projected.dispatch, 'not_dispatched')
  assert.equal(projected.category, 'invalid_request')
  assert.equal(projected.limit_scope, 'arguments')
  assert.equal(projected.actual_bytes, 1048577)
  assert.equal(projected.max_bytes, 1048576)
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|largest_field|secret/)
  assert.equal(Object.hasOwn(projected, 'arguments'), false)
  assert.deepEqual(JSON.parse(rejected.content[0].text).feedback, projected)
})

test('only known size scalars project and accepted unknown recovery always wins', () => {
  const error = { publicCode: 'arguments_too_large', details: { origin: 'client', limitScope: 'request_body',
    actualBytes: -1, maxBytes: '1048576', observedBytes: 2097153, message: 'PRIVATE_MESSAGE' } }
  const local = describeFailure(error, { operation: 'invoke' })
  assert.equal(local.origin, 'sdk')
  assert.equal(local.dispatch, 'not_dispatched')
  assert.equal(local.observed_bytes, 2097153)
  assert.equal(local.limit_scope, 'request_body')
  assert.equal(Object.hasOwn(local, 'actual_bytes'), false)
  assert.equal(Object.hasOwn(local, 'max_bytes'), false)
  const unrelated = describeFailure({ ...error, publicCode: 'invalid_request' }, { operation: 'invoke' })
  assert.equal(Object.hasOwn(unrelated, 'observed_bytes'), false)
  const unknown = describeFailure({ ...error, disposition: 'accepted_unknown', invocationId: 'a'.repeat(64) }, { operation: 'invoke' })
  assert.equal(unknown.dispatch, 'unknown')
  assert.equal(unknown.category, 'invocation_outcome_unknown')
  assert.equal(unknown.next_action, 'resume_original')
  const malicious = describeFailure({ feedback: { schema: 'bailing.agent-feedback.v1', category: 'invalid_request', code: 'arguments_too_large',
    origin: 'core', dispatch: 'not_dispatched', next_action: 'none', actual_bytes: 9007199254740992, max_bytes: Infinity,
    observed_bytes: { secret: 'PRIVATE' }, limit_scope: 'PRIVATE_SCOPE', secret: 'PRIVATE' } }, { operation: 'invoke' })
  assert.doesNotMatch(JSON.stringify(malicious), /PRIVATE|actual_bytes|max_bytes|observed_bytes|limit_scope/)
})
