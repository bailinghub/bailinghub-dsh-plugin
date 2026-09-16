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
    invocationStore: createFileInvocationStore({ directory: join(directory, 'invocations') }),
    taskStore: settings.taskStore ?? createFileSessionTaskStore({ directory: join(directory, 'tasks') }),
    archiveStore: createMemoryConversationArchiveStore() }
  const caps = { schema_version: 'bailing.agent-task-control-capabilities.v1', supported: true, mode: 'required',
    task_schema: 'bailing.agent-task.v1', metering: 'write_invocation', same_hub_only: true, controls: ['pause', 'resume', 'cancel'], inspect_invocation: true }
  const receiptCaps = { schema_version: 'bailing.agent-invocation-inspection-capabilities.v1', receipt_schema: 'bailing.agent-invocation-receipt.v1', read_only: true }
  const invocationResult = (id, account, terminal = control.terminal) => ({ schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: id,
    route: account.route, tool: definition.name, state: terminal ? 'executed' : 'awaiting_approval', ok: terminal, auto_retry_allowed: false,
    ...(terminal ? {} : { approval_id: 1 }), text: 'Synthetic governed result.' })
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
          control.terminal = true
          result = invocationResult(id, account)
        } else {
          assert.equal(request.method, 'GET')
          if (control.receiptUnavailable) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'agent_runtime_unavailable', message: 'Synthetic unavailable receipt.' })); return }
          result = { schema_version: 'bailing.agent-invocation-receipt.v1', read_only: true, business_operation_performed: false,
            invocation_id: id, agent_run_id: control.receiptMismatch ? uuid(998) : original.runId, route: account.route, tool: definition.name,
            observed_at: new Date(now).toISOString(), result: invocationResult(id, account), result_source: 'job', dispatch_state: 'not_dispatched',
            approval: { status: 'approved', approval_id: 1 }, journal_state: 'absent' }
        }
      } else if (path === '/agent-auth/v1/session') {
        assert.equal(request.method, 'GET')
        result = { session_id: account.sessionId, client_app_id: account.clientAppId, device_label: 'synthetic cross-turn fixture',
          principal: { subject: `fixture-${account.label}` }, on_behalf_of: `fixture-${account.label}`,
          allowed_routes: [account.route], created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 3_600_000).toISOString(), refresh_expires_at: new Date(now + 86_400_000).toISOString() }
      } else if (path === `/agent-api/v1/workspaces/${account.route}/turns`) {
        assert.equal(request.method, 'POST')
        assert.ok([1, 2, 3].includes(currentTurn))
        assert.deepEqual(body.task_binding, taskBinding)
        if (control.lateTurn) await control.lateTurn
        const key = `${account.label}:${body.client_turn_id}`
        let runId = runsByTurn.get(key)
        if (!runId) {
          runId = uuid(++nextRun)
          runsByTurn.set(key, runId)
          runs.set(runId, { account: account.label, agentSessionId: account.sessionId, route: account.route,
            turn: currentTurn, request: structuredClone(body) })
        } else assert.deepEqual(body, runs.get(runId).request)
        result = { ...turnResponse({ runId, tools: [], capabilityRevision: revision }), task_binding: taskBinding }
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
  let runtime, session, agent, refs
  const launch = async (history) => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(CommandRuntime, {})
    await ctx.plugin(createAgentClientPlugin({ transport, toolLifecycle: 'session', ...stores,
      recovery: { maxAttempts: 1, maxWaitMilliseconds: 1000, pollIntervalMilliseconds: 1 } }), config)
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
    if (activeTargets) await until(() => requests.filter(entry => entry.path.endsWith('/complete')).length >= completedBefore + activeTargets)
  }
  const search = (account, cached = false) => execute('search_business_capabilities', { query: 'Query the known synthetic product.',
    ...(selected > 1 ? { authorization_ref: refs[account.connectionKey] } : {}), ...(cached ? { tool_name: definition.name } : {}) })
  const business = (account, name) => execute(name, selected === 1 ? { product_id: `synthetic-${account.label}` }
    : { authorization_ref: refs[account.connectionKey], arguments: { product_id: `synthetic-${account.label}` } })
  const nameFor = (result, account) => result.value.active_tools.find(entry => entry.original_name === definition.name &&
    entry.authorization_refs.includes(refs[account.connectionKey]))?.name
  return { get runtime() { return runtime }, get session() { return session }, accounts: selectedAccounts, requests, errors, runs, invocations, start, end, search, business, nameFor,
    taskId, taskBinding, control, stores, execute, bind: () => runtime.setSessionTaskBinding(session, { taskId }),
    reopen: async () => { const history = structuredClone(session.events); await scope.dispose(); await ctx.fiber.dispose(); await launch(history) } }
}


const requestCount = (f, suffix) => f.requests.filter(value => value.path.endsWith(suffix)).length
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
