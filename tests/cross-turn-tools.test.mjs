import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { fixture, tool, keys, revision, deferred, callsFor, feedback, resultBody } from './helpers/cross-turn-host.mjs'

const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run)

for (const selected of [0, 1, 2]) test(`session tool lifecycle prepares no business run for ordinary chat with ${selected} selected targets`, async t => {
  const f = await fixture(t, { cross: selected > 1, selected })
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  await f.end(); await f.start('Hello!'); await f.assemble()
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 0)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0)
  if (selected === 0) assert.equal(callsFor(f.mock.calls, 'status').length, 0)
})

test('a second user turn reuses an exact cached query declaration with current context and a fresh run', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query', { readonly: true, approval_required: false })])
  const first = await f.search('query')
  assert.equal(first.isError, false)
  const name = f.nameFor(first.value, 'product_query')
  assert.ok(name)
  assert.equal((await f.business(name)).isError, false)
  const originalRun = callsFor(f.mock.calls, 'invoke')[0].args[0].agentRunId
  await f.end()
  assert.equal(f.state().active_tools.length, 0)
  assert.ok(f.state().cached_tools.some(entry => (entry.original_name ?? entry.name) === 'product_query'))
  const assembly = await f.start('Show the same product again.')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 1, 'new turn alone cannot start another business run')
  assert.equal(f.state().active_tools.length, 0, 'cached schemas are preparation guards, not ready business tools')
  assert.equal(f.state().targets[0].preparation_state, 'not_prepared')
  const cachedSchema = assembly.tools.find(entry => entry.name === name)
  assert.ok(cachedSchema, 'a known cached capability can be shown with its safe preparation guard')
  assert.match(cachedSchema.description, /current.turn preparation/i)
  const second = await f.search('query', { toolName: 'product_query' })
  assert.equal(second.isError, false)
  assert.equal(second.value.preparation.state, 'ready')
  assert.equal(second.value.preparation.business_operation_performed, false)
  assert.equal(second.value.authorizations[0].source, 'cache')
  assert.ok(second.value.tool_schemas.some(entry => entry.name === name && entry.parameters.properties.product_id))
  assert.ok(second.value.contexts.some(entry => entry.run_id !== originalRun))
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal((await f.business(name)).isError, false, 'single target retains plain business parameters')
  const secondInvocation = callsFor(f.mock.calls, 'invoke')[1].args[0]
  assert.notEqual(secondInvocation.agentRunId, originalRun)
  assert.deepEqual(secondInvocation.arguments ?? secondInvocation.args, { product_id: 'synthetic-product' })
  assert.equal(f.state().toolset.lifetime, 'active_turn')
  assert.equal(f.state().toolset.reuse, 'session_runtime')
  assert.equal(f.state().cache.lifetime, 'session_runtime')
})

for (const cross of [false, true]) test(`${cross ? 'cross-system' : 'same-system'} two-target cached tools rebind each original authorization without touching C`, async t => {
  const f = await fixture(t, { cross, selected: 2 })
  for (const key of keys.slice(0, 2)) f.page('query', [tool('product_query')], key)
  const a = await f.search('query')
  const aName = f.nameFor(a.value, 'product_query')
  const b = await f.search('query', { key: keys[1] })
  const bName = f.nameFor(b.value, 'product_query', keys[1])
  if (cross) assert.notEqual(aName, bName)
  else assert.equal(aName, bName)
  await f.business(aName); await f.business(bName, { key: keys[1] })
  const oldRuns = callsFor(f.mock.calls, 'invoke').map(call => call.args[0].agentRunId)
  await f.end(); await f.start()
  const preparedB = await f.search('query', { key: keys[1], toolName: 'product_query' })
  assert.equal(preparedB.isError, false)
  assert.equal(preparedB.value.authorizations[0].source, 'cache')
  assert.equal((await f.business(bName, { key: keys[1] })).isError, false)
  const preparedA = await f.search('query', { toolName: 'product_query' })
  assert.equal(preparedA.value.authorizations[0].source, 'cache')
  assert.equal((await f.business(aName)).isError, false)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
  const invokes = callsFor(f.mock.calls, 'invoke')
  assert.deepEqual(invokes.map(call => call.args[1].connectionKey), [keys[0], keys[1], keys[1], keys[0]])
  assert.ok(invokes.slice(2).every(call => !oldRuns.includes(call.args[0].agentRunId)))
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 4)
  if (cross) assert.equal((await f.business(aName, { key: keys[1] })).isError, true)
})

test('cache preparation returns the current profile and knowledge before any new business invocation', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')]); await f.search('query'); await f.end()
  f.backend.profileRevisions.set(keys[0], revision('b'))
  f.backend.instructions.set(keys[0], 'Use the NEW synthetic business instructions.')
  f.backend.knowledge.set(keys[0], 'The NEW synthetic business policy.')
  await f.start()
  const prepared = await f.search('query', { toolName: 'product_query' })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.authorizations[0].source, 'cache')
  const context = prepared.value.contexts.find(entry => entry.authorization_ref === f.refs[keys[0]])?.context
  assert.equal(context.instructions, 'Use the NEW synthetic business instructions.')
  assert.equal(context.knowledge[0].excerpt, 'The NEW synthetic business policy.')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})

test('a changed declaration revision forces discovery and cannot dispatch the obsolete cached schema', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')]); await f.search('query')
  const oldHandle = f.agent.ctx.tools.get('product_query', f.agent)
  assert.ok(oldHandle)
  await f.end()
  f.backend.revisions.set(keys[0], revision('b'))
  f.page('query', [tool('product_query', {
    input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
  })])
  await f.start()
  const prepared = await f.search('query', { toolName: 'product_query' })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.authorizations[0].source, 'discovery')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
  const schema = prepared.value.tool_schemas.find(entry => entry.name === 'product_query').parameters
  assert.ok(schema.properties.sku)
  assert.equal(schema.properties.product_id, undefined)
  await assert.rejects(oldHandle.execute({ product_id: 'synthetic-product' }, {
    agent: f.agent, callId: 'obsolete-schema-handle', signal: new AbortController().signal,
  }), 'the old declaration handle cannot execute after a revision change')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal((await f.business('product_query', { args: { sku: 'synthetic-sku' } })).isError, false)
})

test('broad query discovery does not assume an old exact name means a matching capability search', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')]); await f.search('query'); await f.end(); await f.start()
  const prepared = await f.search('query')
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.authorizations[0].source, 'discovery')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
})

test('a cached declaration outside the visible window is loaded with its full parameters without remote discovery', async t => {
  const f = await fixture(t)
  for (let group = 0; group < 2; group++) f.page(`group-${group}`, Array.from({ length: 12 }, (_, index) => tool(`product_${group}_${index}`)))
  await f.search('group-0'); const second = await f.search('group-1')
  const hidden = second.value.active_tools.find(entry => !second.value.visible_tools.some(visible => visible.name === entry.name))
  assert.ok(hidden)
  await f.end(); await f.start()
  const prepared = await f.search('Load the known original product capability.', { toolName: hidden.original_name ?? hidden.name })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.authorizations[0].source, 'cache')
  assert.ok(prepared.value.tool_schemas.some(entry => entry.name === hidden.name && entry.parameters.required.includes('product_id')))
  assert.ok(prepared.value.visible_tools.some(entry => entry.name === hidden.name))
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 2)
  assert.ok(prepared.value.active_tools.length <= 64)
  assert.ok(prepared.value.visible_tools.length <= 12)
  assert.equal((await f.business(hidden.name)).isError, false)
})

test('the session cache remains bounded and an evicted exact name requires fresh discovery', async t => {
  const f = await fixture(t)
  f.page('first', [tool('product_first')]); await f.search('first')
  for (let batch = 0; batch < 6; batch++) {
    f.page(`batch-${batch}`, Array.from({ length: 12 }, (_, index) => tool(`product_${batch}_${index}`)))
    await f.search(`batch-${batch}`)
  }
  await f.end(); await f.start()
  assert.ok(f.state().cached_tools.length <= 64)
  assert.equal(f.state().cached_tools.some(entry => (entry.original_name ?? entry.name) === 'product_first'), false)
  const prepared = await f.search('first', { toolName: 'product_first' })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.authorizations[0].source, 'discovery')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 8)
})

test('an unprepared selected member revocation blocks the whole cached group before a fresh business run', async t => {
  const f = await fixture(t, { cross: true, selected: 2 })
  f.page('query', [tool('product_query')]); await f.search('query'); await f.end(); await f.start()
  f.entries[1].state = 'revoked'
  const prepared = await f.search('query', { toolName: 'product_query' })
  assert.equal(prepared.isError, true)
  assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'blocked')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
})

for (const ending of ['cancelled', 'completed', 'signal']) test(`late cache preparation after ${ending} never registers business tools or dispatches writes`, async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')]); await f.search('query'); await f.end(); await f.start()
  const entered = deferred(); const release = deferred()
  t.after(() => release.resolve())
  f.backend.beforeStartReturn = async () => { entered.resolve(); await release.promise }
  const controller = new AbortController()
  const prepared = f.search('query', { toolName: 'product_query', signal: controller.signal })
  await entered.promise
  if (ending === 'signal') controller.abort()
  else await f.end(ending)
  release.resolve()
  const result = await prepared
  assert.ok(result.isError || result.value.preparation.state !== 'ready')
  assert.equal(f.state().active_tools.length, 0)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
})

for (const outcome of ['unknown', 'approval']) test(`${outcome} original invocation crosses turns only through original-ID recovery and new operations get a fresh run`, async t => {
  const f = await fixture(t)
  f.page('write', [tool('product_update')]); await f.search('write')
  f.backend.loseConfirmation = outcome === 'unknown'; f.backend.pending = outcome === 'approval'
  const original = await f.business('product_update', { callId: 'original-write' })
  const invocationId = feedback(original)?.invocation_id ?? resultBody(original)?.invocation_id
  assert.match(invocationId, /^[a-f0-9]{64}$/)
  const originalRun = callsFor(f.mock.calls, 'invoke')[0].args[0].agentRunId
  await f.end(); await f.start()
  f.backend.loseConfirmation = false; f.backend.pending = false
  const beforeInvokes = callsFor(f.mock.calls, 'invoke').length
  const recovered = await f.execute('resume_governed_tool_invocation', { invocation_id: invocationId })
  assert.equal(recovered.isError, false)
  assert.equal(resultBody(recovered).invocation_id, invocationId)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, beforeInvokes)
  assert.ok(callsFor(f.mock.calls, 'resume').every(call => call.args[0] === invocationId && call.args[2].connectionKey === keys[0]))
  const prepared = await f.search('write', { toolName: 'product_update' })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.authorizations[0].source, 'cache')
  const newOperation = await f.business('product_update', { callId: 'new-explicit-write' })
  assert.equal(newOperation.isError, false)
  const dispatched = callsFor(f.mock.calls, 'invoke')
  assert.equal(dispatched.length, 2)
  assert.notEqual(dispatched[1].args[0].invocationId, invocationId)
  assert.notEqual(dispatched[1].args[0].agentRunId, originalRun)
})

test('ten operations using a prepared cached declaration need no repeated discovery or target preparation', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query', { readonly: true, approval_required: false })])
  await f.search('query'); await f.end(); await f.start()
  const prepared = await f.search('query', { toolName: 'product_query' })
  assert.equal(prepared.isError, false)
  const identityChecks = callsFor(f.mock.calls, 'status').length
  for (let index = 0; index < 10; index++) assert.equal((await f.business('product_query')).isError, false)
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 2)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 10)
  assert.ok(callsFor(f.mock.calls, 'status').length >= identityChecks + 10, 'each new operation retains identity checks')
})

for (const selected of [1, 2]) test(`direct ${selected === 1 ? 'single' : 'cross-system'} cached calls prepare only; original call IDs cannot turn into writes`, async t => {
  const f = await fixture(t, { selected, cross: selected > 1 })
  f.page('write', [tool('product_update')])
  const discovered = await f.search('write')
  const name = f.nameFor(discovered.value, 'product_update')
  const oldHandle = f.agent.ctx.tools.get(name, f.agent)
  assert.ok(oldHandle)
  assert.equal(f.invocationSaves.length, 0)
  await f.end(); await f.start()
  f.backend.instructions.set(keys[0], 'Read the NEW synthetic instructions before applying any update.')
  assert.equal(f.state().active_tools.length, 0)
  assert.equal(f.state().targets[0].preparation_state, 'not_prepared')
  const args = selected === 1 ? { product_id: 'synthetic-product' }
    : { authorization_ref: f.refs[keys[0]], arguments: { product_id: 'synthetic-product' } }
  await assert.rejects(oldHandle.execute(args, {
    agent: f.agent, callId: 'retired-handle-call', signal: new AbortController().signal,
  }), 'an ended-turn handle cannot prepare or bind the next turn')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 1)
  assert.equal(f.invocationSaves.length, 0)
  const prepared = await f.business(name, { callId: 'prepare-only-call' })
  assert.equal(prepared.isError, false)
  assert.equal(prepared.value.preparation.state, 'ready')
  assert.equal(prepared.value.preparation.business_operation_performed, false)
  assert.equal(prepared.value.business_operation_performed, false)
  assert.ok(prepared.value.tool_schemas.some(entry => entry.name === name))
  assert.equal(prepared.value.contexts[0].context.instructions, 'Read the NEW synthetic instructions before applying any update.')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0, 'preparation must not reserve a new invocation or persist a dispatch fence')
  assert.equal(await f.invocationStore.load(f.session.id), null)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 2)
  const replayed = await f.business(name, { callId: 'prepare-only-call' })
  assert.equal(replayed.isError, false)
  assert.deepEqual(replayed.value, prepared.value, 'same call returns its original preparation even after the target becomes ready')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
  const changed = await f.business(name, { callId: 'prepare-only-call', args: { product_id: 'another-synthetic-product' } })
  assert.equal(changed.isError, true, 'the caller cannot change parameters under a preparation-only call ID')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
  const operation = await f.business(name, { callId: 'new-model-decision-after-context' })
  assert.equal(operation.isError, false)
  assert.equal(resultBody(operation).state, 'executed')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.ok(f.invocationSaves.length > 0)
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 2)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
})

test('temporary preparation transport failure retries the original request in the same runtime despite a different query', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')]); await f.search('query'); await f.end(); await f.start()
  f.backend.beforeStartReturn = async () => {
    throw Object.assign(new Error('Synthetic preparation connection unavailable.'), { publicCode: 'agent_transport_unavailable' })
  }
  const failed = await f.search('Prepare the original synthetic product inquiry.', { toolName: 'product_query' })
  assert.equal(failed.value.preparation.state, 'unavailable')
  assert.equal(failed.value.authorizations[0].feedback.category, 'transport_unavailable')
  assert.equal(failed.value.authorizations[0].feedback.code, 'agent_transport_unavailable')
  assert.equal(failed.value.authorizations[0].feedback.dispatch, 'not_dispatched')
  assert.equal(f.state().active_tools.length, 0)
  assert.ok(f.state().cached_tools.some(entry => entry.original_name === 'product_query'))
  assert.equal(f.invocationSaves.length, 0)
  f.backend.beforeStartReturn = undefined
  const retried = await f.search('Use a different current query to recover preparation.', { toolName: 'product_query' })
  assert.equal(retried.isError, false)
  assert.equal(retried.value.preparation.state, 'ready')
  assert.equal(retried.value.authorizations[0].source, 'cache')
  const starts = callsFor(f.mock.calls, 'startTurn')
  assert.equal(starts.length, 3)
  assert.equal(starts[1].args[0].clientTurnId, starts[2].args[0].clientTurnId)
  assert.equal(starts[1].args[0].userInput, starts[2].args[0].userInput)
  assert.equal(starts[2].args[0].userInput, 'Prepare the original synthetic product inquiry.')
  assert.deepEqual(starts[1].args[0], starts[2].args[0])
  assert.equal(f.backend.runs.size, 2, 'same-turn preparation retry reuses one authoritative run')
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
})

test('authoritative capability_changed rejection removes cached handles before rediscovery without replaying a write', async t => {
  const f = await fixture(t)
  f.page('write', [tool('product_update')]); await f.search('write'); await f.end(); await f.start()
  await f.search('write', { toolName: 'product_update' })
  const oldHandle = f.agent.ctx.tools.get('product_update', f.agent)
  assert.ok(oldHandle)
  f.backend.revisions.set(keys[0], revision('b'))
  f.backend.beforeInvoke = async () => {
    throw Object.assign(new Error('Synthetic authoritative declaration changed.'), {
      publicCode: 'capability_changed', disposition: 'refresh_required',
    })
  }
  const rejected = await f.business('product_update', { callId: 'rejected-original-declaration' })
  assert.equal(rejected.isError, true)
  assert.equal(feedback(rejected).category, 'capability_changed')
  assert.equal(feedback(rejected).dispatch, 'not_dispatched')
  assert.equal(feedback(rejected).next_action, 'rediscover')
  assert.equal(f.backend.invocations.size, 0, 'Core rejected before executing a business operation')
  assert.equal(f.state().cached_tools.some(entry => entry.original_name === 'product_update'), false)
  assert.equal(f.state().active_tools.length, 0)
  assert.equal(f.agent.ctx.tools.get('product_update', f.agent), undefined)
  await assert.rejects(oldHandle.execute({ product_id: 'synthetic-product' }, {
    agent: f.agent, callId: 'stale-handle-after-authoritative-rejection', signal: new AbortController().signal,
  }))
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  f.backend.beforeInvoke = undefined
  f.page('write', [tool('product_update', { description: 'A revised synthetic product operation.' })])
  const refreshed = await f.search('write', { toolName: 'product_update' })
  assert.equal(refreshed.isError, false)
  assert.equal(refreshed.value.authorizations[0].source, 'discovery')
  assert.equal(refreshed.value.authorizations[0].capability_revision, revision('b'))
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1, 'rediscovery does not replay a rejected write')
  assert.equal(f.backend.invocations.size, 0)
})

for (const seam of ['turn', 'search']) test(`an unsupported ${seam} response remains a compatibility error and performs no business operation`, async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')])
  if (seam === 'turn') f.backend.turnSchema = 'bailing.agent-turn-context.v0'
  else f.backend.searchSchema = 'bailing.agent-capability-search.v0'
  const result = await f.search('query')
  assert.equal(result.value.preparation.state, 'unavailable')
  const failure = result.value.authorizations[0].feedback
  assert.equal(failure.category, 'unsupported')
  assert.equal(failure.code, 'agent_schema_unsupported')
  assert.equal(failure.next_action, 'check_compatibility')
  assert.equal(failure.dispatch, 'not_dispatched')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(f.invocationSaves.length, 0)
  assert.equal(f.state().active_tools.length, 0)
})

test('an interrupted preparation remains ended in its turn but a later user turn can prepare the original cached target', async t => {
  const f = await fixture(t)
  f.page('query', [tool('product_query')]); await f.search('query'); await f.end(); await f.start()
  const entered = deferred(); const release = deferred()
  t.after(() => release.resolve())
  f.backend.beforeStartReturn = async () => { entered.resolve(); await release.promise }
  const controller = new AbortController()
  const pending = f.search('query', { toolName: 'product_query', signal: controller.signal })
  await entered.promise
  controller.abort(); release.resolve()
  const cancelled = await pending
  assert.ok(cancelled.isError || cancelled.value.preparation.state !== 'ready')
  assert.equal(f.state().active_tools.length, 0)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  f.backend.beforeStartReturn = undefined
  await f.end(); await f.start()
  const next = await f.search('query', { toolName: 'product_query' })
  assert.equal(next.isError, false)
  assert.equal(next.value.preparation.state, 'ready')
  assert.equal(next.value.authorizations[0].source, 'cache')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 3)
  assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
})
