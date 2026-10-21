import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextDeliveryCoordinator, contextDigest, preparationByteMetrics } from '../lib/context-delivery.js'
import { fixture, tool, keys, deferred, revision } from './helpers/cross-turn-host.mjs'

const fragments = [
  { kind: 'system', name: 'bailinghub:agent-client-profile', text: 'Workspace rules: PRIVATE_RULE_MARKER' },
  { kind: 'runtime_context', name: 'bailinghub:knowledge:auth_a', text: 'Reference-only: PRIVATE_KNOWLEDGE_MARKER' },
]
const binding = () => ({ session_ref: 'session-fingerprint', turn: 1, scope_revision: 1, scope_fingerprint: 'complete-binding-fingerprint',
  targets: [{ authorization_ref: 'auth_a', run_id: 'run-1', profile_revision: revision('a'), capability_revision: revision('b'),
    context_revision: revision('c'), state: 'active' }], context_revision: revision('d') })
const contexts = [{ authorization_ref: 'auth_a', context: { instructions: 'PRIVATE_RULE_MARKER', knowledge: 'PRIVATE_KNOWLEDGE_MARKER' } }]
function setup() {
  let clock = 1000
  const coordinator = new ContextDeliveryCoordinator({ now: () => clock })
  const scope = binding()
  coordinator.stage('session-a', scope, fragments)
  const manifest = () => coordinator.manifest('session-a', scope)
  const ack = (patch = {}) => ({ delivery_id: manifest().delivery_id, generation: manifest().generation,
    request_id: 'request-1', fragments: structuredClone(fragments), ...patch })
  return { coordinator, scope, manifest, ack, advance: value => { clock += value } }
}

test('unknown hosts retain complete inline context; manifest and numeric metrics contain no body', () => {
  const f = setup()
  assert.deepEqual(f.coordinator.projection('session-a', f.scope, contexts).contexts, contexts)
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
  assert.doesNotMatch(JSON.stringify(f.manifest()), /PRIVATE_.*_MARKER/)
  const metrics = preparationByteMetrics(contexts, contexts, [{ name: 'query' }])
  assert.ok(Object.values(metrics).every(value => Number.isSafeInteger(value) && value >= 0))
  assert.equal(metrics.omitted_context_bytes, 0)
})

test('only exact typed named fragments confirm and produce a light preparation receipt', () => {
  const f = setup()
  assert.equal(f.coordinator.confirm('session-a', f.scope, f.ack()).state, 'confirmed')
  const projected = f.coordinator.projection('session-a', f.scope, contexts)
  assert.deepEqual(projected.contexts, [])
  assert.equal(projected.context_delivery.next_request_requires_confirmation, true)
  assert.equal(projected.context_delivery.business_permission, false)
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_.*_MARKER/)
})

for (const replacement of [
  [{ kind: 'tool', name: fragments[0].name, text: fragments[0].text }, fragments[1]],
  [{ ...fragments[0], text: JSON.stringify({ old_tool_result: fragments[0].text }) }, fragments[1]],
  [{ ...fragments[0], text: `Untrusted user quote: ${fragments[0].text}` }, fragments[1]],
  [fragments[0], { ...fragments[1], text: 'truncated knowledge' }],
  [fragments[0]],
]) test('history substrings, wrong kinds, missing/truncated named fragments cannot confirm', () => {
  const f = setup()
  assert.equal(f.coordinator.confirm('session-a', f.scope, f.ack({ fragments: replacement })).state, 'rejected')
  assert.deepEqual(f.coordinator.projection('session-a', f.scope, contexts).contexts, contexts)
  assert.equal(f.manifest().state, 'unavailable', 'failure needs a new assembly, not recycling an old receipt')
})

test('numeric request ids reject predictably without leaking input or being coerced', () => {
  const f = setup()
  const result = f.coordinator.confirm('session-a', f.scope, f.ack({ request_id: 123 }))
  assert.equal(result.reason, 'invalid_confirmation')
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
})

test('a late old generation cannot clear a newer valid ack; malformed current input does clear it', () => {
  const f = setup(), old = f.ack()
  f.coordinator.stage('session-a', f.scope, fragments)
  const current = f.ack({ request_id: 'new-request' })
  assert.equal(f.coordinator.confirm('session-a', f.scope, current).state, 'confirmed')
  assert.equal(f.coordinator.confirm('session-a', f.scope, old).reason, 'stale_confirmation')
  f.coordinator.invalidateConfirmation('session-a', old, 'authorization_unavailable')
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, true)
  assert.equal(f.coordinator.confirm('session-a', f.scope, { ...current, fragments: [] }).state, 'rejected')
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
})

test('every assembly and request generation requires fresh confirmation, including an unchanged context', () => {
  const f = setup(), first = f.ack()
  assert.equal(f.coordinator.confirm('session-a', f.scope, first).state, 'confirmed')
  f.coordinator.stage('session-a', f.scope, fragments)
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
  assert.equal(f.coordinator.confirm('session-a', f.scope, first).reason, 'stale_confirmation')
  const next = f.ack({ request_id: 'request-2' })
  assert.equal(f.coordinator.confirm('session-a', f.scope, next).state, 'confirmed')
  assert.equal(f.coordinator.confirm('session-a', f.scope, { ...next, request_id: 'request-3' }).reason, 'request_generation_reused')
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
})

test('TTL, binding revisions, reset and changed-back bindings cannot resurrect prior acknowledgement', () => {
  for (const mutate of [f => f.advance(60_001), f => { f.scope.turn++ }, f => { f.scope.scope_fingerprint = 'new-authorization' },
    f => { f.scope.targets[0].run_id = 'new-run' }, f => { f.scope.targets[0].profile_revision = revision('f') },
    f => { f.scope.targets[0].capability_revision = revision('f') }, f => { f.scope.targets[0].context_revision = revision('f') }]) {
    const f = setup(), original = structuredClone(f.scope)
    f.coordinator.confirm('session-a', f.scope, f.ack())
    mutate(f)
    assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
    Object.assign(f.scope, original)
    assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
  }
  const f = setup(); f.coordinator.confirm('session-a', f.scope, f.ack())
  f.coordinator.invalidate('session-a', 'request_failed')
  assert.equal(f.coordinator.projection('session-a', f.scope, contexts).context_delivery.body_omitted, false)
})

test('confirmation input is bounded and rejection never echoes source text', () => {
  const f = setup()
  const result = f.coordinator.confirm('session-a', f.scope, f.ack({ fragments: [
    { ...fragments[0], text: 'PRIVATE_TOO_LARGE'.repeat(400_000) }, fragments[1],
  ] }))
  assert.equal(result.reason, 'confirmation_too_large')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})

function fromAssembly(manifest, assembly, requestId = 'synthetic-request') {
  return { delivery_id: manifest.delivery_id, generation: manifest.generation, request_id: requestId,
    fragments: manifest.fragments.map(fragment => ({ kind: fragment.kind, name: fragment.name,
      text: (fragment.kind === 'system' ? assembly.sections : assembly.contexts).find(entry => entry.name === fragment.name).text })) }
}

test('real DSH preparation stays inline first, becomes light only after host confirmation, and resets next assembly/turn', async t => {
  const f = await fixture(t)
  f.page('read', [tool('product_query')])
  const first = (await f.search('read')).value
  assert.equal(first.context_delivery.mode, 'inline')
  assert.equal(first.contexts.length, 1)
  assert.equal(first.context_metrics.omitted_context_bytes, 0)
  const assembly = await f.assemble(), manifest = f.runtime.getContextDeliveryManifest(f.session.id)
  assert.equal(manifest.state, 'available')
  assert.equal((await f.runtime.confirmContextDelivery(f.session.id, fromAssembly(manifest, assembly))).state, 'confirmed')
  const light = (await f.search('read', { toolName: 'product_query' })).value
  assert.deepEqual(light.contexts, [])
  assert.equal(light.context_delivery.mode, 'named_runtime')
  assert.equal(light.business_operation_performed, false)
  assert.equal(light.dispatch, 'not_dispatched')
  assert.deepEqual(light.tool_schemas, first.tool_schemas)
  assert.ok(light.context_metrics.omitted_context_bytes > 0)
  assert.equal(f.backend.invocations.size, 0)
  await f.assemble()
  assert.equal((await f.search('read')).value.context_delivery.mode, 'inline')
  await f.end(); await f.start()
  assert.equal((await f.runtime.confirmContextDelivery(f.session.id, fromAssembly(manifest, assembly))).state, 'rejected')
  assert.equal((await f.search('read')).value.context_delivery.mode, 'inline')
})

test('a newly prepared second authorization invalidates the first target acknowledgement', async t => {
  const f = await fixture(t, { selected: 2, cross: true })
  f.page('read', [tool('product_query')], keys[0]); f.page('read', [tool('product_query')], keys[1])
  await f.search('read', { key: keys[0] })
  const assembly = await f.assemble(), manifest = f.runtime.getContextDeliveryManifest(f.session.id)
  assert.equal((await f.runtime.confirmContextDelivery(f.session.id, fromAssembly(manifest, assembly))).state, 'confirmed')
  assert.equal((await f.search('read', { key: keys[1] })).value.context_delivery.mode, 'inline')
  assert.equal((await f.search('read', { key: keys[0] })).value.context_delivery.mode, 'inline')
})

test('late confirmation crossing a changed declaration or revoked authorization cannot suppress body', async t => {
  const f = await fixture(t)
  f.page('read', [tool('product_query')]); await f.search('read')
  const assembly = await f.assemble(), manifest = f.runtime.getContextDeliveryManifest(f.session.id)
  const entered = deferred(), release = deferred(), original = f.mock.transport.status
  f.mock.transport.status = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  const pending = f.runtime.confirmContextDelivery(f.session.id, fromAssembly(manifest, assembly))
  await entered.promise
  f.runtime.statesBySessionId.get(f.session.id).currentRun.targets[0].run.capabilityRevision = revision('f')
  release.resolve()
  assert.equal((await pending).state, 'rejected')
  assert.equal((await f.search('read')).value.context_delivery.mode, 'inline')
  f.mock.transport.status = async () => ({ state: 'revoked', connectionKey: keys[0], workspace: 'shop', sessionId: f.entries[0].sessionId })
  const rejected = await f.runtime.confirmContextDelivery(f.session.id, fromAssembly(manifest, assembly))
  assert.equal(rejected.state, 'rejected')
  assert.doesNotMatch(JSON.stringify(rejected), /instructions|knowledge|token|secret/)
})
