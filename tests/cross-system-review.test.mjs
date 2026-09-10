import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin } from '../lib/index.js'
import { createMemorySessionScopeStore } from '../lib/session-scope-store.js'
import { createMemoryConversationArchiveStore } from '../lib/conversation-archive-store.js'
import { activeTool, baseAssembly, callsFor, createMockAgent, createMockHost, createMockTransport, turnResponse, userMessage } from './helpers/mock-host.mjs'

const A = `conn_${'1'.repeat(32)}`
const B = `conn_${'2'.repeat(32)}`
const uuid = (n) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = 'b'.repeat(64)
const config = { hubUrl: 'https://hub.example.com', clientAppId: 'cashier_app', workspace: 'cashier' }

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, hooks = {}) {
  const host = createMockHost()
  const client = createMockAgent('cross-system-review')
  client.agent.session = Session.create('cross-system-review-session', [])
  const entries = hooks.entries ?? [
    { ...config, connectionKey: A, connectionName: 'Cashier', sessionId: uuid(1), state: 'authorized' },
    { hubUrl: config.hubUrl, clientAppId: 'crm_app', workspace: 'crm', connectionKey: B,
      connectionName: 'CRM', sessionId: uuid(2), state: 'authorized' },
  ]
  const target = (metadata) => {
    const entry = entries.find((item) => item.connectionKey === metadata.connectionKey)
    assert.ok(entry, 'All probes and business requests need an original selected target')
    if (metadata.expectedBinding) assert.deepEqual(metadata.expectedBinding, {
      hubUrl: entry.hubUrl, clientAppId: entry.clientAppId, workspace: entry.workspace, sessionId: entry.sessionId,
    })
    return entry
  }
  let starts = 0
  const tool = activeTool('record_update')
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: B, connections: structuredClone(entries) }),
    status: async (options) => {
      const entry = target(options)
      return { state: entry.state, connectionKey: entry.connectionKey, workspace: entry.workspace, sessionId: entry.sessionId }
    },
    getConversationArchiveCapabilities: async () => ({ schema: 'bailing.agent-conversation-audit-capabilities.v1',
      cross_binding_members: true, member_bindings: 'session-client-route.v1' }),
    startTurn: async (input, options) => {
      target(options)
      const count = ++starts
      await hooks.start?.(count, input, options)
      return turnResponse({ runId: uuid(100 + count), tools: [tool], capabilityRevision: revision })
    },
    searchCapabilities: async (_input, options) => {
      target(options)
      return { schema: 'bailing.agent-capability-search.v1', capability_revision: revision, tools: [tool] }
    },
    invoke: async (input, options) => ({ schema_version: 'bailing.agent-tool-invocation.v1',
      invocation_id: input.invocationId, route: target(options).workspace, tool: input.tool,
      state: 'executed', ok: true, auto_retry_allowed: false, text: 'Synthetic current-turn result.' }),
  })
  createAgentClientPlugin({ transport: mock.transport, scopeStore: createMemorySessionScopeStore(),
    archiveStore: createMemoryConversationArchiveStore(),
  }).apply(host.ctx, config)
  host.emit('session/created', client.agent.session)
  t.after(() => host.dispose())
  const runtime = host.services.get('bailingHubAgentClient')
  const scope = await runtime.setSessionScope(client.agent.session.id, { connectionKeys: entries.map((entry) => entry.connectionKey) })
  const refs = Object.fromEntries(scope.authorizations.map((item) => [item.connectionKey, item.authorizationRef]))
  return { ...client, host, runtime, mock, refs, session: client.agent.session }
}

const exec = (f, callId) => ({ agent: f.agent, callId, signal: new AbortController().signal })
function emit(f, type, data) {
  const event = f.session.append(type, data, type === 'user/message' ? { surfaceOp: 'append' } : undefined)
  f.host.emit('session/event', f.session, event)
}
async function begin(f, turn) {
  const message = userMessage(`message-${turn}`, `Local request for turn ${turn}`)
  emit(f, 'turn/start', { turn })
  emit(f, 'user/message', message)
  f.host.emit('agent/inbox/claimed', { agent: f.agent, message, turn })
  return f.host.waterfall('system-prompt/assemble', baseAssembly(), exec(f, `assembly-${turn}`), async () => baseAssembly())
}
const searchA = (f, callId) => f.local.get('search_business_capabilities').execute({
  authorization_ref: f.refs[A], query: 'Find the cashier record update',
}, exec(f, callId))
const typedA = (f) => [...f.local.values()].find((tool) => tool.name.startsWith('bh_') && tool.parameters.properties.authorization_ref.enum.includes(f.refs[A]))

test('a cancelled old target start failure cannot invalidate a successful newer turn on that same target', async (t) => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture(t, { start: async (count) => {
    if (count === 1) {
      entered.resolve()
      await release.promise
      throw new Error('Synthetic old request timeout')
    }
  } })
  await begin(f, 1)
  const oldSearch = searchA(f, 'old-search')
  const oldOutcome = assert.rejects(oldSearch)
  await entered.promise
  emit(f, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } })
  await begin(f, 2)
  await searchA(f, 'new-search')
  const currentTool = typedA(f)
  assert.ok(currentTool)
  release.resolve()
  await oldOutcome
  const result = await currentTool.execute({ authorization_ref: f.refs[A], arguments: { employee_id: 'synthetic-record', name: 'Synthetic' } }, exec(f, 'current-write'))
  assert.equal(result.result.state, 'executed')
  assert.equal(callsFor(f.mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(f.mock.calls, 'invoke')[0].args[0].agentRunId, uuid(102))
  assert.ok(callsFor(f.mock.calls, 'startTurn').every((call) => call.args[1].connectionKey === A))
})

test('explicitly searching a thirteenth same-name system keeps that target usable within the global twelve-tool budget', async (t) => {
  const entries = Array.from({ length: 13 }, (_, index) => ({
    connectionKey: `conn_${(index + 1).toString(16).padStart(32, '0')}`,
    hubUrl: config.hubUrl, clientAppId: `system_${index}`, workspace: `route_${index}`,
    connectionName: `Synthetic system ${index}`, sessionId: uuid(index + 1), state: 'authorized',
  }))
  const f = await fixture(t, { entries })
  await begin(f, 1)
  for (const entry of entries) {
    await f.local.get('search_business_capabilities').execute({
      authorization_ref: f.refs[entry.connectionKey], query: 'Find this system record update',
    }, exec(f, `search-${entry.clientAppId}`))
  }
  const businessTools = [...f.local.values()].filter((tool) => tool.name.startsWith('bh_'))
  assert.ok(businessTools.length <= 12)
  const requestedRef = f.refs[entries.at(-1).connectionKey]
  const requestedTool = businessTools.find((tool) => tool.parameters.properties.authorization_ref.enum.includes(requestedRef))
  assert.ok(requestedTool, 'The explicitly searched system must not remain permanently hidden behind previously loaded same-name tools.')
  const result = await requestedTool.execute({ authorization_ref: requestedRef, arguments: { employee_id: 'synthetic-record', name: 'Synthetic' } }, exec(f, 'last-system-write'))
  assert.equal(result.result.state, 'executed')
  assert.equal(callsFor(f.mock.calls, 'invoke').at(-1).args[1].connectionKey, entries.at(-1).connectionKey)
})
