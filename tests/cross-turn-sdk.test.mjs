import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin, createMemoryInvocationStore, createMemorySessionScopeStore,
  createMemoryConversationArchiveStore } from '../lib/index.js'
import { turnResponse, userMessage } from './helpers/mock-host.mjs'

const sdkDist = process.env.BAILINGHUB_SDK_DIST ?? 'bailinghub-mcp-server/sdk'
const moduleUrl = path => path.startsWith('file:') ? path
  : path.startsWith('/') || path.startsWith('.') ? pathToFileURL(resolve(path)).href : path
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = 'b'.repeat(64)
const definition = {
  name: 'product_query', description: 'Query one synthetic product.',
  input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  scope: 'product.read', risk: 'low', approval_required: false, readonly: true, idempotent: true,
}

async function until(condition) {
  const deadline = Date.now() + 2_000
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), 'synthetic HTTP completion did not settle')
}

// Actual SDK connection selection, binding checks and HTTP serialization are used;
// the service is synthetic and does not access a Core repository or business data.
async function fixture(t, selected) {
  const sdk = await import(moduleUrl(sdkDist))
  const now = Date.now()
  const accounts = ['A', 'B', 'C'].map((label, index) => ({
    label, connectionKey: `conn_${String(index + 1).repeat(32)}`, sessionId: uuid(index + 1),
    clientAppId: index === 1 ? 'inventory_app' : 'shop_app', route: index === 1 ? 'inventory' : 'shop',
    accessToken: `cross-turn-fixture-${label}-access`, refreshToken: `cross-turn-fixture-${label}-refresh`,
  }))
  const selectedAccounts = accounts.slice(0, selected)
  const requests = []
  const errors = []
  const runs = new Map()
  const runsByTurn = new Map()
  const invocations = new Map()
  let nextRun = 100
  let currentTurn = 0
  const server = createServer(async (request, response) => {
    try {
      const account = accounts.find(value => request.headers.authorization === `Bearer ${value.accessToken}`)
      assert.ok(account, 'each HTTP request uses a known synthetic Agent Session')
      assert.ok(selectedAccounts.includes(account), 'an unselected authorization must receive no request')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const body = bytes.length ? JSON.parse(bytes.toString()) : undefined
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      requests.push({ turn: currentTurn, account: account.label, agentSessionId: account.sessionId, path, method: request.method, body })
      if (path === '/agent-api/v1/task-control/capabilities') {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_found' })); return
      }
      let result
      if (path === '/agent-auth/v1/session') {
        assert.equal(request.method, 'GET')
        result = { session_id: account.sessionId, client_app_id: account.clientAppId, device_label: 'synthetic cross-turn fixture',
          principal: { subject: `fixture-${account.label}` }, on_behalf_of: `fixture-${account.label}`,
          allowed_routes: [account.route], created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 3_600_000).toISOString(), refresh_expires_at: new Date(now + 86_400_000).toISOString() }
      } else if (path === `/agent-api/v1/workspaces/${account.route}/turns`) {
        assert.equal(request.method, 'POST')
        assert.ok([1, 2].includes(currentTurn))
        const key = `${account.label}:${body.client_turn_id}`
        let runId = runsByTurn.get(key)
        if (!runId) {
          runId = uuid(++nextRun)
          runsByTurn.set(key, runId)
          runs.set(runId, { account: account.label, agentSessionId: account.sessionId, route: account.route,
            turn: currentTurn, request: structuredClone(body) })
        } else assert.deepEqual(body, runs.get(runId).request)
        result = turnResponse({ runId, tools: [], capabilityRevision: revision })
        result.context.instructions = `Current synthetic instructions for ${account.label}, turn ${currentTurn}.`
        result.context.knowledge = [{ title: 'Synthetic policy', excerpt: `Policy revision for turn ${currentTurn}.` }]
      } else if (path === `/agent-api/v1/workspaces/${account.route}/capabilities/search`) {
        assert.equal(request.method, 'POST')
        assert.equal(currentTurn, 1, 'second-turn exact reuse must not perform another remote search')
        assert.equal(runs.get(body.run_id)?.account, account.label)
        result = { schema: 'bailing.agent-capability-search.v1', capability_revision: revision, tools: [definition] }
      } else if (path === '/agent-api/v1/tool-invocations') {
        assert.equal(request.method, 'POST')
        assert.equal(body.route, account.route)
        assert.equal(body.tool, definition.name)
        assert.equal(body.capability_revision, revision)
        const run = runs.get(body.agent_run_id)
        assert.equal(run?.agentSessionId, account.sessionId)
        assert.equal(run?.turn, currentTurn, 'new operations must use the new current-turn run')
        assert.equal(invocations.has(body.invocation_id), false)
        assert.deepEqual(body.arguments, { product_id: `synthetic-${account.label}` })
        invocations.set(body.invocation_id, { account: account.label, runId: body.agent_run_id, turn: currentTurn })
        result = { schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: body.invocation_id,
          route: account.route, tool: body.tool, state: 'executed', ok: true, auto_retry_allowed: false, text: 'Synthetic product query result.' }
      } else if (/^\/agent-api\/v1\/runs\/[0-9a-f-]+\/complete$/u.test(path)) {
        assert.equal(request.method, 'POST')
        const runId = path.split('/').at(-2)
        assert.equal(runs.get(runId)?.account, account.label)
        result = { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: body.status }
      } else if (path === '/agent-api/v1/conversation-audits/capabilities') {
        result = { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
      } else if (path.endsWith('/system-info') || path.startsWith('/agent-api/v1/conversation-audits')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'conversation_audit_not_found', message: 'Optional synthetic metadata is absent.' }))
        return
      } else assert.fail(`unexpected synthetic SDK request: ${request.method} ${path}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    } catch (error) {
      errors.push(error)
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'synthetic_fixture_assertion_failed' }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  let ctx
  let scope
  t.after(async () => {
    await scope?.dispose(); await ctx?.fiber.dispose()
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const hubUrl = `http://127.0.0.1:${server.address().port}`
  const profiles = accounts.map(account => ({ connectionKey: account.connectionKey, alias: `Synthetic ${account.label}`,
    baseUrl: hubUrl, clientAppId: account.clientAppId, workspace: account.route, allowInsecureHttp: true,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }))
  const credentials = new Map(accounts.map(account => [account.connectionKey, new sdk.MemoryCredentialStore({
    schema_version: 1, base_url: hubUrl, client_app_id: account.clientAppId, route: account.route,
    session_id: account.sessionId, access_token: account.accessToken, refresh_token: account.refreshToken,
    access_expires_at: new Date(now + 3_600_000).toISOString(), refresh_expires_at: new Date(now + 86_400_000).toISOString(),
  })]))
  const connectionStore = {
    registry: { get: async key => profiles.find(profile => profile.connectionKey === key),
      getByAlias: async alias => profiles.find(profile => profile.alias === alias), list: async () => profiles,
      current: async () => profiles[2] },
    credentialStore: key => credentials.get(key),
    load: async key => ({ profile: profiles.find(profile => profile.connectionKey === key), credentials: await credentials.get(key).load() }),
  }
  const config = { hubUrl, clientAppId: accounts[0].clientAppId, workspace: accounts[0].route, connectionName: profiles[0].alias }
  const transport = sdk.createAgentClientTransport({ ...config, allowInsecureHttp: true }, { connectionStore, now: () => now })
  ctx = new Context()
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(CommandRuntime, {})
  await ctx.plugin(createAgentClientPlugin({ transport, toolLifecycle: 'session', scopeStore: createMemorySessionScopeStore(),
    invocationStore: createMemoryInvocationStore(), archiveStore: createMemoryConversationArchiveStore(),
  }), config)
  const runtime = ctx.get('bailingHubAgentClient')
  const session = Session.create(`cross-turn-sdk-${selected}`, [])
  const agent = { id: session.id, session }
  scope = createScope(runtime.ctx, agent); agent.ctx = scope.ctx
  runtime.observeSession(session)
  const chosen = await runtime.setSessionScope(session.id, { connectionKeys: selectedAccounts.map(account => account.connectionKey) })
  const refs = Object.fromEntries(chosen.authorizations.map(value => [value.connectionKey, value.authorizationRef]))
  let counter = 0
  const execute = (name, args) => agent.ctx.tools.execute({ name, arguments: args, callId: `cross-turn-sdk-call-${++counter}`,
    agent, signal: new AbortController().signal })
  const start = async turn => {
    currentTurn = turn
    const message = userMessage(`cross-turn-sdk-user-${turn}`, 'Query the same synthetic product again.')
    session.append('turn/start', { turn }); session.append('user/message', message, { surfaceOp: 'append' })
    runtime.onInboxClaimed({ agent, turn, message })
    return ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
  }
  const end = async () => {
    const completedBefore = requests.filter(entry => entry.path.endsWith('/complete')).length
    const activeTargets = runtime.getSessionToolState(session.id).targets.filter(entry => entry.preparation_state === 'ready').length
    const event = session.append('turn/end', { turn: currentTurn, reason: { kind: 'completed' } })
    runtime.onSessionEvent(session, event)
    if (activeTargets) await until(() => requests.filter(entry => entry.path.endsWith('/complete')).length >= completedBefore + activeTargets)
  }
  const search = (account, cached = false) => execute('search_business_capabilities', { query: 'Query the known synthetic product.',
    ...(selected > 1 ? { authorization_ref: refs[account.connectionKey] } : {}), ...(cached ? { tool_name: definition.name } : {}) })
  const business = (account, name) => execute(name, selected === 1 ? { product_id: `synthetic-${account.label}` }
    : { authorization_ref: refs[account.connectionKey], arguments: { product_id: `synthetic-${account.label}` } })
  const nameFor = (result, account) => result.value.active_tools.find(entry => entry.original_name === definition.name &&
    entry.authorization_refs.includes(refs[account.connectionKey]))?.name
  return { runtime, session, accounts: selectedAccounts, requests, errors, runs, invocations, start, end, search, business, nameFor }
}

for (const selected of [1, 2]) test(`real SDK HTTP ${selected === 1 ? 'single-target' : 'cross-system'} exact cached reuse uses current runs and no second-turn search`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, selected)
  await f.start(1)
  assert.equal(f.requests.filter(entry => entry.path.endsWith('/turns')).length, 0)
  const names = new Map()
  for (const account of f.accounts) {
    const found = await f.search(account)
    assert.equal(found.isError, false, f.errors.map(String).join('\n'))
    const name = f.nameFor(found, account)
    assert.ok(name)
    names.set(account.label, name)
    assert.equal((await f.business(account, name)).isError, false, f.errors.map(String).join('\n'))
  }
  if (selected === 2) assert.notEqual(names.get('A'), names.get('B'), 'same-name cross-system declarations have distinct model handles')
  const firstRuns = new Set([...f.invocations.values()].map(entry => entry.runId))
  await f.end(); await f.start(2)
  assert.equal(f.runtime.getSessionToolState(f.session.id).active_tools.length, 0)
  assert.equal(f.requests.filter(entry => entry.path.endsWith('/turns')).length, selected, 'a new message itself creates no business run')
  for (const account of [...f.accounts].reverse()) {
    const prepared = await f.search(account, true)
    assert.equal(prepared.isError, false, f.errors.map(String).join('\n'))
    assert.equal(prepared.value.authorizations[0].source, 'cache')
    assert.equal(prepared.value.preparation.business_operation_performed, false)
    assert.equal(prepared.value.contexts[0].context.instructions, `Current synthetic instructions for ${account.label}, turn 2.`)
    assert.ok(prepared.value.tool_schemas.some(entry => entry.name === names.get(account.label)))
    assert.equal((await f.business(account, names.get(account.label))).isError, false, f.errors.map(String).join('\n'))
  }
  assert.equal(f.requests.filter(entry => entry.path.endsWith('/capabilities/search')).length, selected)
  assert.equal(f.requests.filter(entry => entry.path.endsWith('/turns')).length, selected * 2)
  assert.equal(f.invocations.size, selected * 2)
  assert.ok([...f.invocations.values()].filter(entry => entry.turn === 2).every(entry => !firstRuns.has(entry.runId)))
  assert.deepEqual(f.requests.filter(entry => entry.path === '/agent-api/v1/tool-invocations').map(entry => entry.account),
    [...f.accounts, ...[...f.accounts].reverse()].map(entry => entry.label))
  assert.ok(f.requests.every(entry => entry.account !== 'C'))
  assert.equal(f.requests.some(entry => entry.path.endsWith('/resume')), false, 'new read operations are not original-invocation recovery')
  assert.deepEqual(f.errors, [])
  await f.end()
})
