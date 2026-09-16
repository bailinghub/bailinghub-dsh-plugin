import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin, createMemoryInvocationStore } from '../../lib/index.js'
import { callsFor, createMemorySessionScopeStore, createMockTransport, turnResponse, userMessage } from './mock-host.mjs'

const keys = [1, 2, 3].map(n => `conn_${String(n).repeat(32)}`)
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = letter => letter.repeat(64)
const tool = (name, overrides = {}) => ({
  name, description: `Use the synthetic ${name} capability.`,
  input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  scope: 'product.manage', risk: 'medium', approval_required: true, readonly: false, idempotent: false,
  ...overrides,
})
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const nextTick = () => new Promise(resolve => setImmediate(resolve))
const feedback = result => result.meta?.bailinghub?.feedback ?? result.value?.feedback
const resultBody = result => result.value?.result ?? result.value

// Real Cordis tools, prompt assembly, scope and persistent Session events; only the
// remote business system is synthetic. C is an unselected global default throughout.
async function fixture(t, { cross = false, selected = 1, toolLifecycle = 'session' } = {}) {
  const ctx = new Context()
  const entries = keys.map((connectionKey, index) => ({
    connectionKey, hubUrl: 'https://hub.example.com',
    clientAppId: cross && index === 1 ? 'inventory_app' : 'shop_app',
    workspace: cross && index === 1 ? 'inventory' : 'shop',
    connectionName: `Synthetic account ${index + 1}`, sessionId: uuid(index + 1),
    state: 'authorized', current: index === 2,
  }))
  const backend = {
    pages: new Map(), revisions: new Map(keys.map(key => [key, revision('a')])),
    profileRevisions: new Map(keys.map(key => [key, revision('a')])),
    instructions: new Map(keys.map(key => [key, 'Apply the original synthetic business instructions.'])),
    knowledge: new Map(keys.map(key => [key, 'The synthetic original policy.'])),
    runs: new Map(), runsByClientTurn: new Map(), invocations: new Map(), runCounter: 100, pending: false, loseConfirmation: false,
    beforeStartReturn: undefined, beforeInvoke: undefined,
    turnSchema: 'bailing.agent-turn-context.v1', searchSchema: 'bailing.agent-capability-search.v1',
  }
  const target = options => {
    assert.ok(keys.slice(0, selected).includes(options.connectionKey), 'unselected/default C receives no target request')
    const entry = entries.find(value => value.connectionKey === options.connectionKey)
    if (options.expectedBinding) assert.deepEqual(options.expectedBinding, {
      hubUrl: entry.hubUrl, clientAppId: entry.clientAppId, workspace: entry.workspace, sessionId: entry.sessionId,
    })
    return entry
  }
  const invocationResult = (id, original) => ({
    schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: id,
    route: entries.find(entry => entry.connectionKey === original.key).workspace, tool: original.input.tool,
    state: backend.pending ? 'awaiting_approval' : 'executed', ok: !backend.pending,
    auto_retry_allowed: false, text: 'Synthetic business result.',
  })
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: keys[2], connections: structuredClone(entries) }),
    status: async options => {
      const entry = target(options)
      return { state: entry.state, connectionKey: entry.connectionKey, workspace: entry.workspace, sessionId: entry.sessionId }
    },
    getConversationArchiveCapabilities: async ({ members }) => {
      assert.deepEqual(members.map(entry => entry.connectionKey), keys.slice(0, selected))
      return { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
    },
    startTurn: async (input, options) => {
      const entry = target(options)
      const clientTurnKey = `${entry.connectionKey}:${input.clientTurnId}`
      let runId = backend.runsByClientTurn.get(clientTurnKey)
      if (!runId) {
        runId = uuid(++backend.runCounter)
        backend.runsByClientTurn.set(clientTurnKey, runId)
        backend.runs.set(runId, { key: entry.connectionKey, input: structuredClone(input) })
      } else assert.deepEqual(input, backend.runs.get(runId).input, 'a retried startTurn must reuse the complete original request')
      const response = turnResponse({ runId, tools: [], capabilityRevision: backend.revisions.get(entry.connectionKey),
        profileRevision: backend.profileRevisions.get(entry.connectionKey) })
      response.schema_version = backend.turnSchema
      response.context.instructions = backend.instructions.get(entry.connectionKey)
      response.context.knowledge = [{ title: 'Synthetic policy', excerpt: backend.knowledge.get(entry.connectionKey) }]
      await backend.beforeStartReturn?.(input, options)
      return response
    },
    searchCapabilities: async (input, options) => {
      const entry = target(options)
      assert.equal(backend.runs.get(input.runId)?.key, entry.connectionKey)
      return { schema: backend.searchSchema, capability_revision: backend.revisions.get(entry.connectionKey),
        tools: structuredClone(backend.pages.get(`${entry.connectionKey}:${input.query}`) ?? []) }
    },
    invoke: async (input, options) => {
      const entry = target(options)
      assert.equal(backend.runs.get(input.agentRunId)?.key, entry.connectionKey)
      await backend.beforeInvoke?.(input, options)
      assert.equal(input.capabilityRevision, backend.revisions.get(entry.connectionKey))
      assert.equal(backend.invocations.has(input.invocationId), false, 'business invocation is never dispatched twice')
      const original = { key: entry.connectionKey, input: structuredClone(input) }
      backend.invocations.set(input.invocationId, original)
      if (backend.loseConfirmation) throw new Error('synthetic response loss after dispatch')
      return invocationResult(input.invocationId, original)
    },
    resume: async (id, input, options) => {
      const entry = target(options)
      const original = backend.invocations.get(id)
      assert.equal(original?.key, entry.connectionKey)
      assert.deepEqual(input, {}, 'original parameters must not be replayed')
      if (backend.loseConfirmation) throw Object.assign(new Error('synthetic transport uncertainty'), { disposition: 'accepted_unknown' })
      return invocationResult(id, original)
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
  const invocationStore = createMemoryInvocationStore()
  const invocationSaves = []
  const trackedInvocationStore = {
    load: (...args) => invocationStore.load(...args),
    save: (...args) => { invocationSaves.push(structuredClone(args)); return invocationStore.save(...args) },
  }
  await ctx.plugin(createAgentClientPlugin({ transport: mock.transport,
    ...(toolLifecycle === undefined ? {} : { toolLifecycle }),
    scopeStore: createMemorySessionScopeStore(), invocationStore: trackedInvocationStore,
    recovery: { maxAttempts: 1, maxWaitMilliseconds: 100, pollIntervalMilliseconds: 1, sleep: async () => {} },
  }), { ...entries[0] })
  const runtime = ctx.get('bailingHubAgentClient')
  const session = Session.create(`cross-turn-${cross}-${selected}-${toolLifecycle}`, [])
  const agent = { id: session.id, session }
  const scope = createScope(runtime.ctx, agent)
  agent.ctx = scope.ctx
  runtime.observeSession(session)
  const selectedScope = await runtime.setSessionScope(session.id, { connectionKeys: keys.slice(0, selected) })
  const refs = Object.fromEntries(selectedScope.authorizations.map(entry => [entry.connectionKey, entry.authorizationRef]))
  const assemble = () => ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
  let counter = 0
  let currentTurn = 0
  const execute = (name, args = {}, callId = `synthetic-call-${++counter}`, signal = new AbortController().signal) =>
    agent.ctx.tools.execute({ name, arguments: args, callId, agent, signal })
  const search = (query, { key = keys[0], toolName, signal } = {}) => execute('search_business_capabilities', {
    query, ...(selected > 1 ? { authorization_ref: refs[key] } : {}), ...(toolName ? { tool_name: toolName } : {}),
  }, `search-${++counter}`, signal)
  const business = (name, { key = keys[0], callId, args = { product_id: 'synthetic-product' }, signal } = {}) => execute(name,
    selected > 1 ? { authorization_ref: refs[key], arguments: args } : args, callId, signal)
  const start = async (messageText = 'Continue working with the same synthetic product.') => {
    const turn = ++currentTurn
    const message = userMessage(`synthetic-user-${turn}`, messageText)
    session.append('turn/start', { turn })
    session.append('user/message', message, { surfaceOp: 'append' })
    runtime.onInboxClaimed({ agent, turn, message })
    return assemble()
  }
  const end = async (reason = 'completed') => {
    const event = session.append('turn/end', { turn: currentTurn, reason: { kind: reason } })
    runtime.onSessionEvent(session, event)
    await nextTick()
  }
  const nameFor = (result, original, key = keys[0]) => result.active_tools.find(entry =>
    (entry.original_name ?? entry.name) === original && (!entry.authorization_refs || entry.authorization_refs.includes(refs[key])))?.name
  const state = () => runtime.getSessionToolState(session.id)
  const page = (query, definitions, key = keys[0]) => backend.pages.set(`${key}:${query}`, definitions)
  t.after(async () => { await scope.dispose(); await ctx.fiber.dispose() })
  await start()
  return { ctx, runtime, session, agent, entries, refs, backend, mock, invocationStore, invocationSaves, execute, search, business, page, start, end, state, assemble, nameFor }
}


export { fixture, tool, keys, revision, deferred, callsFor, feedback, resultBody }
