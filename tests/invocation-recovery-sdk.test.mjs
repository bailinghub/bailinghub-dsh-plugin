import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import {
  createAgentClientPlugin, createFileInvocationStore, createFileSessionScopeStore, createMemoryConversationArchiveStore,
} from '../lib/index.js'
import { turnResponse, userMessage } from './helpers/mock-host.mjs'

const sdkDist = process.env.BAILINGHUB_SDK_DIST ?? 'bailinghub-mcp-server/sdk'
const moduleUrl = path => path.startsWith('file:') ? path
  : path.startsWith('/') || path.startsWith('.') ? pathToFileURL(resolve(path)).href : path
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const revision = 'b'.repeat(64)
const definition = {
  name: 'product_update', description: 'Update the title of a synthetic product.',
  input_schema: { type: 'object', properties: { product_id: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false },
  scope: 'product.manage', risk: 'medium', approval_required: true, readonly: false, idempotent: false,
}
const resultBody = result => result.value?.result ?? result.value
const invocationIdFor = result => result.meta?.bailinghub?.feedback?.invocation_id ?? resultBody(result)?.invocation_id

async function waitUntil(condition, errorMessage) {
  const deadline = Date.now() + 2_000
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(condition(), errorMessage)
}

// This fixture exercises a real SDK facade and HTTP serialization. It deliberately
// uses a synthetic in-memory HTTP service, not a Core repository or database.
async function fixture(t, outcome, recovery = {}) {
  const sdk = await import(moduleUrl(sdkDist))
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-recovery-sdk-'))
  const now = Date.now()
  const accounts = ['A', 'B', 'C'].map((label, index) => ({
    label, connectionKey: `conn_${String(index + 1).repeat(32)}`, sessionId: uuid(index + 1),
    clientAppId: index === 1 ? 'inventory_app' : 'shop_app', route: index === 1 ? 'inventory' : 'shop',
    // Synthetic credentials remain in SDK credential stores and HTTP headers.
    accessToken: `recovery-fixture-${label}-access`, refreshToken: `recovery-fixture-${label}-refresh`,
  }))
  const requests = []
  const errors = []
  const invocations = new Map()
  const runs = new Map()
  const live = new Set()
  let nextRun = 100
  let phase = 'original'
  let recoveryRequested = false
  let currentProfile
  let confirmationLost = false
  let originalRecordMissing = false
  const resultFor = (invocationId, original, pending) => ({
    schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocationId,
    route: original.route, tool: original.tool, state: pending ? 'awaiting_approval' : 'executed',
    ok: !pending, auto_retry_allowed: false, text: pending ? 'Synthetic approval pending.' : 'Synthetic original result.',
    ...(pending ? { approval_id: 42 } : {}),
  })
  const server = createServer(async (request, response) => {
    try {
      const account = accounts.find(value => request.headers.authorization === `Bearer ${value.accessToken}`)
      assert.ok(account, 'HTTP requests must use a registered synthetic Agent Session bearer')
      assert.notEqual(account.label, 'C', 'unselected global-default authorization receives no HTTP request')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const body = bytes.length ? JSON.parse(bytes.toString()) : undefined
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      requests.push({ phase, account: account.label, agentSessionId: account.sessionId, path, method: request.method, body })
      if (path === '/agent-api/v1/task-control/capabilities') {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_found' })); return
      }
      let result
      if (path === '/agent-auth/v1/session') {
        assert.equal(request.method, 'GET')
        result = {
          session_id: account.sessionId, client_app_id: account.clientAppId, device_label: 'synthetic recovery fixture',
          principal: { subject: `fixture-${account.label}` }, on_behalf_of: `fixture-${account.label}`,
          allowed_routes: [account.route], created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 3_600_000).toISOString(), refresh_expires_at: new Date(now + 86_400_000).toISOString(),
        }
      } else if (path === `/agent-api/v1/workspaces/${account.route}/turns`) {
        assert.equal(request.method, 'POST')
        assert.equal(account.label, 'A', 'selected but unused B must not receive a business turn')
        assert.ok(phase === 'original' || recoveryRequested,
          'startup and local restore/status must not create a business run')
        if (phase === 'reopened') {
          assert.ok([...invocations.keys()].some(id => body.user_input.includes(id)),
            'an explicit recovery turn identifies the original invocation for audit correlation')
        }
        const runId = uuid(++nextRun)
        runs.set(runId, { account: account.label, agentSessionId: account.sessionId, route: account.route })
        result = turnResponse({ runId, tools: [], capabilityRevision: revision })
      } else if (path === `/agent-api/v1/workspaces/${account.route}/capabilities/search`) {
        assert.equal(request.method, 'POST')
        assert.equal(runs.get(body.run_id)?.account, account.label)
        assert.equal(phase, 'original', 'recovering an original invocation needs no rediscovery')
        result = { schema: 'bailing.agent-capability-search.v1', capability_revision: revision, tools: [definition] }
      } else if (path === '/agent-api/v1/tool-invocations') {
        assert.equal(request.method, 'POST')
        assert.equal(phase, 'original', 'a full runtime reopen must not dispatch a new business invocation')
        assert.equal(body.route, account.route)
        assert.equal(body.tool, definition.name)
        assert.equal(body.capability_revision, revision)
        assert.equal(runs.get(body.agent_run_id)?.agentSessionId, account.sessionId)
        assert.equal(invocations.has(body.invocation_id), false, 'the same write cannot be dispatched twice')
        assert.deepEqual(body.arguments, { product_id: 'synthetic-product', title: 'Synthetic updated title' })
        const original = { account: account.label, agentSessionId: account.sessionId, runId: body.agent_run_id,
          route: body.route, tool: body.tool }
        invocations.set(body.invocation_id, original)
        if (outcome === 'unknown') {
          confirmationLost = true
          response.destroy()
          return
        }
        result = resultFor(body.invocation_id, original, true)
      } else if (/^\/agent-api\/v1\/tool-invocations\/[0-9a-f]{64}\/resume$/u.test(path)) {
        const id = path.split('/').at(-2)
        assert.equal(request.method, 'POST')
        assert.equal(body, undefined, 'SDK resume must not reserialize original business arguments')
        const original = invocations.get(id)
        assert.ok(original)
        assert.equal(original.account, account.label)
        assert.equal(original.agentSessionId, account.sessionId)
        assert.equal(original.route, account.route)
        if (originalRecordMissing) {
          // Keep the fixture's dispatch ledger as evidence of the original
          // write. A missing recovery record does not prove it never ran.
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invocation_not_found', message: 'Synthetic original invocation record not found.' }))
          return
        }
        // The original live turn may perform one bounded status poll according
        // to the SDK's normalized recovery guidance. Keep it unresolved until
        // a separately recreated runtime explicitly requests recovery.
        if (phase === 'original' && outcome === 'unknown') {
          response.destroy()
          return
        }
        result = resultFor(id, original, phase === 'original')
      } else if (/^\/agent-api\/v1\/runs\/[0-9a-f-]+\/complete$/u.test(path)) {
        const runId = path.split('/').at(-2)
        assert.equal(request.method, 'POST')
        assert.equal(runs.get(runId)?.account, account.label)
        result = { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: body.status }
      } else if (path === '/agent-api/v1/conversation-audits/capabilities') {
        result = { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }
      } else if (path.endsWith('/system-info') || path.startsWith('/agent-api/v1/conversation-audits')) {
        // Optional metadata/archive content is outside this HTTP recovery fixture.
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'conversation_audit_not_found', message: 'Not supplied by synthetic fixture' } }))
        return
      } else {
        assert.fail(`unexpected SDK request ${request.method} ${path}`)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    } catch (error) {
      errors.push(error)
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'synthetic_fixture_assertion_failed' }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    for (const instance of live) await instance.close()
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  const hubUrl = `http://127.0.0.1:${server.address().port}`
  const profiles = accounts.map(account => ({
    connectionKey: account.connectionKey, alias: `Synthetic ${account.label}`, baseUrl: hubUrl,
    clientAppId: account.clientAppId, workspace: account.route, allowInsecureHttp: true,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  }))
  const credentials = new Map(accounts.map(account => [account.connectionKey, new sdk.MemoryCredentialStore({
    schema_version: 1, base_url: hubUrl, client_app_id: account.clientAppId, route: account.route,
    session_id: account.sessionId, access_token: account.accessToken, refresh_token: account.refreshToken,
    access_expires_at: new Date(now + 3_600_000).toISOString(), refresh_expires_at: new Date(now + 86_400_000).toISOString(),
  })]))
  currentProfile = profiles[2]
  const connectionStore = {
    registry: {
      get: async key => profiles.find(profile => profile.connectionKey === key),
      getByAlias: async alias => profiles.find(profile => profile.alias === alias), list: async () => profiles,
      current: async () => currentProfile,
    },
    credentialStore: key => credentials.get(key),
    load: async key => ({ profile: profiles.find(profile => profile.connectionKey === key), credentials: await credentials.get(key).load() }),
  }
  const config = { hubUrl, clientAppId: accounts[0].clientAppId, workspace: accounts[0].route, connectionName: profiles[0].alias }
  async function launch({ history = [], choose = true } = {}) {
    const transport = sdk.createAgentClientTransport({ ...config, allowInsecureHttp: true }, { connectionStore, now: () => now })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(CommandRuntime, {})
    await ctx.plugin(createAgentClientPlugin({
      transport, scopeStore: createFileSessionScopeStore({ directory: join(directory, 'scopes') }),
      invocationStore: createFileInvocationStore({ directory: join(directory, 'invocations') }),
      archiveStore: createMemoryConversationArchiveStore(),
      recovery: { maxAttempts: 1, maxWaitMilliseconds: 100, pollIntervalMilliseconds: 1, sleep: async () => {}, ...recovery },
    }), config)
    const runtime = ctx.get('bailingHubAgentClient')
    const session = Session.create(`sdk-recovery-${outcome}`, structuredClone(history))
    const agent = { id: session.id, session }
    const scope = createScope(runtime.ctx, agent)
    agent.ctx = scope.ctx
    runtime.observeSession(session)
    const chosen = choose ? await runtime.setSessionScope(session.id, { connectionKeys: accounts.slice(0, 2).map(account => account.connectionKey) }) : undefined
    const refs = Object.fromEntries((chosen?.authorizations ?? []).map(value => [value.connectionKey, value.authorizationRef]))
    let currentTurn
    let counter = 0
    const execute = (name, args) => agent.ctx.tools.execute({ name, arguments: args, callId: `sdk-recovery-call-${++counter}`, agent, signal: new AbortController().signal })
    const instance = {
      ctx, runtime, session, agent, transport, refs, execute,
      async start(turn) {
        currentTurn = turn
        const message = userMessage(`sdk-recovery-user-${turn}`, turn === 1 ? 'Update a synthetic product title.' : 'Verify only the original operation.')
        session.append('turn/start', { turn })
        session.append('user/message', message, { surfaceOp: 'append' })
        runtime.onInboxClaimed({ agent, turn, message })
        return ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
      },
      async end() {
        const event = session.append('turn/end', { turn: currentTurn, reason: { kind: 'completed' } })
        runtime.onSessionEvent(session, event)
        await waitUntil(() => requests.some(value => value.path.endsWith('/complete')), 'original run completion did not settle')
      },
      async close() {
        if (!live.delete(instance)) return
        await scope.dispose()
        await ctx.fiber.dispose()
      },
    }
    live.add(instance)
    return instance
  }
  return { accounts, requests, errors, invocations, launch, get confirmationLost() { return confirmationLost },
    markReopened: () => { phase = 'reopened'; currentProfile = profiles[2] },
    markOriginalRecordMissing: () => { originalRecordMissing = true },
    requestRecovery: () => { recoveryRequested = true } }
}

for (const [outcome, recoveryPath] of ['approval', 'unknown'].flatMap(outcome => ['polling tool', 'direct runtime'].map(path => [outcome, path]))) {
  test(`real SDK and HTTP preserve invocation_not_found through ${recoveryPath} recovery after ${outcome} without replacing the original write`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, outcome, { maxAttempts: 3, maxWaitMilliseconds: 1_000 })
    const instance = await f.launch()
    await instance.start(1)
    const authorizationRef = instance.refs[f.accounts[0].connectionKey]
    const discovery = await instance.execute('search_business_capabilities', {
      query: 'Update product title', authorization_ref: authorizationRef,
    })
    assert.equal(discovery.isError, false, f.errors.map(String).join('\n'))
    const name = discovery.value.active_tools.find(value => value.original_name === definition.name || value.name === definition.name)?.name
    assert.ok(name)
    const written = await instance.execute(name, { authorization_ref: authorizationRef,
      arguments: { product_id: 'synthetic-product', title: 'Synthetic updated title' } })
    const id = invocationIdFor(written)
    assert.match(id, /^[a-f0-9]{64}$/)
    if (outcome === 'approval') assert.equal(resultBody(written).state, 'awaiting_approval')
    else {
      assert.equal(f.confirmationLost, true)
      assert.equal(written.isError, true)
      assert.equal(written.meta.bailinghub.feedback.dispatch, 'unknown')
    }
    const original = structuredClone(f.invocations.get(id))
    const before = await instance.runtime.getSessionInvocationStatus(instance.session.id)
    assert.equal(before.state, 'ready')
    assert.equal(before.entries.find(value => value.invocation_id === id).last_known_state,
      outcome === 'approval' ? 'awaiting_approval' : 'unknown')
    const requestOffset = f.requests.length
    f.markOriginalRecordMissing()

    let feedback
    if (recoveryPath === 'polling tool') {
      const recovered = await instance.execute('resume_governed_tool_invocation', { invocation_id: id })
      assert.equal(recovered.isError, true, 'the new authoritative 404 must not fall back to an old pending approval result')
      assert.notEqual(resultBody(recovered)?.state, 'awaiting_approval')
      feedback = recovered.meta?.bailinghub?.feedback
      assert.deepEqual(JSON.parse(recovered.content[0].text).feedback, feedback,
        'the model-visible result must retain the same structured feedback as the host metadata')
    } else {
      await assert.rejects(instance.runtime.resume(id, {
        connectionName: f.accounts[0].connectionKey, workspace: f.accounts[0].route,
      }), error => {
        feedback = error.feedback
        return true
      })
    }
    assert.ok(feedback)
    assert.equal(feedback.code, 'invocation_not_found')
    assert.equal(feedback.category, 'invocation_outcome_unknown')
    assert.equal(feedback.next_action, 'inspect_original')
    assert.equal(feedback.retryable, false)
    assert.equal(feedback.original_outcome, 'unverified')
    assert.equal(feedback.invocation_id, id)

    const recoveryRequests = f.requests.slice(requestOffset)
    const resumes = recoveryRequests.filter(value => value.path.endsWith('/resume'))
    assert.equal(resumes.length, 1, 'an authoritative missing-record response must end polling immediately')
    assert.equal(resumes[0].path, `/agent-api/v1/tool-invocations/${id}/resume`)
    assert.equal(resumes[0].account, original.account)
    assert.equal(resumes[0].agentSessionId, original.agentSessionId)
    assert.equal(resumes[0].body, undefined, 'recovery must not resend the original write arguments')
    assert.equal(recoveryRequests.some(value => value.path === '/agent-api/v1/tool-invocations'), false)
    assert.equal(recoveryRequests.some(value => value.path.endsWith('/capabilities/search') || value.path.endsWith('/turns')), false)
    assert.equal(f.requests.filter(value => value.path === '/agent-api/v1/tool-invocations').length, 1)
    assert.equal(f.requests.some(value => value.account === 'C'), false)
    assert.deepEqual(f.invocations.get(id), original)
    assert.deepEqual(await instance.runtime.getSessionInvocationStatus(instance.session.id), before,
      '404 feedback must retain the original journal identity, CAS revision and unverified last-known state')
    assert.deepEqual(f.errors, [])
  })
}

for (const outcome of ['approval', 'unknown']) {
  test(`real SDK and HTTP recover ${outcome} after full runtime recreation through the original invocation endpoint`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, outcome)
    const first = await f.launch()
    await first.start(1)
    const discovery = await first.execute('search_business_capabilities', {
      query: 'Update product title', authorization_ref: first.refs[f.accounts[0].connectionKey],
    })
    assert.equal(discovery.isError, false, f.errors.map(String).join('\n'))
    const name = discovery.value.active_tools.find(value => value.original_name === definition.name || value.name === definition.name)?.name
    assert.ok(name)
    const written = await first.execute(name, { authorization_ref: first.refs[f.accounts[0].connectionKey],
      arguments: { product_id: 'synthetic-product', title: 'Synthetic updated title' } })
    const id = invocationIdFor(written)
    assert.match(id, /^[a-f0-9]{64}$/)
    assert.equal(f.invocations.size, 1)
    if (outcome === 'unknown') {
      assert.equal(f.confirmationLost, true)
      assert.equal(written.isError, true)
      assert.equal(written.meta.bailinghub.feedback.dispatch, 'unknown')
    } else assert.equal(resultBody(written).state, 'awaiting_approval')
    await first.end()
    const history = structuredClone(first.session.events)
    await first.close()
    f.markReopened()
    const reopened = await f.launch({ history, choose: false })
    assert.notEqual(reopened.ctx, first.ctx)
    assert.notEqual(reopened.runtime, first.runtime)
    assert.notEqual(reopened.transport, first.transport)
    assert.notEqual(reopened.session, first.session)
    assert.deepEqual(reopened.session.events.slice(0, history.length), history)
    assert.equal((await reopened.runtime.restoreSessionScope(reopened.session.id)).state, 'ready')
    const restored = await reopened.runtime.restoreSessionInvocations(reopened.session.id)
    assert.equal(restored.state, 'ready')
    const entry = restored.entries.find(value => value.invocation_id === id)
    assert.ok(entry)
    assert.equal(entry.original_run_id, f.invocations.get(id).runId)
    assert.equal(entry.result_verified, false)
    assert.equal((await reopened.runtime.getSessionInvocationStatus(reopened.session.id)).state, 'ready')
    assert.equal(f.requests.filter(value => value.phase === 'reopened' && value.path.endsWith('/resume')).length, 0)
    assert.equal(f.requests.filter(value => value.phase === 'reopened' && value.path.endsWith('/turns')).length, 0)
    await reopened.start(2)
    f.requestRecovery()
    const recovered = await reopened.execute('resume_governed_tool_invocation', { invocation_id: id })
    assert.equal(recovered.isError, false, f.errors.map(String).join('\n'))
    assert.equal(resultBody(recovered).invocation_id, id)
    assert.equal(resultBody(recovered).route, 'shop')
    assert.equal(resultBody(recovered).state, 'executed')
    const resumed = f.requests.filter(value => value.phase === 'reopened' && value.path.endsWith('/resume'))
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].path, `/agent-api/v1/tool-invocations/${id}/resume`)
    assert.equal(resumed[0].account, 'A')
    assert.equal(resumed[0].agentSessionId, f.accounts[0].sessionId)
    assert.equal(resumed[0].body, undefined)
    assert.equal(f.requests.filter(value => value.path === '/agent-api/v1/tool-invocations').length, 1)
    assert.equal(f.requests.filter(value => value.phase === 'reopened' && value.path.endsWith('/capabilities/search')).length, 0)
    const recoveryTurns = f.requests.filter(value => value.phase === 'reopened' && value.path.endsWith('/turns'))
    assert.ok(recoveryTurns.length <= 1, 'an explicit recovery may create a current-turn audit run for the original target')
    assert.ok(recoveryTurns.every(value => value.account === 'A' && value.agentSessionId === f.accounts[0].sessionId))
    const finalStatus = await reopened.runtime.getSessionInvocationStatus(reopened.session.id)
    assert.equal(finalStatus.entries.find(value => value.invocation_id === id).original_run_id, f.invocations.get(id).runId,
      'a current-turn audit run must not replace the original invocation run binding')
    assert.equal(f.requests.some(value => value.account === 'C'), false)
    assert.ok(f.requests.some(value => value.phase === 'reopened' && value.account === 'B' && value.path === '/agent-auth/v1/session'),
      'recovery verifies the entire original group even though only A performed the business operation')
    assert.deepEqual(f.errors, [])
  })
}
