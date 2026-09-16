import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  createMemoryConversationArchiveStore, createMemorySessionTaskStore, createFileSessionTaskStore, createFileSessionScopeStore, createFileInvocationStore } from '../lib/index.js'
import { turnResponse, userMessage } from './helpers/mock-host.mjs'

const sdkDist = process.env.BAILINGHUB_SDK_DIST ?? 'bailinghub-mcp-server/sdk'
const moduleUrl = path => path.startsWith('file:') ? path
  : path.startsWith('/') || path.startsWith('.') ? pathToFileURL(resolve(path)).href : path
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = 'b'.repeat(64)
const definition = {
  name: 'product_query', description: 'Query one synthetic product.',
  input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  scope: 'product.write', risk: 'high', approval_required: true, readonly: false, idempotent: true,
}

async function until(condition) {
  const deadline = Date.now() + 2_000
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), 'synthetic HTTP completion did not settle')
}

// Actual SDK connection selection, binding checks and HTTP serialization are used;
// the service is synthetic and does not access a Core repository or business data.
async function fixture(t, selected = 2, settings = {}) {
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
  const sessionId = `task-control-${selected}`
  const conversationId = `dsh.conversation.${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`
  const taskId = uuid(900)
  const taskBinding = { schema_version: 'bailing.agent-task-binding.v1', task_id: taskId, scope_hash: 'f'.repeat(64) }
  const control = { state: 'active', required: true, memberCount: selected, networkFailed: null, memberChanged: null, receiptMismatch: false, lateTurn: null, terminal: false, loseAck: false, receiptUnavailable: false }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-task-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stores = { scopeStore: createFileSessionScopeStore({ directory: join(directory, 'scopes') }),
    invocationStore: Object.hasOwn(settings, 'invocationStore') ? settings.invocationStore : createFileInvocationStore({ directory: join(directory, 'invocations') }),
    taskStore: settings.taskStore ?? createFileSessionTaskStore({ directory: join(directory, 'tasks') }),
    archiveStore: createMemoryConversationArchiveStore() }
  const caps = { schema_version: 'bailing.agent-task-control-capabilities.v1', supported: true, mode: 'required',
    task_schema: 'bailing.agent-task.v1', metering: 'write_invocation', same_hub_only: true, controls: ['pause', 'resume', 'cancel'], inspect_invocation: true }
  const receiptCaps = { schema_version: 'bailing.agent-invocation-inspection-capabilities.v1', receipt_schema: 'bailing.agent-invocation-receipt.v1', read_only: true }
  const invocationResult = (id, account, terminal = control.terminal) => ({ schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: id,
    route: account.route, tool: definition.name, state: terminal ? 'executed' : 'awaiting_approval', ok: terminal, auto_retry_allowed: false,
    ...(terminal ? {} : control.retryDelay ? { state: 'rejected_before_dispatch', auto_retry_allowed: true, retry_after_ms: control.retryDelay } : { approval_id: 1 }), text: 'Synthetic governed result.' })
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
      let result
      if (path === '/agent-api/v1/task-control/capabilities') {
        result = { ...caps, mode: control.required ? 'required' : 'optional' }
      } else if (path === '/agent-api/v1/tool-invocations/inspection-capabilities') {
        if (control.inspectionUnsupported) { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_found' })); return }
        result = receiptCaps
      } else if (path === `/agent-api/v1/tasks/${taskId}`) {
        assert.equal(request.method, 'GET')
        const query = new URL(request.url, 'http://127.0.0.1').searchParams
        assert.equal(query.get('workspace'), account.route)
        assert.equal(query.get('client_conversation_id'), conversationId)
        if (control.networkFailed === account.label) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'TASK_UNAVAILABLE', message: 'Synthetic unavailable.' })); return }
        result = { schema_version: 'bailing.agent-task.v1', task_id: taskId, state: control.state, revision: 1, ledger_sequence: invocations.size + 1,
          scope_hash: taskBinding.scope_hash, member_count: control.memberCount,
          member: { session_id: control.memberChanged === account.label ? uuid(999) : account.sessionId, client_app_id: account.clientAppId,
            workspace: account.route, client_conversation_id: conversationId, allowed_tools: [definition.name] },
          policy: { max_write_calls: 2, max_concurrent: 1, expires_at: null },
          counters: { write_reserved: 0, write_consumed: invocations.size, active_permits: 0 },
          metering: 'write_invocation', snapshot_is_dispatch_permission: false }
      } else if (/^\/agent-api\/v1\/tool-invocations\/[a-f0-9]{64}(?:\/(?:resume|receipt))?$/.test(path)) {
        const id = path.split('/')[4]
        const original = invocations.get(id)
        assert.ok(original)
        assert.equal(account.label, original.account)
        if (path.endsWith('/resume')) {
          assert.equal(request.method, 'POST')
          assert.equal(control.state, 'active')
          if (control.lateResume) await control.lateResume
          control.terminal = true
          if (control.loseResumeAck) { response.destroy(); return }
          result = invocationResult(id, account)
        } else {
          assert.equal(request.method, 'GET')
          if (control.lateReceipt) await control.lateReceipt
          if (control.receiptUnavailable) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'agent_runtime_unavailable', message: 'Synthetic unavailable receipt.' })); return }
          result = { schema_version: 'bailing.agent-invocation-receipt.v1', read_only: true, business_operation_performed: false,
            invocation_id: id, agent_run_id: control.receiptMismatch ? uuid(998) : original.runId, route: account.route, tool: definition.name,
            observed_at: new Date(now).toISOString(), result: control.noReceiptResult ? null : invocationResult(id, account), result_source: control.noReceiptResult ? 'none' : 'job', dispatch_state: control.dispatchState ?? 'not_dispatched',
            approval: { status: 'approved', approval_id: 1 }, journal_state: 'absent' }
        }
      } else if (path === '/agent-auth/v1/session') {
        assert.equal(request.method, 'GET')
        if (control.lateStatus?.account === account.label) await control.lateStatus.promise
        if (control.statusNetworkFailed === account.label) { response.writeHead(control.statusFailureCode ?? 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'agent_runtime_unavailable', message: 'Synthetic identity probe unavailable.' })); return }
        result = { session_id: account.sessionId, client_app_id: account.clientAppId, device_label: 'synthetic cross-turn fixture',
          principal: { subject: `fixture-${account.label}` }, on_behalf_of: `fixture-${account.label}`,
          allowed_routes: control.revoked === account.label ? [] : [account.route], created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 3_600_000).toISOString(), refresh_expires_at: new Date(now + 86_400_000).toISOString() }
      } else if (path === `/agent-api/v1/workspaces/${account.route}/turns`) {
        assert.equal(request.method, 'POST')
        assert.ok([1, 2, 3].includes(currentTurn))
        assert.deepEqual(body.task_binding, control.unmanaged ? undefined : taskBinding)
        if (control.lateTurn) await control.lateTurn
        const key = `${account.label}:${body.client_turn_id}`
        let runId = runsByTurn.get(key)
        if (!runId) {
          runId = uuid(++nextRun)
          runsByTurn.set(key, runId)
          runs.set(runId, { account: account.label, agentSessionId: account.sessionId, route: account.route,
            turn: currentTurn, request: structuredClone(body) })
        } else assert.deepEqual(body, runs.get(runId).request)
        result = { ...turnResponse({ runId, tools: [], capabilityRevision: revision }), ...(control.unmanaged ? {} : { task_binding: taskBinding }) }
        result.context.instructions = `Current synthetic instructions for ${account.label}, turn ${currentTurn}.`
        result.context.knowledge = [{ title: 'Synthetic policy', excerpt: `Policy revision for turn ${currentTurn}.` }]
      } else if (path === `/agent-api/v1/workspaces/${account.route}/capabilities/search`) {
        assert.equal(request.method, 'POST')
        assert.ok(currentTurn >= 1)
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
        if (control.loseAck) { response.destroy(); return }
        result = invocationResult(body.invocation_id, account)
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
  settings.configureTransport?.(transport)
  let runtime, session, agent, refs
  const launch = async (history) => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(CommandRuntime, {})
    await ctx.plugin(createAgentClientPlugin({ transport, toolLifecycle: 'session', ...stores,
      recovery: { maxAttempts: 1, maxWaitMilliseconds: 1000, pollIntervalMilliseconds: 1, now: () => now + (control.clockOffset ?? 0) } }), config)
    runtime = ctx.get('bailingHubAgentClient')
    session = Session.create(sessionId, history ?? [])
    agent = { id: session.id, session }
    scope = createScope(runtime.ctx, agent); agent.ctx = scope.ctx
    runtime.observeSession(session)
    const chosen = history ? await runtime.restoreSessionScope(session.id)
      : await runtime.setSessionScope(session.id, { connectionKeys: selectedAccounts.map(account => account.connectionKey) })
    refs = Object.fromEntries(chosen.authorizations.map(value => [value.connectionKey, value.authorizationRef]))
  }
  await launch()
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
    if (activeTargets) {
      await until(() => requests.filter(entry => entry.path.endsWith('/complete')).length >= completedBefore + activeTargets)
      await until(() => runtime.statesBySessionId.get(session.id)?.currentRun?.status === 'completed')
      // The synthetic archive endpoint deliberately answers 404. Wait for the
      // event-driven sync to finish so an idle-action counter excludes that POST.
      await until(() => runtime.conversationOutbox.status(session.id).state === 'unsupported')
    }
  }
  const search = (account, cached = false) => execute('search_business_capabilities', { query: 'Query the known synthetic product.',
    ...(selected > 1 ? { authorization_ref: refs[account.connectionKey] } : {}), ...(cached ? { tool_name: definition.name } : {}) })
  const business = (account, name) => execute(name, selected === 1 ? { product_id: `synthetic-${account.label}` }
    : { authorization_ref: refs[account.connectionKey], arguments: { product_id: `synthetic-${account.label}` } })
  const nameFor = (result, account) => result.value.active_tools.find(entry => entry.original_name === definition.name &&
    entry.authorization_refs.includes(refs[account.connectionKey]))?.name
  return { get runtime() { return runtime }, get session() { return session }, accounts: selectedAccounts, requests, errors, runs, invocations, start, end, search, business, nameFor,
    taskId, taskBinding, control, stores, transport, execute, bind: () => runtime.setSessionTaskBinding(session, { taskId }),
    reopen: async () => { const history = structuredClone(session.events); await scope.dispose(); await ctx.fiber.dispose(); await launch(history) } }
}


const requestCount = (f, suffix) => f.requests.filter(value => value.path.endsWith(suffix)).length

for (const statusCode of [503, 429]) test(`real Session + SDK coordinate read retries HTTP ${statusCode} without runs, business calls or scope locking`, async t => {
  const f = await fixture(t)
  const scopeBefore = await f.stores.scopeStore.load(f.session.id)
  const initial = await f.runtime.getSessionTaskCoordinates(f.session)
  assert.equal(initial.state, 'ready', JSON.stringify(initial))
  assert.equal(initial.scopeLocked, false)
  assert.deepEqual(initial.members.map(m => m.agentSessionId), f.accounts.map(a => a.sessionId))
  f.control.statusNetworkFailed = 'B'; f.control.statusFailureCode = statusCode
  const failed = await f.runtime.getSessionTaskCoordinates(f.session)
  assert.equal(failed.state, 'unavailable', JSON.stringify(failed))
  assert.equal(failed.reason, 'agent_transport_unavailable')
  assert.equal(Object.hasOwn(failed, 'members'), false)
  f.control.statusNetworkFailed = null
  assert.deepEqual(await f.runtime.getSessionTaskCoordinates(f.session), initial)
  assert.deepEqual(await f.stores.scopeStore.load(f.session.id), scopeBefore)
  assert.equal(await f.stores.taskStore.load(f.session.id), null)
  assert.equal(requestCount(f, '/turns'), 0)
  assert.equal(f.invocations.size, 0)
  assert.equal(f.requests.some(r => r.method !== 'GET'), false)
  assert.deepEqual(f.errors, [])
})

const receiptCount = f => f.requests.filter(value => /^\/agent-api\/v1\/tool-invocations\/[a-f0-9]{64}\/receipt$/.test(value.path) && value.method === 'GET').length
async function write(f, account = f.accounts[0]) {
  const found = await f.search(account)
  assert.equal(found.isError, false, JSON.stringify(found) + f.errors.map(String))
  const name = f.nameFor(found, account)
  assert.ok(name, JSON.stringify(found))
  const result = await f.business(account, name)
  assert.equal(result.isError, false, JSON.stringify(result) + f.errors.map(String))
  return { name, id: [...f.invocations.keys()].at(-1), result }
}

test('real Session + SDK managed task is lazy, observes approved receipts without resume, and preserves declarations across turns', async t => {
  const f = await fixture(t)
  assert.equal((await f.bind()).state, 'active')
  assert.equal(requestCount(f, '/turns'), 0)
  await f.start(1)
  assert.equal(requestCount(f, '/turns'), 0)
  const first = await write(f)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(receiptCount(f), 1)
  const raw = await f.stores.invocationStore.load(f.session.id)
  assert.equal(raw.schema, 'bailing.agent-invocations.v2')
  assert.deepEqual(raw.entries[0].taskBinding, f.taskBinding)
  assert.ok(f.requests.filter(value => value.path.includes('/tasks/')).some(value => value.account === 'B'))
  const searches = requestCount(f, '/capabilities/search')
  await f.end(); await f.start(2)
  const prepared = await f.search(f.accounts[0], true)
  assert.equal(prepared.isError, false, JSON.stringify(prepared))
  assert.equal(prepared.value.authorizations[0].source, 'cache')
  assert.equal(requestCount(f, '/capabilities/search'), searches)
  assert.equal(requestCount(f, '/turns'), 2)
  assert.equal(f.invocations.size, 1)
  const resumed = await f.execute('resume_governed_tool_invocation', { invocation_id: first.id })
  assert.equal(resumed.isError, false, JSON.stringify(resumed))
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('durable real Session reopen restores exact task/journal and uses GET inspect while cancelled without creating runs', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const { id } = await write(f)
  await f.end(); await f.reopen()
  f.control.state = 'cancelled'
  const turns = requestCount(f, '/turns')
  const resumed = requestCount(f, '/resume')
  const restored = await f.runtime.restoreSessionTaskBinding(f.session)
  assert.equal(restored.task_state, 'cancelled')
  assert.deepEqual(restored.task_binding, f.taskBinding)
  assert.equal((await f.runtime.restoreSessionInvocations(f.session.id)).state, 'ready')
  assert.equal(requestCount(f, '/turns'), turns)
  await f.start(2)
  f.control.terminal = true
  const result = await f.execute('inspect_governed_tool_invocation', { invocation_id: id })
  assert.equal(result.isError, false, JSON.stringify(result) + f.errors.map(String))
  assert.equal(result.value.result.state, 'executed')
  assert.equal((await f.runtime.getSessionTaskState(f.session)).task_state, 'cancelled')
  assert.equal(requestCount(f, '/turns'), turns)
  assert.equal(requestCount(f, '/resume'), resumed)
  const stopped = await f.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(stopped.isError, true)
  assert.equal(stopped.meta.bailinghub.feedback.code, 'TASK_CANCELLED')
  assert.equal(stopped.meta.bailinghub.feedback.next_action, 'inspect_task')
  assert.deepEqual(f.errors, [])
})

test('required task cannot be omitted; a partial selected set or changed own member never binds', async t => {
  const f = await fixture(t)
  await f.start(1)
  const blocked = await f.search(f.accounts[0])
  assert.equal(blocked.value.authorizations[0].feedback.code, 'TASK_REQUIRED')
  assert.equal(requestCount(f, '/turns'), 0)
  f.control.memberCount = 3
  await assert.rejects(f.bind(), error => ['TASK_MEMBER_MISMATCH', 'TASK_RECORD_INVALID'].includes(error.publicCode))
  assert.equal(await f.stores.taskStore.load(f.session.id), null)
  f.control.memberCount = 2; f.control.memberChanged = 'B'
  await assert.rejects(f.bind(), error => ['TASK_MEMBER_MISMATCH', 'TASK_RECORD_INVALID'].includes(error.publicCode))
  assert.equal(requestCount(f, '/turns'), 0)
  assert.equal(f.invocations.size, 0)
  assert.deepEqual(f.errors, [])
})

test('whole-group network failure preserves binding and blocks dispatch until original group is revalidated', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const found = await f.search(f.accounts[0]); const name = f.nameFor(found, f.accounts[0])
  f.control.networkFailed = 'B'
  const failed = await f.business(f.accounts[0], name)
  assert.equal(failed.isError, true)
  assert.equal(f.invocations.size, 0)
  assert.deepEqual((await f.stores.taskStore.load(f.session.id)).entries[0].taskBinding, f.taskBinding)
  f.control.networkFailed = null
  assert.equal((await f.runtime.restoreSessionTaskBinding(f.session)).task_state, 'active')
  assert.equal(f.invocations.size, 0)
  assert.equal((await f.business(f.accounts[0], name)).isError, false)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('each managed dispatch probes both original members once; cached support never skips fresh task GETs', async t => {
  const f = await fixture(t)
  f.control.terminal = true
  await f.bind(); await f.start(1)
  const found = await f.search(f.accounts[0]); const name = f.nameFor(found, f.accounts[0])
  for (let call = 0; call < 2; call++) {
    const offset = f.requests.length
    assert.equal((await f.business(f.accounts[0], name)).isError, false)
    const probes = f.requests.slice(offset)
    for (const account of f.accounts) {
      assert.equal(probes.filter(value => value.account === account.label && value.path === '/agent-auth/v1/session').length, 1)
      assert.equal(probes.filter(value => value.account === account.label && value.path === `/agent-api/v1/tasks/${f.taskId}`).length, 1)
    }
  }
  const beforeGet = f.requests.filter(value => value.path.includes('/tasks/')).length
  await f.runtime.getSessionTaskState(f.session)
  await f.runtime.restoreSessionTaskBinding(f.session)
  assert.equal(f.requests.filter(value => value.path.includes('/tasks/')).length - beforeGet, 4)
  assert.equal(f.invocations.size, 2)
  assert.deepEqual(f.errors, [])
})

for (const revoked of ['A', 'B']) test(`revoking original ${revoked} after a successful managed dispatch blocks the next cached tool call`, async t => {
  const f = await fixture(t)
  f.control.terminal = true
  await f.bind(); await f.start(1)
  const { name } = await write(f)
  f.control.revoked = revoked
  assert.equal((await f.business(f.accounts[0], name)).isError, true)
  assert.equal(f.invocations.size, 1)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual((await f.stores.taskStore.load(f.session.id)).entries[0].taskBinding, f.taskBinding)
  assert.deepEqual(f.errors, [])
})

test('same runtime recovers an offline whole-scope identity probe before its next managed dispatch', async t => {
  const f = await fixture(t)
  f.control.terminal = true
  await f.bind(); await f.start(1)
  const { name } = await write(f)
  f.control.statusNetworkFailed = 'B'
  assert.equal((await f.business(f.accounts[0], name)).isError, true)
  assert.equal(f.invocations.size, 1)
  f.control.statusNetworkFailed = null
  assert.equal((await f.business(f.accounts[0], name)).isError, false)
  assert.equal(f.invocations.size, 2)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.deepEqual(f.errors, [])
})

for (const savedBeforeFailure of [false, true]) test(`task CAS failure blocks new runs; explicit restore handles ${savedBeforeFailure ? 'lost save acknowledgement' : 'unsaved original association'}`, async t => {
  const base = createMemorySessionTaskStore()
  let fail = true
  const taskStore = { load: id => base.load(id), save: async (...args) => {
    const result = savedBeforeFailure || !fail ? await base.save(...args) : null
    if (fail) throw Object.assign(new Error('Synthetic CAS failed'), { code: 'TASK_STORE_CONFLICT' })
    return result
  } }
  const f = await fixture(t, 1, { taskStore })
  await assert.rejects(f.bind(), error => error.publicCode === 'TASK_STORE_CONFLICT')
  await f.start(1)
  assert.equal((await f.runtime.getSessionTaskState(f.session)).state, 'storage_error')
  await f.search(f.accounts[0])
  assert.equal(requestCount(f, '/turns'), 0)
  fail = false
  await f.runtime.restoreSessionTaskBinding(f.session)
  assert.deepEqual((await f.runtime.getSessionTaskState(f.session)).task_binding, f.taskBinding)
  assert.equal(requestCount(f, '/turns'), 0)
  await f.end(); await f.start(2)
  await write(f)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('immutable task and original receipt identity reject rebinding without a replacement write', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const { id } = await write(f)
  await assert.rejects(f.runtime.setSessionTaskBinding(f.session, { taskId: uuid(901) }), error => error.publicCode === 'TASK_BINDING_CONFLICT')
  await f.runtime.restoreSessionTaskBinding(f.session)
  f.control.receiptMismatch = true
  const result = await f.execute('inspect_governed_tool_invocation', { invocation_id: id })
  assert.equal(result.isError, true)
  assert.equal(result.meta.bailinghub.feedback.code, 'invocation_binding_conflict')
  assert.equal(f.invocations.size, 1)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

test('late startTurn response cannot restore a cancelled Session turn or dispatch', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  let release
  f.control.lateTurn = new Promise(resolve => { release = resolve })
  const pending = f.search(f.accounts[0])
  await until(() => requestCount(f, '/turns') === 1)
  await f.end()
  f.control.state = 'cancelled'
  release()
  const result = await pending
  assert.ok(result.isError || result.value.authorizations[0].state === 'unavailable')
  assert.equal(f.runtime.getSessionToolState(f.session.id).active_tools.length, 0)
  assert.equal(f.invocations.size, 0)
  assert.deepEqual(f.errors, [])
})

test('task/journal storage failures and unsaved archive events take priority over cancelled task state', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  f.control.state = 'cancelled'
  f.runtime.invocationJournal.failures.set(f.session.id, 'invocation_store_conflict')
  let state = await f.runtime.getSessionTaskState(f.session)
  assert.equal(state.state, 'storage_error')
  assert.equal(state.task_state, 'cancelled')
  f.runtime.invocationJournal.failures.delete(f.session.id)
  f.runtime.conversationOutbox.status = () => ({ state: 'storage_error', unsavedEvents: 2, pendingEvents: 2 })
  state = await f.runtime.getSessionTaskState(f.session)
  assert.equal(state.state, 'storage_error')
  assert.equal(state.local.unsavedEvents, 2)
  assert.equal(state.task_state, 'cancelled')
  assert.equal(requestCount(f, '/turns'), 0)
})

test('failed optional-mode explicit association cannot silently return to unmanaged execution', async t => {
  const f = await fixture(t)
  f.control.required = false; f.control.networkFailed = 'B'
  await assert.rejects(f.bind())
  f.control.networkFailed = null
  await f.start(1)
  await f.search(f.accounts[0])
  assert.equal(requestCount(f, '/turns'), 0)
  assert.equal(f.invocations.size, 0)
  assert.equal((await f.runtime.getSessionTaskState(f.session)).task_binding, null)
  await f.bind()
  await f.end(); await f.start(2)
  await write(f)
})

test('paused approved operation can only be observed; explicit original resume succeeds after active state returns', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const { id, name } = await write(f)
  f.control.state = 'paused'
  assert.equal((await f.execute('inspect_governed_tool_invocation', { invocation_id: id })).isError, false)
  assert.equal(requestCount(f, '/resume'), 0)
  const continuation = await f.execute('resume_governed_tool_invocation', { invocation_id: id })
  assert.equal(continuation.meta.bailinghub.feedback.code, 'TASK_PAUSED')
  assert.equal(continuation.meta.bailinghub.feedback.next_action, 'inspect_task')
  const newWrite = await f.business(f.accounts[0], name)
  assert.equal(newWrite.meta.bailinghub.feedback.code, 'TASK_PAUSED')
  assert.equal(f.invocations.size, 1)
  assert.equal(requestCount(f, '/resume'), 0)
  f.control.state = 'active'
  assert.equal((await f.execute('resume_governed_tool_invocation', { invocation_id: id })).isError, false)
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('lost write acknowledgement survives full reopen and is resolved by original GET without a replacement', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const found = await f.search(f.accounts[0]); const name = f.nameFor(found, f.accounts[0])
  f.control.loseAck = true; f.control.receiptUnavailable = true
  const lost = await f.business(f.accounts[0], name)
  assert.equal(lost.isError, true)
  assert.equal(f.invocations.size, 1)
  const id = [...f.invocations.keys()][0]
  const record = (await f.stores.invocationStore.load(f.session.id)).entries[0]
  assert.equal(record.lastKnownState, 'unknown')
  assert.deepEqual(record.taskBinding, f.taskBinding)
  await f.end(); await f.reopen()
  f.control.receiptUnavailable = false; f.control.terminal = true
  const turns = requestCount(f, '/turns')
  await f.runtime.restoreSessionTaskBinding(f.session)
  await f.runtime.restoreSessionInvocations(f.session.id)
  await f.start(2)
  const observed = await f.execute('inspect_governed_tool_invocation', { invocation_id: id })
  assert.equal(observed.isError, false, JSON.stringify(observed))
  assert.equal(observed.value.result.state, 'executed')
  assert.equal(requestCount(f, '/turns'), turns)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.invocations.size, 1)
  assert.equal((await f.stores.invocationStore.load(f.session.id)).entries[0].runId, record.runId)
  assert.deepEqual(f.errors, [])
})

// Host buttons act on the same persisted operation as model recovery tools.
// They must not fabricate a user message, an active turn or another business run.
const hostSchema = 'bailing.agent-session-invocation-action.v1'
const hostAction = (f, operation, id, options) => f.runtime[operation === 'inspect'
  ? 'inspectSessionInvocation' : 'resumeSessionInvocation'](f.session, id, options)
function assertHostReply(reply, operation, id, state = 'ready') {
  // ready is action/receipt availability, not task activation or business success.
  assert.equal(reply.schema, hostSchema, JSON.stringify(reply))
  assert.equal(reply.operation, operation, JSON.stringify(reply))
  assert.equal(reply.invocation_id, id, JSON.stringify(reply))
  assert.equal(reply.state, state, JSON.stringify(reply))
  assert.equal(typeof reply.resume_dispatched, 'boolean')
  if (state !== 'ready') {
    assert.equal(Object.hasOwn(reply, 'receipt'), false, 'a failed action must not expose an actionable receipt')
    assert.equal(Object.hasOwn(reply, 'result'), false, 'a failed action must not expose a successful result')
  }
}
async function idleOriginal(t, settings = {}) {
  const f = await fixture(t, 2, settings)
  await f.bind(); await f.start(1)
  const { id } = await write(f)
  await f.end()
  return { f, id }
}

for (const reopen of [false, true]) test(`host idle inspect ${reopen ? 'after durable reopen' : 'without another user turn'} reads only the original approved receipt`, async t => {
  const { f, id } = await idleOriginal(t)
  if (reopen) await f.reopen()
  const before = { requests: f.requests.length, turns: requestCount(f, '/turns'), events: structuredClone(f.session.events),
    tools: structuredClone(f.runtime.getSessionToolState(f.session.id).active_tools), journal: await f.stores.invocationStore.load(f.session.id) }
  const reply = await hostAction(f, 'inspect', id)
  assertHostReply(reply, 'inspect', id)
  assert.equal(reply.resume_dispatched, false)
  assert.equal(reply.receipt.invocation_id, id)
  assert.equal(reply.receipt.agent_run_id, before.journal.entries[0].runId)
  assert.equal(reply.receipt.approval.status, 'approved')
  assert.equal(reply.receipt.result.state, 'awaiting_approval')
  assert.equal(requestCount(f, '/turns'), before.turns)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.requests.slice(before.requests).every(request => request.method === 'GET'), true)
  assert.deepEqual(f.session.events, before.events)
  assert.deepEqual(f.runtime.getSessionToolState(f.session.id).active_tools, before.tools)
  assert.equal(f.invocations.size, 1)
  assert.equal(f.requests.some(request => request.account === 'C'), false)
  assert.deepEqual(f.errors, [])
})

test('host idle explicit resume inspects first, sends one original POST and subsequent actions only observe', async t => {
  const { f, id } = await idleOriginal(t)
  await f.reopen()
  const offset = f.requests.length
  const reply = await hostAction(f, 'resume', id)
  assertHostReply(reply, 'resume', id)
  assert.equal(reply.resume_dispatched, true)
  assert.equal(reply.result.invocation_id, id)
  assert.equal(reply.result.state, 'executed')
  const actions = f.requests.slice(offset).filter(request => request.path.includes(id))
  assert.equal(actions[0].method, 'GET')
  assert.equal(actions.filter(request => request.method === 'POST').length, 1)
  assert.equal(actions.find(request => request.method === 'POST').path, `/agent-api/v1/tool-invocations/${id}/resume`)
  const observed = await hostAction(f, 'inspect', id)
  assertHostReply(observed, 'inspect', id)
  assert.equal(observed.receipt.result.state, 'executed')
  const repeated = await hostAction(f, 'resume', id)
  assertHostReply(repeated, 'resume', id)
  assert.equal(repeated.resume_dispatched, false)
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

for (const dispatchState of ['attempted', 'unknown']) test(`host resume observes ${dispatchState} original dispatch without issuing another POST`, async t => {
  const { f, id } = await idleOriginal(t)
  f.control.dispatchState = dispatchState
  const before = receiptCount(f)
  for (let n = 0; n < 2; n++) {
    const reply = await hostAction(f, 'resume', id)
    assertHostReply(reply, 'resume', id)
    assert.equal(reply.resume_dispatched, false)
    assert.equal(reply.receipt.dispatch_state, dispatchState)
  }
  assert.equal(receiptCount(f) - before, 2)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host inspect queued behind an explicit resume receives its own read-only response, not the resume response', async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateResume = new Promise(resolve => { release = resolve })
  const resumed = hostAction(f, 'resume', id)
  await until(() => requestCount(f, '/resume') === 1)
  const receipts = receiptCount(f)
  const inspected = hostAction(f, 'inspect', id)
  release()
  const [resumeReply, inspectReply] = await Promise.all([resumed, inspected])
  assertHostReply(resumeReply, 'resume', id)
  assertHostReply(inspectReply, 'inspect', id)
  assert.equal(resumeReply.resume_dispatched, true)
  assert.equal(inspectReply.resume_dispatched, false)
  assert.equal(inspectReply.receipt.result.state, 'executed')
  assert.equal(receiptCount(f) > receipts, true)
  assert.equal(requestCount(f, '/resume'), 1)
  assert.deepEqual(f.errors, [])
})

for (const managed of [true, false]) for (const first of ['model', 'host']) test(`${first} then ${first === 'model' ? 'host' : 'model'} continuation of one original ${managed ? 'managed' : 'unmanaged'} operation share serialization and never POST twice`, async t => {
  const f = await fixture(t)
  if (managed) await f.bind()
  else { f.control.required = false; f.control.unmanaged = true; f.control.retryDelay = 5_000 }
  await f.start(1)
  const { id } = await write(f)
  if (!managed) { f.control.retryDelay = 0; f.control.clockOffset = 6_000 }
  let release
  f.control.lateResume = new Promise(resolve => { release = resolve })
  let model, host
  if (first === 'model') model = f.execute('resume_governed_tool_invocation', { invocation_id: id })
  else host = hostAction(f, 'resume', id)
  await until(() => requestCount(f, '/resume') === 1)
  if (first === 'model') host = hostAction(f, 'resume', id)
  else model = f.execute('resume_governed_tool_invocation', { invocation_id: id })
  release()
  const [modelReply, hostReply] = await Promise.all([model, host])
  assert.equal(modelReply.isError, false, JSON.stringify(modelReply))
  assertHostReply(hostReply, 'resume', id)
  assert.equal(hostReply.resume_dispatched, first === 'host')
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

for (const operation of ['inspect', 'resume']) test(`host ${operation} cancellation before a late receipt exposes no result or dispatch`, async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateReceipt = new Promise(resolve => { release = resolve })
  const before = receiptCount(f)
  const controller = new AbortController()
  const pending = hostAction(f, operation, id, { signal: controller.signal })
  await until(() => receiptCount(f) > before)
  controller.abort(); release()
  const reply = await pending
  assertHostReply(reply, operation, id, 'cancelled')
  assert.equal(reply.resume_dispatched, false)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.runtime.getSessionToolState(f.session.id).active_tools.length, 0)
  assert.deepEqual(f.errors, [])
})

test('disposing a runtime during host receipt inspection cannot revive an ended turn or return success', async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateReceipt = new Promise(resolve => { release = resolve })
  const before = receiptCount(f)
  const pending = hostAction(f, 'inspect', id)
  await until(() => receiptCount(f) > before)
  const disposed = f.runtime.dispose()
  release()
  const reply = await pending
  await disposed
  assertHostReply(reply, 'inspect', id, 'cancelled')
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

test('host receipt inspection recovers offline original-member validation in the same idle runtime', async t => {
  const { f, id } = await idleOriginal(t)
  await f.reopen()
  const before = { scope: await f.stores.scopeStore.load(f.session.id), journal: await f.stores.invocationStore.load(f.session.id) }
  f.control.statusNetworkFailed = 'B'
  for (let n = 0; n < 2; n++) assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'unavailable')
  assert.deepEqual(await f.stores.scopeStore.load(f.session.id), before.scope)
  assert.deepEqual(await f.stores.invocationStore.load(f.session.id), before.journal)
  f.control.statusNetworkFailed = null
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.deepEqual(f.errors, [])
})

for (const revoked of ['A', 'B']) for (const status of [401, 403]) test(`host action rejects original ${revoked} after authoritative HTTP ${status}; it cannot fall back to the other member`, async t => {
  const { f, id } = await idleOriginal(t)
  f.control.statusNetworkFailed = revoked; f.control.statusFailureCode = status
  const before = receiptCount(f)
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'blocked')
  assertHostReply(await hostAction(f, 'resume', id), 'resume', id, 'blocked')
  assert.equal(receiptCount(f), before)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.equal(f.invocations.size, 1)
  assert.equal(f.requests.some(request => request.account === 'C'), false)
  assert.deepEqual(f.errors, [])
})

for (const taskState of ['paused', 'cancelled']) test(`host ${taskState} task retains receipt inspection but blocks explicit continuation`, async t => {
  const { f, id } = await idleOriginal(t)
  f.control.state = taskState
  const observed = await hostAction(f, 'inspect', id)
  assertHostReply(observed, 'inspect', id)
  const resumed = await hostAction(f, 'resume', id)
  assertHostReply(resumed, 'resume', id, 'blocked')
  assert.equal(resumed.feedback?.code ?? resumed.reason, `TASK_${taskState.toUpperCase()}`)
  assert.equal(resumed.resume_dispatched, false)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

for (const failure of ['journal', 'unsaved_events', 'recovery_gap']) test(`host local ${failure} takes priority over paused task and suppresses payload`, async t => {
  const { f, id } = await idleOriginal(t)
  f.control.state = 'paused'
  if (failure === 'journal') f.runtime.invocationJournal.failures.set(f.session.id, 'invocation_store_conflict')
  else if (failure === 'unsaved_events') f.runtime.conversationOutbox.status = () => ({ state: 'storage_error', unsavedEvents: 1, pendingEvents: 1 })
  else f.runtime.archiveStatusWithCoverage = () => ({ state: 'recovery_gap', unsavedEvents: 0, pendingEvents: 0 })
  const state = failure === 'recovery_gap' ? 'recovery_gap' : 'storage_error'
  const before = receiptCount(f)
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, state)
  assertHostReply(await hostAction(f, 'resume', id), 'resume', id, state)
  assert.equal(receiptCount(f), before)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

test('host final original-result save failure reports storage_error with dispatched status instead of success', async t => {
  const base = createMemoryInvocationStore()
  let fail = false
  const invocationStore = { load: id => base.load(id), save: (...args) => {
    if (fail) throw Object.assign(new Error('Synthetic journal save failure'), { code: 'INVOCATION_STORE_CONFLICT' })
    return base.save(...args)
  } }
  const { f, id } = await idleOriginal(t, { invocationStore })
  // The initial inspected receipt is unchanged; only the executed result needs a write.
  fail = true
  const reply = await hostAction(f, 'resume', id)
  assertHostReply(reply, 'resume', id, 'storage_error')
  assert.equal(reply.resume_dispatched, true)
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.equal((await base.load(f.session.id)).entries[0].lastKnownState, 'awaiting_approval')
  const second = await hostAction(f, 'resume', id)
  assertHostReply(second, 'resume', id, 'storage_error')
  assert.equal(requestCount(f, '/resume'), 1)
  assert.deepEqual(f.errors, [])
})

test('host empty selected scope has no network request and cannot recover an arbitrary invocation', async t => {
  const f = await fixture(t, 0)
  const id = 'a'.repeat(64)
  const before = f.requests.length
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'blocked')
  assertHostReply(await hostAction(f, 'resume', id), 'resume', id, 'blocked')
  assert.equal(f.requests.length, before)
  assert.equal(f.invocations.size, 0)
  assert.deepEqual(f.errors, [])
})

test('host legacy unmanaged journal stays unmanaged and never invents a task association', async t => {
  const f = await fixture(t)
  f.control.required = false; f.control.unmanaged = true; f.control.retryDelay = 5_000
  await f.start(1)
  const { id } = await write(f)
  await f.end(); await f.reopen()
  const record = await f.stores.invocationStore.load(f.session.id)
  assert.equal(record.entries[0].taskBinding, undefined)
  const offset = f.requests.length
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id)
  assert.equal(await f.stores.taskStore.load(f.session.id), null)
  assert.equal(f.requests.slice(offset).some(request => request.path.startsWith('/agent-api/v1/tasks/')), false)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

test('host without durable invocation storage returns unsupported without guessing history', async t => {
  const { f, id } = await idleOriginal(t)
  f.runtime.invocationJournal.store = null
  const before = f.requests.length
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'unsupported')
  assertHostReply(await hostAction(f, 'resume', id), 'resume', id, 'unsupported')
  assert.equal(f.requests.slice(before).some(request => request.method === 'POST'), false)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.deepEqual(f.errors, [])
})

test('host older SDK without receipt inspection returns unsupported and never falls through to resume', async t => {
  const { f, id } = await idleOriginal(t)
  delete f.transport.inspectInvocation
  const before = receiptCount(f)
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'unsupported')
  assertHostReply(await hostAction(f, 'resume', id), 'resume', id, 'unsupported')
  assert.equal(receiptCount(f), before)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

for (const changed of ['scope', 'task', 'journal']) test(`host rejects a durable ${changed} binding change while the original receipt is in flight`, async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateReceipt = new Promise(resolve => { release = resolve })
  const receipts = receiptCount(f)
  const pending = hostAction(f, 'resume', id)
  await until(() => receiptCount(f) > receipts)
  const store = f.stores[`${changed === 'journal' ? 'invocation' : changed}Store`]
  const load = store.load.bind(store)
  store.load = async sessionId => {
    const record = await load(sessionId)
    if (changed === 'scope') record.revision++
    else if (changed === 'task') record.entries[0].taskBinding.scope_hash = 'e'.repeat(64)
    else record.entries[0].runId = uuid(998)
    return record
  }
  release()
  const reply = await pending
  assertHostReply(reply, 'resume', id, changed === 'journal' ? 'storage_error' : 'blocked')
  assert.equal(reply.resume_dispatched, false)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host empty receipt remains unverified and directs inspection without dispatching', async t => {
  const { f, id } = await idleOriginal(t)
  f.control.noReceiptResult = true
  for (const operation of ['inspect', 'resume']) {
    const reply = await hostAction(f, operation, id)
    assertHostReply(reply, operation, id)
    assert.equal(reply.receipt.result, null)
    assert.equal(reply.receipt.result_source, 'none')
    assert.equal(reply.next_action, 'inspect_original')
    assert.equal(reply.resume_dispatched, false)
  }
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

test('host unsaved events appearing after resume dispatch preserve uncertain dispatch feedback', async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateResume = new Promise(resolve => { release = resolve })
  const pending = hostAction(f, 'resume', id)
  await until(() => requestCount(f, '/resume') === 1)
  f.runtime.conversationOutbox.status = () => ({ state: 'storage_error', unsavedEvents: 1, pendingEvents: 1 })
  release()
  const reply = await pending
  assertHostReply(reply, 'resume', id, 'storage_error')
  assert.equal(reply.resume_dispatched, true)
  assert.equal(reply.feedback.dispatch, 'unknown')
  assert.equal(reply.feedback.original_outcome, 'unverified')
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host task paused after dispatch retains the true original result but cannot continue again', async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateResume = new Promise(resolve => { release = resolve })
  const pending = hostAction(f, 'resume', id)
  await until(() => requestCount(f, '/resume') === 1)
  f.control.state = 'paused'
  release()
  const reply = await pending
  assertHostReply(reply, 'resume', id)
  assert.equal(reply.resume_dispatched, true)
  assert.equal(reply.receipt.result.state, 'executed')
  assert.equal(reply.result.state, 'executed')
  assert.equal((await f.runtime.getSessionTaskState(f.session)).task_state, 'paused')
  const repeated = await hostAction(f, 'resume', id)
  assertHostReply(repeated, 'resume', id, 'blocked')
  assert.equal(repeated.resume_dispatched, false)
  assert.equal(repeated.feedback.code, 'TASK_PAUSED')
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host cancellation after resume dispatch reports cancellation with an unverified original outcome', async t => {
  const { f, id } = await idleOriginal(t)
  let release
  f.control.lateResume = new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const pending = hostAction(f, 'resume', id, { signal: controller.signal })
  await until(() => requestCount(f, '/resume') === 1)
  controller.abort(); release()
  const reply = await pending
  assertHostReply(reply, 'resume', id, 'cancelled')
  assert.equal(reply.resume_dispatched, true)
  assert.equal(reply.feedback.dispatch, 'unknown')
  assert.equal(reply.feedback.original_outcome, 'unverified')
  assert.equal(f.runtime.getSessionToolState(f.session.id).active_tools.length, 0)
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host reading an old rate-limit receipt keeps the expired original retry deadline and can resume once', async t => {
  const f = await fixture(t)
  f.control.retryDelay = 5_000
  await f.bind(); await f.start(1)
  const { id } = await write(f)
  const deadline = (await f.stores.invocationStore.load(f.session.id)).entries[0].retryAt
  assert.ok(deadline > 0)
  await f.end()
  f.control.clockOffset = 6_000
  const reply = await hostAction(f, 'resume', id)
  assertHostReply(reply, 'resume', id)
  assert.equal(reply.resume_dispatched, true)
  assert.equal(reply.result.state, 'executed')
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host lost resume acknowledgement only inspects the same operation on follow-up and does not POST again', async t => {
  const { f, id } = await idleOriginal(t)
  f.control.loseResumeAck = true
  const failed = await hostAction(f, 'resume', id)
  assertHostReply(failed, 'resume', id, 'unavailable')
  assert.equal(failed.resume_dispatched, true)
  assert.equal(failed.feedback.dispatch, 'unknown')
  assert.equal(failed.feedback.next_action, 'inspect_original')
  assert.equal(failed.feedback.original_outcome, 'unverified')
  f.control.loseResumeAck = false
  const observed = await hostAction(f, 'inspect', id)
  assertHostReply(observed, 'inspect', id)
  assert.equal(observed.receipt.result.state, 'executed')
  const repeated = await hostAction(f, 'resume', id)
  assertHostReply(repeated, 'resume', id)
  assert.equal(repeated.resume_dispatched, false)
  assert.equal(requestCount(f, '/resume'), 1)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host old Core without receipt protocol remains unsupported rather than falling back to POST recovery', async t => {
  const f = await fixture(t)
  f.control.required = false; f.control.unmanaged = true; f.control.retryDelay = 5_000
  f.control.inspectionUnsupported = true
  await f.start(1)
  const found = await f.search(f.accounts[0])
  const dispatched = await f.business(f.accounts[0], f.nameFor(found, f.accounts[0]))
  assert.equal(dispatched.isError, false, JSON.stringify(dispatched))
  const id = [...f.invocations.keys()][0]
  assert.ok(id)
  await f.end()
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'unsupported')
  assertHostReply(await hostAction(f, 'resume', id), 'resume', id, 'unsupported')
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.invocations.size, 1)
  assert.deepEqual(f.errors, [])
})

test('host missing original archive reports a recovery gap without creating or repairing an outbox', async t => {
  const { f, id } = await idleOriginal(t)
  await f.reopen()
  let saves = 0
  f.stores.archiveStore.load = async () => null
  const save = f.stores.archiveStore.save.bind(f.stores.archiveStore)
  f.stores.archiveStore.save = (...args) => { saves++; return save(...args) }
  const before = f.requests.length
  assertHostReply(await hostAction(f, 'inspect', id), 'inspect', id, 'recovery_gap')
  assert.equal(saves, 0)
  assert.equal(f.requests.slice(before).some(request => request.method === 'POST'), false)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.deepEqual(f.errors, [])
})

test('host concurrent inspection of two original IDs waits for the same outbox load without reporting a false gap', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const first = await write(f)
  const second = await write(f)
  assert.notEqual(first.id, second.id)
  await f.end(); await f.reopen()
  const load = f.stores.archiveStore.load.bind(f.stores.archiveStore)
  let release, loads = 0
  const loaded = new Promise(resolve => { release = resolve })
  f.stores.archiveStore.load = async id => { loads++; await loaded; return load(id) }
  const firstAction = hostAction(f, 'inspect', first.id)
  await until(() => loads > 0)
  const secondAction = hostAction(f, 'inspect', second.id)
  // Allow the independently validated second invocation to reach the same local load.
  await new Promise(resolve => setTimeout(resolve, 40))
  release()
  const [firstReply, secondReply] = await Promise.all([firstAction, secondAction])
  assertHostReply(firstReply, 'inspect', first.id)
  assertHostReply(secondReply, 'inspect', second.id)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(requestCount(f, '/turns'), 1)
  assert.equal(f.invocations.size, 2)
  assert.deepEqual(f.errors, [])
})

test('host concurrent original-scope validation ending in revocation blocks both original IDs', async t => {
  const f = await fixture(t)
  await f.bind(); await f.start(1)
  const first = await write(f)
  const second = await write(f)
  await f.end(); await f.reopen()
  const load = f.stores.archiveStore.load.bind(f.stores.archiveStore)
  let releaseArchive, releaseIdentity, loads = 0
  const archiveLoad = new Promise(resolve => { releaseArchive = resolve })
  f.stores.archiveStore.load = async id => { loads++; await archiveLoad; return load(id) }
  const firstAction = hostAction(f, 'inspect', first.id)
  await until(() => loads > 0)
  const identityBefore = f.requests.filter(request => request.account === 'B' && request.path === '/agent-auth/v1/session').length
  f.control.lateStatus = { account: 'B', promise: new Promise(resolve => { releaseIdentity = resolve }) }
  const secondAction = hostAction(f, 'inspect', second.id)
  await until(() => f.requests.filter(request => request.account === 'B' && request.path === '/agent-auth/v1/session').length > identityBefore)
  f.control.statusNetworkFailed = 'B'; f.control.statusFailureCode = 403
  releaseArchive(); releaseIdentity()
  const [firstReply, secondReply] = await Promise.all([firstAction, secondAction])
  assertHostReply(firstReply, 'inspect', first.id, 'blocked')
  assertHostReply(secondReply, 'inspect', second.id, 'blocked')
  assert.equal(firstReply.resume_dispatched, false)
  assert.equal(secondReply.resume_dispatched, false)
  assert.equal(requestCount(f, '/resume'), 0)
  assert.equal(f.invocations.size, 2)
  assert.equal(f.requests.some(request => request.account === 'C'), false)
  assert.deepEqual(f.errors, [])
})
