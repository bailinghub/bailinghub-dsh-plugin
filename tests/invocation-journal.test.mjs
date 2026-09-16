import assert from 'node:assert/strict'
import test from 'node:test'
import { InvocationJournal, metadataHash, scopeFingerprint } from '../lib/invocation-journal.js'
import { createMemoryInvocationStore } from '../lib/invocation-store.js'

const session = 'synthetic-session'
const id = 'a'.repeat(64)
const scope = { sessionId: session, revision: 3, locked: true, state: 'ready',
  binding: { hubUrl: 'https://hub.example.com', clientAppId: 'shop_app', workspace: 'shop' },
  authorizations: [{ connectionKey: `conn_${'1'.repeat(32)}`, sessionId: '123e4567-e89b-42d3-a456-000000000001', label: 'Synthetic shop' }] }
const original = () => ({ id, scopeHash: scopeFingerprint(scope), scopeRevision: 3,
  target: { ...scope.binding, connectionKey: scope.authorizations[0].connectionKey,
    agentSessionId: scope.authorizations[0].sessionId, authorizationRef: `auth_${'1'.repeat(24)}` },
  runId: '123e4567-e89b-42d3-a456-000000000101', turn: 1, callId: 'call-1', tool: 'product_list',
  capabilityRevision: 'b'.repeat(64), parameterHash: metadataHash({ product_id: 'synthetic' }),
  lastKnownState: 'unknown', retryAt: 0, resultHash: null })
const outcome = (entry, state = 'executed') => ({ ...entry, lastKnownState: state, resultHash: metadataHash({ state }), retryAt: 0 })

test('journal binds the full scope but not mutable display labels', () => {
  assert.equal(scopeFingerprint({ ...scope, authorizations: [{ ...scope.authorizations[0], label: 'Renamed' }] }), scopeFingerprint(scope))
  assert.notEqual(scopeFingerprint({ ...scope, revision: 4 }), scopeFingerprint(scope))
  assert.notEqual(scopeFingerprint({ ...scope, authorizations: [...scope.authorizations, { ...scope.authorizations[0], connectionKey: `conn_${'2'.repeat(32)}` }] }), scopeFingerprint(scope))
})

test('reconstructed journal reserves an existing ID without permission to dispatch again', async () => {
  const store = createMemoryInvocationStore()
  const first = new InvocationJournal(store)
  assert.equal((await first.reserve(session, original())).created, true)
  const next = new InvocationJournal(store)
  assert.equal((await next.reserve(session, original())).created, false)
  assert.deepEqual(await next.find(session, id, scopeFingerprint(scope)), original())
  await assert.rejects(next.find(session, id, 'c'.repeat(64)), { publicCode: 'invocation_binding_conflict' })
})

test('an invocation ID cannot be reused with changed parameters, target or original run', async () => {
  for (const changed of [{ parameterHash: 'f'.repeat(64) }, { runId: '123e4567-e89b-42d3-a456-000000000102' },
    { target: { ...original().target, workspace: 'inventory' } }]) {
    const journal = new InvocationJournal(createMemoryInvocationStore())
    await journal.reserve(session, original())
    await assert.rejects(journal.reserve(session, { ...original(), ...changed }), { publicCode: 'invocation_binding_conflict' })
  }
})

test('metadata whitelist rejects raw business arguments and response text', async () => {
  for (const extra of [{ arguments: { product_id: 'synthetic' } }, { text: 'Business text' }, { unexpected: true }]) {
    const journal = new InvocationJournal(createMemoryInvocationStore())
    await assert.rejects(journal.reserve(session, { ...original(), ...extra }), { publicCode: 'invocation_binding_conflict' })
  }
})

test('save committed but acknowledgement lost can restore without an extra journal mutation', async () => {
  const memory = createMemoryInvocationStore()
  let lose = false
  const journal = new InvocationJournal({ load: id => memory.load(id), save: async (...args) => {
    const saved = await memory.save(...args)
    if (lose) { lose = false; throw new Error('synthetic acknowledgement loss') }
    return saved
  } })
  const before = original()
  await journal.reserve(session, before)
  lose = true
  await assert.rejects(journal.update(session, outcome(before), before), { publicCode: 'invocation_store_unavailable' })
  assert.equal((await journal.status(session, before.scopeHash)).unsavedRecords, 1)
  const restored = await journal.status(session, before.scopeHash, true)
  assert.equal(restored.state, 'ready')
  assert.equal(restored.revision, 2)
  assert.equal(restored.entries[0].result_verified, false)
})

test('stale concurrent outcomes never overwrite a newer receipt', async () => {
  const store = createMemoryInvocationStore()
  const first = new InvocationJournal(store)
  const second = new InvocationJournal(store)
  const before = original()
  await first.reserve(session, before)
  await first.update(session, outcome(before), before)
  await assert.rejects(second.update(session, outcome(before, 'awaiting_approval'), before), { publicCode: 'invocation_store_conflict' })
  assert.equal((await store.load(session)).entries[0].lastKnownState, 'executed')
  assert.equal((await second.status(session, before.scopeHash, true)).state, 'storage_error')
  assert.equal((await store.load(session)).entries[0].lastKnownState, 'executed')
})

test('deletion or revision rollback observed in a living journal is blocked', async () => {
  const store = createMemoryInvocationStore()
  let disappeared = false
  const journal = new InvocationJournal({ save: (...args) => store.save(...args), load: id => disappeared ? null : store.load(id) })
  await journal.reserve(session, original())
  disappeared = true
  assert.equal((await journal.status(session, original().scopeHash)).state, 'blocked')
})

test('missing persistence is explicitly unsupported without disabling original invocation dispatch', async () => {
  const journal = new InvocationJournal(null)
  assert.deepEqual(await journal.reserve(session, original()), { created: true, supported: false })
  assert.equal((await journal.status(session, original().scopeHash)).state, 'unsupported')
  await assert.rejects(journal.find(session, id, original().scopeHash), { publicCode: 'invocation_store_unsupported' })
})

test('v1 journal migrates on write without guessing an old invocation task', async () => {
  const store = createMemoryInvocationStore()
  const old = original()
  await store.save(session, { schema: 'bailing.agent-invocations.v1', sessionId: session, revision: 1, entries: [old] }, null)
  const journal = new InvocationJournal(store)
  assert.deepEqual(await journal.find(session, id, old.scopeHash), old)
  await journal.update(session, outcome(old), old)
  const migrated = await store.load(session)
  assert.equal(migrated.schema, 'bailing.agent-invocations.v2')
  assert.equal(Object.hasOwn(migrated.entries[0], 'taskBinding'), false)
})

test('journal task is immutable through reserve and outcome updates, including old unbound records', async () => {
  const binding = { schema_version: 'bailing.agent-task-binding.v1', task_id: '123e4567-e89b-42d3-a456-000000000900', scope_hash: 'f'.repeat(64) }
  for (const [before, changed] of [
    [original(), { ...original(), taskBinding: binding }],
    [{ ...original(), taskBinding: binding }, original()],
    [{ ...original(), taskBinding: binding }, { ...original(), taskBinding: { ...binding, task_id: '123e4567-e89b-42d3-a456-000000000901' } }],
  ]) {
    const journal = new InvocationJournal(createMemoryInvocationStore())
    await journal.reserve(session, before)
    await assert.rejects(journal.reserve(session, changed), { publicCode: 'invocation_binding_conflict' })
    await assert.rejects(journal.update(session, outcome(changed), before), { publicCode: 'invocation_binding_conflict' })
    assert.deepEqual(await journal.find(session, id, before.scopeHash), before)
  }
})

test('task dispatch uncertainty remains an original unknown call and never suggests rediscovery', async () => {
  const { describeFailure } = await import('../lib/capability-feedback.js')
  const feedback = describeFailure({ publicCode: 'TASK_DISPATCH_UNCERTAIN', feedback: {
    schema: 'bailing.agent-feedback.v1', category: 'invocation_outcome_unknown', code: 'TASK_DISPATCH_UNCERTAIN',
    origin: 'core', dispatch: 'unknown', next_action: 'inspect_original', retryable: false,
  } }, { operation: 'invoke', invocationId: id })
  assert.equal(feedback.code, 'TASK_DISPATCH_UNCERTAIN')
  assert.equal(feedback.dispatch, 'unknown')
  assert.equal(feedback.next_action, 'inspect_original')
  assert.equal(feedback.retryable, false)
})
