import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fixture, tool, keys, revision, deferred, callsFor, feedback } from './helpers/cross-turn-host.mjs'

for (const selected of [1, 2]) test(`parallel cached calls that entered unprepared remain preparation-only with ${selected} selected targets`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { selected, cross: selected > 1 })
  f.page('write', [tool('product_update')])
  const discovered = await f.search('write')
  const name = f.nameFor(discovered.value, 'product_update')
  await f.end(); await f.start()

  // Both calls belong to a model batch planned before it received this turn's
  // context. The second identity probe happens to finish after the first call.
  const gate = deferred()
  const calls = new AsyncLocalStorage()
  const originalGet = f.runtime.sessionScopes.get.bind(f.runtime.sessionScopes)
  let delayed = false
  f.runtime.sessionScopes.get = async (...args) => {
    if (calls.getStore() === 'second' && !delayed) { delayed = true; await gate.promise }
    return originalGet(...args)
  }
  const firstPromise = calls.run('first', () => f.business(name, { callId: 'parallel-first' }))
  const secondPromise = calls.run('second', () => f.business(name, { callId: 'parallel-second' }))
  let first
  try { first = await firstPromise } finally { gate.resolve() }
  const second = await secondPromise
  for (const result of [first, second]) {
    assert.equal(result.isError, false)
    assert.equal(result.value.preparation.state, 'ready')
    assert.equal(result.value.business_operation_performed, false)
    assert.ok(result.value.contexts.length)
    assert.ok(result.value.tool_schemas.some(entry => entry.name === name))
  }
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0, 'preparation creates no invocation reservation')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 2, 'parallel preparation shares this target run')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal((await f.business(name, { callId: 'parallel-second' })).value.business_operation_performed, false,
    'a preparation call ID never becomes a write after preparation')
  assert.equal((await f.business(name, { callId: 'next-model-decision' })).isError, false)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
})

for (const nextTurn of [false, true]) test(`late capability rejection cannot remove a newer cache revision ${nextTurn ? 'after cancellation and a new turn' : 'in the same active turn'}`, { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.page('write', [tool('product_update')]); await f.search('write')
  const release = deferred()
  const entered = deferred()
  f.backend.beforeInvoke = async () => {
    entered.resolve()
    await release.promise
    throw Object.assign(new Error('Synthetic old capability rejection'), {
      publicCode: 'capability_changed', statusCode: 409, disposition: 'refresh_required',
    })
  }
  const pending = f.business('product_update', { callId: 'original-revision-call' })
  await entered.promise
  const originalId = callsFor(f.mock.calls, 'invoke')[0].args[0].invocationId
  try {
    if (nextTurn) { await f.end('cancelled'); await f.start() }
    f.backend.revisions.set(keys[0], revision('b'))
    const prepared = await f.search('write')
    assert.equal(prepared.isError, false)
    assert.equal(prepared.value.targets[0].capability_revision, revision('b'))
    assert.equal(prepared.value.cache.tool_count, 1)
  } finally { release.resolve() }
  const rejected = await pending
  assert.equal(rejected.isError, true)
  assert.equal(feedback(rejected).category, nextTurn ? 'cancelled' : 'capability_changed')
  assert.equal(feedback(rejected).invocation_id, originalId, 'late feedback keeps the original execution association')
  assert.equal(f.state().cache.tool_count, 1, 'old feedback cannot invalidate the newer shared declaration cache')
  assert.equal(f.backend.invocations.size, 0, 'the synthetic old request was rejected before business execution')

  f.backend.beforeInvoke = undefined
  const next = await f.business('product_update', { callId: 'new-revision-model-decision' })
  assert.equal(next.isError, false, 'newly prepared tools stay usable')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 2, 'only an explicit new decision creates another request')
  assert.equal(f.backend.invocations.size, 1)
  assert.notEqual(callsFor(f.mock.calls, 'invoke')[1].args[0].invocationId, originalId)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
})
