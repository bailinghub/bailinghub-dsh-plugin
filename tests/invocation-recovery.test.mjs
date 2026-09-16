import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin } from '../lib/index.js'
import { createFileInvocationStore, createMemoryInvocationStore } from '../lib/invocation-store.js'
import { createFileSessionScopeStore, createMemorySessionScopeStore } from '../lib/session-scope-store.js'
import { callsFor, createMockTransport, turnResponse, userMessage } from './helpers/mock-host.mjs'

const keys = [1, 2, 3].map(n => `conn_${String(n).repeat(32)}`)
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = 'a'.repeat(64)
const definition = {
  name: 'product_update', description: 'Update a synthetic product title.',
  input_schema: { type: 'object', properties: { product_id: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false },
  scope: 'product.manage', risk: 'medium', approval_required: true, readonly: false, idempotent: false,
}
const body = result => result.value?.result ?? result.value
const invocationIdFor = result => result.meta?.bailinghub?.feedback?.invocation_id ?? body(result)?.invocation_id
const feedback = result => result.meta?.bailinghub?.feedback ?? result.value?.feedback
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function harness(t, { selected = 2, files = false, omitInvocationStore = false } = {}) {
  const directory = files ? await mkdtemp(join(tmpdir(), 'bailinghub-invocation-recovery-')) : undefined
  const memoryScope = createMemorySessionScopeStore()
  const memoryInvocations = createMemoryInvocationStore()
  const live = new Set()
  t.after(async () => {
    for (const instance of live) await instance.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  const backend = {
    entries: keys.map((connectionKey, index) => ({
      connectionKey, hubUrl: 'https://hub.example.com', clientAppId: index === 1 ? 'inventory_app' : 'shop_app',
      workspace: index === 1 ? 'inventory' : 'shop', connectionName: `Synthetic account ${index + 1}`,
      sessionId: uuid(index + 1), state: 'authorized', current: index === 2,
    })),
    runs: new Map(), invocations: new Map(), nextRun: 100, pending: false, loseConfirmation: false, offline: false,
  }
  const control = { beforeSave: undefined, afterSave: undefined }
  const scopeStore = () => files
    ? createFileSessionScopeStore({ directory: join(directory, 'scopes') }) : memoryScope
  const baseInvocationStore = () => files
    ? createFileInvocationStore({ directory: join(directory, 'invocations') }) : memoryInvocations
  const invocationStore = () => {
    const store = baseInvocationStore()
    return {
      load: sessionId => store.load(sessionId),
      save: async (...args) => {
        await control.beforeSave?.(...args)
        const saved = await store.save(...args)
        await control.afterSave?.(...args)
        return saved
      },
    }
  }
  let seedCounter = 0

  async function launch({ sessionId = `invocation-recovery-${++seedCounter}`, history = [], choose = true } = {}) {
    const ctx = new Context()
    const target = options => {
      assert.ok(keys.slice(0, selected).includes(options.connectionKey), 'unselected/default C receives no target request')
      const entry = backend.entries.find(value => value.connectionKey === options.connectionKey)
      if (options.expectedBinding) assert.deepEqual(options.expectedBinding, {
        hubUrl: entry.hubUrl, clientAppId: entry.clientAppId, workspace: entry.workspace, sessionId: entry.sessionId,
      })
      return entry
    }
    const resultFor = (id, original) => ({
      schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: id,
      route: backend.entries.find(value => value.connectionKey === original.key).workspace,
      tool: original.input.tool, state: backend.pending ? 'awaiting_approval' : 'executed',
      ok: !backend.pending, auto_retry_allowed: false, text: 'Synthetic result only.',
    })
    const mock = createMockTransport({
      connectionsList: async () => {
        if (backend.offline) throw new Error('synthetic network unavailable')
        return { currentConnectionKey: keys[2], connections: structuredClone(backend.entries) }
      },
      status: async options => {
        const entry = target(options)
        if (backend.offline) throw new Error('synthetic network unavailable')
        return { state: entry.state, connectionKey: entry.connectionKey, workspace: entry.workspace, sessionId: entry.sessionId }
      },
      getConversationArchiveCapabilities: async ({ members }) => {
        assert.deepEqual(members.map(member => member.connectionKey), keys.slice(0, selected))
        return { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
      },
      startTurn: async (input, options) => {
        const entry = target(options)
        const runId = uuid(++backend.nextRun)
        backend.runs.set(runId, { key: entry.connectionKey, input: structuredClone(input) })
        return turnResponse({ runId, tools: [], capabilityRevision: revision })
      },
      searchCapabilities: async (input, options) => {
        const entry = target(options)
        assert.equal(backend.runs.get(input.runId)?.key, entry.connectionKey)
        return { schema: 'bailing.agent-capability-search.v1', capability_revision: revision, tools: [definition] }
      },
      invoke: async (input, options) => {
        const entry = target(options)
        assert.equal(backend.runs.get(input.agentRunId)?.key, entry.connectionKey)
        assert.equal(backend.invocations.has(input.invocationId), false, 'original business write must never be dispatched twice')
        const original = { key: entry.connectionKey, input: structuredClone(input) }
        backend.invocations.set(input.invocationId, original)
        if (backend.loseConfirmation) throw new Error('synthetic response loss after dispatch')
        return resultFor(input.invocationId, original)
      },
      resume: async (id, input, options) => {
        const entry = target(options)
        const original = backend.invocations.get(id)
        assert.equal(original?.key, entry.connectionKey, 'recovery must retain the exact original authorization')
        assert.deepEqual(input, {}, 'recovery must not resubmit original parameters')
        return resultFor(id, original)
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
    const scopes = scopeStore()
    const invocations = invocationStore()
    await ctx.plugin(createAgentClientPlugin({
      transport: mock.transport, scopeStore: scopes,
      ...(!omitInvocationStore ? { invocationStore: invocations } : {}),
      recovery: { maxAttempts: 1, maxWaitMilliseconds: 100, pollIntervalMilliseconds: 1, sleep: async () => {} },
    }), { ...backend.entries[0] })
    const runtime = ctx.get('bailingHubAgentClient')
    const session = Session.create(sessionId, structuredClone(history))
    const agent = { id: session.id, session }
    const scope = createScope(runtime.ctx, agent)
    agent.ctx = scope.ctx
    runtime.observeSession(session)
    const selectedScope = choose
      ? await runtime.setSessionScope(session.id, { connectionKeys: keys.slice(0, selected) }) : undefined
    let refs = Object.fromEntries((selectedScope?.authorizations ?? []).map(value => [value.connectionKey, value.authorizationRef]))
    let callCounter = 0
    let currentTurn = 0
    const assemble = () => ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
    const execute = (name, args = {}, callId = `call-${++callCounter}`, signal = new AbortController().signal) =>
      agent.ctx.tools.execute({ name, arguments: args, callId, agent, signal })
    const instance = {
      ctx, runtime, session, agent, mock, scopes, invocations, assemble, execute,
      async restoreScope() {
        const restored = await runtime.restoreSessionScope(session.id)
        refs = Object.fromEntries((restored.authorizations ?? []).map(value => [value.connectionKey, value.authorizationRef]))
        return restored
      },
      async start(turn = 1) {
        currentTurn = turn
        const message = userMessage(`synthetic-user-${turn}`, 'Update a synthetic product or verify its original operation.')
        session.append('turn/start', { turn })
        session.append('user/message', message, { surfaceOp: 'append' })
        runtime.onInboxClaimed({ agent, turn, message })
        await assemble()
      },
      end(reason = 'completed') {
        const event = session.append('turn/end', { turn: currentTurn, reason: { kind: reason } })
        runtime.onSessionEvent(session, event)
      },
      async discover() {
        const result = await execute('search_business_capabilities', { query: 'Update a synthetic product',
          ...(selected > 1 ? { authorization_ref: refs[keys[0]] } : {}),
        })
        assert.equal(result.isError, false)
        return result.value.active_tools.find(value => (value.original_name ?? value.name) === definition.name)?.name
      },
      business(name, callId = 'original-write', signal) {
        const args = { product_id: 'synthetic-product', title: 'SYNTHETIC_PARAMETER_MUST_NOT_BE_PERSISTED' }
        return execute(name, selected > 1 ? { authorization_ref: refs[keys[0]], arguments: args } : args, callId, signal)
      },
      async close() {
        if (!live.delete(instance)) return
        await scope.dispose()
        await ctx.fiber.dispose()
      },
      async reopen() {
        const savedHistory = structuredClone(session.events)
        await instance.close()
        return launch({ sessionId: session.id, history: savedHistory, choose: false })
      },
    }
    live.add(instance)
    return instance
  }
  return { backend, control, launch, rawInvocations: baseInvocationStore }
}

async function originalInvocation(h, options = {}) {
  const first = await h.launch()
  await first.start()
  const name = await first.discover()
  h.backend.pending = options.pending ?? true
  h.backend.loseConfirmation = options.unknown ?? false
  const result = await first.business(name)
  const id = invocationIdFor(result)
  assert.match(id, /^[a-f0-9]{64}$/)
  assert.equal(callsFor(first.mock.calls, 'invoke').length, 1)
  return { first, id, result }
}

for (const selected of [1, 2]) for (const outcome of ['approval', 'unknown']) {
  test(`${selected === 1 ? 'single-target' : 'cross-system'} ${outcome} invocation recovers after complete file-store, runtime and real Session recreation`, async t => {
    const h = await harness(t, { files: true, selected })
    const { first, id } = await originalInvocation(h, { pending: outcome === 'approval', unknown: outcome === 'unknown' })
    const original = h.backend.invocations.get(id)
    first.end()
    const reopened = await first.reopen()
    assert.notEqual(reopened.ctx, first.ctx)
    assert.notEqual(reopened.runtime, first.runtime)
    assert.notEqual(reopened.session, first.session)
    assert.deepEqual(reopened.session.events.slice(0, first.session.events.length), first.session.events)
    assert.ok(reopened.session.events.slice(first.session.events.length).every(event => event.type === 'session/end-seed'),
      'the real Session may append its replay boundary, but no message or business event is reconstructed')
    assert.equal((await reopened.restoreScope()).state, 'ready')
    const restored = await reopened.runtime.restoreSessionInvocations(reopened.session.id)
    assert.equal(restored.state, 'ready')
    const known = restored.entries.find(value => value.invocation_id === id)
    assert.ok(known)
    assert.equal(known.original_run_id, original.input.agentRunId)
    assert.equal(known.result_verified, false, 'a local historical state is not a current server result')
    assert.ok(known.authorization_ref)
    assert.equal(callsFor(reopened.mock.calls, 'resume').length, 0)
    assert.equal(callsFor(reopened.mock.calls, 'invoke').length, 0)
    assert.equal(callsFor(reopened.mock.calls, 'startTurn').length, 0)
    const status = await reopened.runtime.getSessionInvocationStatus(reopened.session.id)
    assert.equal(status.state, 'ready')
    assert.equal(callsFor(reopened.mock.calls, 'resume').length, 0)
    h.backend.pending = false; h.backend.loseConfirmation = false
    await reopened.start(2)
    const recovered = await reopened.execute('resume_governed_tool_invocation', { invocation_id: id })
    assert.equal(recovered.isError, false)
    assert.equal(body(recovered).invocation_id, id)
    assert.equal(body(recovered).state, 'executed')
    assert.equal(callsFor(reopened.mock.calls, 'invoke').length, 0)
    assert.equal(callsFor(reopened.mock.calls, 'resume').length, 1)
    assert.equal(callsFor(reopened.mock.calls, 'resume')[0].args[0], id)
    assert.equal(h.backend.invocations.size, 1)
    const persisted = await h.rawInvocations().load(reopened.session.id)
    const text = JSON.stringify(persisted)
    assert.equal(text.includes('SYNTHETIC_PARAMETER_MUST_NOT_BE_PERSISTED'), false)
    assert.equal(text.includes('Synthetic result only.'), false)
  })
}

test('same-runtime recovery after an offline reopen retains identity, history and the original invocation', async t => {
  const h = await harness(t)
  const { first, id } = await originalInvocation(h, { unknown: true, pending: false })
  first.end()
  const originalRecord = await h.rawInvocations().load(first.session.id)
  h.backend.offline = true
  const reopened = await first.reopen()
  const originalEvents = structuredClone(reopened.session.events)
  for (let retry = 0; retry < 2; retry++) {
    assert.equal((await reopened.restoreScope()).mode, 'blocked')
    assert.equal((await reopened.runtime.restoreSessionInvocations(reopened.session.id)).state, 'blocked')
    assert.deepEqual(await h.rawInvocations().load(first.session.id), originalRecord)
    assert.deepEqual(reopened.session.events, originalEvents)
    assert.equal(callsFor(reopened.mock.calls, 'resume').length, 0)
  }
  h.backend.offline = false; h.backend.loseConfirmation = false
  assert.equal((await reopened.restoreScope()).state, 'ready')
  assert.equal((await reopened.runtime.restoreSessionInvocations(reopened.session.id)).state, 'ready')
  await reopened.start(2)
  const result = await reopened.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(result.isError, false)
  assert.equal(body(result).invocation_id, id)
  assert.equal(callsFor(reopened.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(reopened.mock.calls, 'resume').length, 1)
})

for (const member of [0, 1]) {
  test(`revocation of selected member ${member + 1} blocks the whole restored invocation group`, async t => {
    const h = await harness(t)
    const { first, id } = await originalInvocation(h)
    first.end()
    h.backend.entries[member].state = 'revoked'
    const reopened = await first.reopen()
    assert.equal((await reopened.restoreScope()).mode, 'blocked')
    assert.equal((await reopened.runtime.restoreSessionInvocations(reopened.session.id)).state, 'blocked')
    await reopened.start(2)
    const result = await reopened.execute('resume_governed_tool_invocation', { invocation_id: id })
    assert.equal(result.isError, true)
    assert.equal(callsFor(reopened.mock.calls, 'resume').length, 0)
    assert.equal(callsFor(reopened.mock.calls, 'invoke').length, 0)
    assert.equal(callsFor(reopened.mock.calls, 'startTurn').length, 0)
    assert.equal(h.backend.invocations.size, 1)
  })
}

test('unselected or explicitly empty sessions issue no Hub requests for invocation status or restore', async t => {
  const h = await harness(t, { selected: 0 })
  for (const choose of [false, true]) {
    const f = await h.launch({ choose })
    const status = await f.runtime.getSessionInvocationStatus(f.session.id)
    const restored = await f.runtime.restoreSessionInvocations(f.session.id)
    assert.ok(['inactive', 'blocked'].includes(status.state))
    assert.ok(['inactive', 'blocked'].includes(restored.state))
    assert.deepEqual(status.entries, [])
    assert.deepEqual(restored.entries, [])
    await f.start()
    assert.deepEqual(f.mock.calls, [])
  }
})

test('failure to save the pre-dispatch fence prevents the business invocation', async t => {
  const h = await harness(t)
  const f = await h.launch()
  await f.start()
  const name = await f.discover()
  h.control.beforeSave = async () => { throw Object.assign(new Error('Synthetic storage failure'), { code: 'INVOCATION_STORE_UNAVAILABLE' }) }
  const result = await f.business(name)
  assert.equal(result.isError, true)
  assert.equal(feedback(result)?.category, 'storage_error')
  assert.equal(feedback(result)?.dispatch, 'not_dispatched')
  assert.equal((await f.runtime.getSessionInvocationStatus(f.session.id)).state, 'storage_error')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0)
})

test('failure after a server response stays storage_error until metadata is flushed and only the original is recovered', async t => {
  const h = await harness(t)
  const f = await h.launch()
  await f.start()
  const name = await f.discover()
  h.control.beforeSave = async () => {
    if (h.backend.invocations.size) throw Object.assign(new Error('Synthetic storage failure'), { code: 'INVOCATION_STORE_UNAVAILABLE' })
  }
  const result = await f.business(name)
  const id = [...h.backend.invocations.keys()][0]
  assert.match(id, /^[a-f0-9]{64}$/)
  assert.equal(result.isError, true)
  assert.equal(feedback(result)?.category, 'storage_error')
  assert.equal(feedback(result)?.invocation_id, id)
  const failed = await f.runtime.getSessionInvocationStatus(f.session.id)
  assert.equal(failed.state, 'storage_error')
  assert.ok(failed.entries.some(value => value.invocation_id === id))
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  const durableFence = await h.rawInvocations().load(f.session.id)
  assert.ok(JSON.stringify(durableFence).includes(id), 'the original pre-dispatch binding remains durable')
  h.control.beforeSave = undefined
  assert.equal((await f.runtime.restoreSessionInvocations(f.session.id)).state, 'ready')
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0, 'local flush must not invoke business recovery')
  const recovered = await f.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(recovered.isError, false)
  assert.equal(body(recovered).invocation_id, id)
  assert.equal(body(recovered).state, 'executed')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.ok(callsFor(f.mock.calls, 'resume').length <= 1, 'a same-process verified cached result may avoid a resume request')
})

test('cancellation while the pre-dispatch save is waiting cannot dispatch a late business write', async t => {
  const h = await harness(t)
  const f = await h.launch()
  await f.start()
  const name = await f.discover()
  const entered = deferred(); const release = deferred()
  h.control.beforeSave = async () => { entered.resolve(); await release.promise }
  const controller = new AbortController()
  const pending = f.business(name, 'cancel-before-dispatch', controller.signal)
  await entered.promise
  controller.abort()
  f.end('cancelled')
  release.resolve()
  const result = await pending
  assert.equal(result.isError, true)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0)
  assert.equal(f.runtime.getSessionToolState(f.session.id).active_tools.length, 0)
})

test('a custom scope-only host keeps original business operations and reports durable recovery unsupported', async t => {
  const h = await harness(t, { omitInvocationStore: true })
  const { first, id } = await originalInvocation(h)
  assert.equal((await first.runtime.getSessionInvocationStatus(first.session.id)).state, 'unsupported')
  h.backend.pending = false
  const sameProcess = await first.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(sameProcess.isError, false)
  assert.equal(body(sameProcess).invocation_id, id)
  first.end()
  const reopened = await first.reopen()
  assert.equal((await reopened.restoreScope()).state, 'ready')
  assert.equal((await reopened.runtime.restoreSessionInvocations(reopened.session.id)).state, 'unsupported')
  await reopened.start(2)
  const missing = await reopened.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(missing.isError, true)
  assert.equal(callsFor(reopened.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(reopened.mock.calls, 'resume').length, 0)
})

test('an original Agent Session replaced behind the same connection key blocks recovery without rewriting its binding', async t => {
  const h = await harness(t)
  const { first, id } = await originalInvocation(h)
  first.end()
  const originalRecord = await h.rawInvocations().load(first.session.id)
  h.backend.entries[0].sessionId = uuid(99)
  const reopened = await first.reopen()
  assert.equal((await reopened.restoreScope()).mode, 'blocked')
  assert.equal((await reopened.runtime.restoreSessionInvocations(reopened.session.id)).state, 'blocked')
  assert.deepEqual(await h.rawInvocations().load(first.session.id), originalRecord)
  await reopened.start(2)
  const result = await reopened.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(result.isError, true)
  assert.equal(callsFor(reopened.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(reopened.mock.calls, 'resume').length, 0)
})

test('an invocation ID without a persisted binding cannot be recreated from a model-supplied reference', async t => {
  const h = await harness(t)
  const { first, id } = await originalInvocation(h)
  first.end()
  const unrelated = await h.launch({ sessionId: 'unrelated-conversation' })
  await unrelated.start()
  for (const invocationId of [id, 'f'.repeat(64)]) {
    const result = await unrelated.execute('resume_governed_tool_invocation', { invocation_id: invocationId })
    assert.equal(result.isError, true)
    assert.equal(feedback(result)?.code, 'invocation_binding_unavailable')
  }
  assert.equal(callsFor(unrelated.mock.calls, 'invoke').length, 0)
  assert.equal(callsFor(unrelated.mock.calls, 'resume').length, 0)
  assert.equal(h.backend.invocations.size, 1)
})

test('a committed metadata write whose acknowledgment is lost is reconciled without a repeated business invocation', async t => {
  const h = await harness(t)
  const f = await h.launch()
  await f.start()
  const name = await f.discover()
  h.control.afterSave = async () => {
    if (h.backend.invocations.size) throw Object.assign(new Error('Synthetic storage acknowledgment loss'), { code: 'INVOCATION_STORE_UNAVAILABLE' })
  }
  const result = await f.business(name)
  const id = [...h.backend.invocations.keys()][0]
  assert.equal(result.isError, true)
  assert.equal(feedback(result)?.category, 'storage_error')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  const persisted = await h.rawInvocations().load(f.session.id)
  assert.ok(JSON.stringify(persisted).includes(id))
  h.control.afterSave = undefined
  const restored = await f.runtime.restoreSessionInvocations(f.session.id)
  assert.equal(restored.state, 'ready')
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0)
  const recovered = await f.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(recovered.isError, false)
  assert.equal(body(recovered).invocation_id, id)
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.equal(h.backend.invocations.size, 1)
})


test('unsaved invocation metadata keeps storage_error priority when the original scope is also blocked', async t => {
  const h = await harness(t)
  const f = await h.launch()
  await f.start()
  const name = await f.discover()
  h.control.beforeSave = async () => {
    if (h.backend.invocations.size) throw Object.assign(new Error('Synthetic storage failure'), { code: 'INVOCATION_STORE_UNAVAILABLE' })
  }
  const result = await f.business(name)
  assert.equal(feedback(result)?.category, 'storage_error')
  h.backend.entries[0].state = 'revoked'
  const status = await f.runtime.restoreSessionInvocations(f.session.id)
  assert.equal(status.state, 'storage_error')
  assert.equal(status.scope_state, 'blocked')
  assert.equal(status.unsavedRecords, 1)
  assert.deepEqual(status.entries, [])
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(f.mock.calls, 'resume').length, 0)
})
