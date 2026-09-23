import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { BailingHubAgentClientRuntime } from '../lib/index.js'

function fixture() {
  const unexpected = () => assert.fail('Local primary status must not perform I/O')
  const store = { load: unexpected, save: unexpected }
  const runtime = new BailingHubAgentClientRuntime({}, {}, unexpected, {},
    { scopeStore: store, archiveStore: store, invocationStore: store, taskStore: store })
  const session = Session.create('local-primary-synthetic', [])
  session.unsavedEvents = []
  runtime.observeSession(session)
  runtime.sessionTasks.refresh = unexpected
  runtime.sessionScopes.get = unexpected
  runtime.sessionScopes.assertUsable = unexpected
  return { runtime, session }
}

test('public local primary hook is synchronous and performs zero remote/store calls across streaming deltas', () => {
  const { runtime, session } = fixture()
  const originalEvents = structuredClone(session.events)
  for (let i = 0; i < 500; i++) {
    const status = runtime.getSessionLocalPrimaryStatus(session)
    assert.equal(status.schema, 'bailing.agent-session-local-primary.v1')
    assert.equal(status.state, 'ready')
    assert.equal(status.snapshot_is_dispatch_permission, false)
    assert.equal(status.then, undefined)
  }
  assert.equal(runtime.observedSessions.get(session.id), session)
  assert.deepEqual(session.events, originalEvents)
  assert.equal(runtime.sessionScopes.entries.size, 0)
  assert.equal(runtime.conversationOutbox.entries.size, 0)
})

test('local errors change immediately without TTL and retain storage priority over a known history gap', () => {
  const { runtime, session } = fixture()
  const check = expected => assert.equal(runtime.getSessionLocalPrimaryStatus(session).state, expected)
  // Real observed history with no matching archived event is a known coverage gap.
  session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic history' }] } }, { surfaceOp: 'append' })
  check('recovery_gap')
  session.unsavedEvents.push({ type: 'assistant/message' })
  check('storage_error')
  session.unsavedEvents.length = 0
  check('recovery_gap')
  runtime.invocationJournal.pending.set(session.id, new Map([['original', {}]]))
  check('storage_error')
  runtime.invocationJournal.pending.delete(session.id)
  check('recovery_gap')
  runtime.invocationJournal.failures.set(session.id, 'invocation_store_conflict')
  check('storage_error')
  runtime.invocationJournal.failures.delete(session.id)
  runtime.sessionTasks.entry(session.id).failure = 'TASK_STORE_UNAVAILABLE'
  check('storage_error')
  runtime.sessionTasks.entry(session.id).failure = null
  runtime.conversationOutbox.entries.set(session.id, { status: 'storage_error', pending: [], record: null })
  check('storage_error')
  runtime.conversationOutbox.entries.delete(session.id)
  check('recovery_gap')
  const reopened = Session.create(session.id, [])
  runtime.observeSession(reopened)
  assert.equal(runtime.getSessionLocalPrimaryStatus(reopened).state, 'ready')
})

test('known task pause/cancel is not permission to dispatch and does not become a model persistence error', () => {
  const { runtime, session } = fixture()
  for (const state of ['paused', 'cancelled', 'blocked']) {
    runtime.sessionTasks.entry(session.id).snapshot = { state }
    const value = runtime.getSessionLocalPrimaryStatus(session)
    assert.equal(value.state, 'ready')
    assert.equal(value.local.task, state)
    assert.equal(value.snapshot_is_dispatch_permission, false)
    assert.equal(Object.hasOwn(value, 'task_binding'), false)
  }
})

test('real Session required; supplied unsaved events remain primary before runtime observation', () => {
  const { runtime, session } = fixture()
  for (const value of [null, session.id, { id: session.id }, { id: '', events: [] }]) {
    assert.throws(() => runtime.getSessionLocalPrimaryStatus(value), TypeError)
  }
  const unobserved = Session.create('unobserved-synthetic', [])
  unobserved.unsavedEvents = [{ type: 'assistant/message' }]
  assert.equal(runtime.getSessionLocalPrimaryStatus(unobserved).state, 'storage_error')
  assert.equal(runtime.observedSessions.has(unobserved.id), false)
})

test('async primary barrier preserves genuine host storage errors and unqueued history gaps', async () => {
  const { runtime, session } = fixture()
  assert.equal((await runtime.waitForSessionLocalPrimaryStatus(session)).state, 'ready')
  session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Unarchived synthetic reply' }] } }, { surfaceOp: 'append' })
  assert.equal((await runtime.waitForSessionLocalPrimaryStatus(session)).state, 'recovery_gap')
  session.unsavedEvents.push({ type: 'assistant/message' })
  assert.equal((await runtime.waitForSessionLocalPrimaryStatus(session)).state, 'storage_error')
  assert.equal(session.unsavedEvents.length, 1)
  for (const value of [null, session.id, { id: session.id }]) {
    await assert.rejects(runtime.waitForSessionLocalPrimaryStatus(value), TypeError)
  }
})
