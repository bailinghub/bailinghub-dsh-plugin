import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin, createMemoryConversationArchiveStore } from '../lib/index.js'
import {
  activeTool,
  baseAssembly,
  createMockAgent,
  createMockHost,
  createMemorySessionScopeStore,
  selectSessionScope,
  MOCK_CONNECTION_KEY,
  SEARCH_CAPABILITY_REVISION,
  settle,
  turnResponse,
  userMessage,
} from './helpers/mock-host.mjs'

const sdkDist = process.env.BAILINGHUB_SDK_DIST ?? 'bailinghub-mcp-server/sdk'

function moduleUrl(path) {
  if (path.startsWith('file:')) return path
  if (path.startsWith('/') || path.startsWith('.')) return pathToFileURL(resolve(path)).href
  return path
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('routes multiple authorizations through the installed SDK and loopback HTTP without mixing sessions', { timeout: 10_000 }, async (t) => {
  const sdk = await import(moduleUrl(sdkDist))
  const now = Date.now()
  const requests = []
  const serverErrors = []
  const invocations = new Map()
  const accounts = ['A', 'B'].map((label, index) => ({
    label,
    connectionKey: `conn_${String(index + 1).repeat(32)}`,
    sessionId: `123e4567-e89b-42d3-a456-42661417900${index + 1}`,
    runId: `123e4567-e89b-42d3-a456-42661417800${index + 1}`,
    revision: (index ? 'b' : 'a').repeat(64),
    // Synthetic credentials exist only in these in-memory SDK stores.
    accessToken: `sdk-loopback-${label}-access`,
    refreshToken: `sdk-loopback-${label}-refresh`,
  }))
  const server = createServer(async (request, response) => {
    try {
      const account = accounts.find((entry) => request.headers.authorization === `Bearer ${entry.accessToken}`)
      assert.ok(account, 'every SDK request must carry one registered account bearer')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString()
      const body = rawBody ? JSON.parse(rawBody) : undefined
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      requests.push({ account: account.label, path, method: request.method, body })
      if (path === '/agent-api/v1/task-control/capabilities') {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_found' })); return
      }
      let result
      if (path === '/agent-auth/v1/session') {
        assert.equal(request.method, 'GET')
        result = {
          session_id: account.sessionId,
          client_app_id: 'dsh_client',
          device_label: 'loopback integration fixture',
          principal: { subject: `fixture-${account.label}` },
          on_behalf_of: `fixture-${account.label}`,
          allowed_routes: ['demo'],
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 3_600_000).toISOString(),
          refresh_expires_at: new Date(now + 86_400_000).toISOString(),
        }
      } else if (path === '/agent-api/v1/workspaces/demo/turns') {
        assert.equal(request.method, 'POST')
        assert.match(body.client_conversation_id, /^dsh\.conversation\.[0-9a-f]{32}$/u)
        assert.match(body.client_turn_id, /^dsh\./u)
        assert.match(body.user_message_id, /^dsh\./u)
        assert.equal(body.user_input, 'Update employee 42 in both authorized stores.')
        result = turnResponse({ runId: account.runId, capabilityRevision: account.revision })
      } else if (path === '/agent-api/v1/tool-invocations') {
        assert.equal(request.method, 'POST')
        assert.equal(body.route, 'demo')
        assert.equal(body.agent_run_id, account.runId)
        assert.equal(body.capability_revision, account.revision)
        assert.equal(body.tool, 'employee_update')
        assert.deepEqual(body.arguments, { employee_id: `${account.label}-42` })
        assert.equal(Object.hasOwn(body.arguments, 'authorization_ref'), false)
        invocations.set(body.invocation_id, account.label)
        const pending = account.label === 'A'
        result = {
          schema_version: 'bailing.agent-tool-invocation.v1',
          invocation_id: body.invocation_id,
          route: 'demo',
          tool: body.tool,
          state: pending ? 'awaiting_approval' : 'executed',
          ok: !pending,
          auto_retry_allowed: false,
          text: pending ? 'Awaiting Store A approval.' : 'STORE_B_ONLY_RESULT',
          ...(pending ? { approval_id: 42 } : {}),
        }
      } else if (/^\/agent-api\/v1\/tool-invocations\/[0-9a-f]{64}\/resume$/u.test(path)) {
        const invocationId = path.split('/').at(-2)
        assert.equal(request.method, 'POST')
        assert.equal(body, undefined)
        assert.equal(account.label, 'A')
        assert.equal(invocations.get(invocationId), account.label)
        result = {
          schema_version: 'bailing.agent-tool-invocation.v1',
          invocation_id: invocationId,
          route: 'demo',
          tool: 'employee_update',
          state: 'executed',
          ok: true,
          auto_retry_allowed: false,
          text: 'STORE_A_ONLY_RESULT',
        }
      } else if (path === `/agent-api/v1/runs/${account.runId}/complete`) {
        assert.equal(request.method, 'POST')
        assert.equal(body.status, 'completed')
        assert.match(body.assistant_message_id, /^dsh\./u)
        assert.match(body.content, new RegExp(`STORE_${account.label}_ONLY_RESULT`, 'u'))
        assert.equal(body.content.includes(`STORE_${account.label === 'A' ? 'B' : 'A'}_ONLY_RESULT`), false)
        assert.equal(body.content.includes('COMBINED_LOCAL_REPLY'), false)
        result = { schema: 'bailing.agent-run-completion.v1', run_id: account.runId, status: body.status }
      } else if (path === '/agent-api/v1/workspaces/demo/system-info') {
        // Optional descriptions are absent on this baseline Core fixture.
        assert.equal(request.method, 'GET')
        assert.equal(body, undefined)
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      } else if (path.startsWith('/agent-api/v1/conversation-audits')) {
        // This fixture represents the baseline Core without the optional audit
        // endpoint. Candidate SDKs may probe it; business evidence is unchanged.
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'conversation_audit_not_found', message: 'Not supported by this baseline fixture' } }))
        return
      } else {
        assert.fail(`unexpected SDK request ${request.method} ${path}`)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    } catch (error) {
      serverErrors.push(error)
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'fixture_assertion_failed' }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  const hubUrl = `http://127.0.0.1:${server.address().port}`
  const profiles = accounts.map((account) => ({
    connectionKey: account.connectionKey,
    alias: `Store ${account.label}`,
    baseUrl: hubUrl,
    clientAppId: 'dsh_client',
    workspace: 'demo',
    allowInsecureHttp: true,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }))
  const stores = new Map(accounts.map((account) => [account.connectionKey, new sdk.MemoryCredentialStore({
    schema_version: 1,
    base_url: hubUrl,
    client_app_id: 'dsh_client',
    route: 'demo',
    session_id: account.sessionId,
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    access_expires_at: new Date(now + 3_600_000).toISOString(),
    refresh_expires_at: new Date(now + 86_400_000).toISOString(),
  })]))
  let currentProfile = profiles[0]
  const connectionStore = {
    registry: {
      get: async (key) => profiles.find((profile) => profile.connectionKey === key),
      getByAlias: async (alias) => profiles.find((profile) => profile.alias === alias),
      list: async () => profiles,
      current: async () => currentProfile,
    },
    credentialStore: (key) => stores.get(key),
    load: async (key) => ({ profile: profiles.find((profile) => profile.connectionKey === key), credentials: await stores.get(key).load() }),
  }
  const config = { hubUrl, clientAppId: 'dsh_client', workspace: 'demo', connectionName: 'Store A' }
  const transport = sdk.createAgentClientTransport({ ...config, allowInsecureHttp: true }, {
    connectionStore,
    now: () => now,
  })
  const host = createMockHost()
  t.after(() => host.dispose())
  createAgentClientPlugin({ scopeStore: createMemorySessionScopeStore(), archiveStore: createMemoryConversationArchiveStore(), transport, recovery: { pollIntervalMilliseconds: 1 } }).apply(host.ctx, config)
  const { agent, local } = createMockAgent('sdk-multiple-authorizations')
  await selectSessionScope(host, agent, accounts.map((account) => account.connectionKey))
  host.emit('agent/inbox/claimed', {
    agent, turn: 1,
    message: userMessage('sdk-multi-user', 'Update employee 42 in both authorized stores.'),
  })
  const assembly = await host.waterfall('system-prompt/assemble', baseAssembly(), {
    agent, signal: new AbortController().signal,
  }, async () => baseAssembly())
  const directoryLine = assembly.sections.flatMap((section) => section.text.split('\n'))
    .find((line) => line.startsWith('Authorization directory: '))
  assert.ok(directoryLine, serverErrors.map(String).join('\n'))
  const directory = JSON.parse(directoryLine.slice('Authorization directory: '.length))
  assert.ok(directory.every((entry) => entry.subject_display === null && entry.label === 'Authorization name pending sync'))
  // The installed old SDK supplies no business name. Resolve test targets by
  // their fixed host-selected keys instead of merging duplicate display labels.
  const scope = await host.services.get('bailingHubAgentClient').getSessionScope(agent.session.id)
  const refs = Object.fromEntries(accounts.map((account) => [`Store ${account.label}`,
    scope.authorizations.find((entry) => entry.connectionKey === account.connectionKey).authorizationRef]))
  assert.deepEqual(new Set(directory.map((entry) => entry.authorization_ref)), new Set(Object.values(refs)))
  assert.equal(assembly.tools.filter((tool) => tool.name === 'employee_update').length, 1)
  assert.equal(Object.keys(refs).length, 2)
  for (const account of accounts) {
    assert.equal(JSON.stringify(assembly).includes(account.accessToken), false)
    assert.equal(JSON.stringify(assembly).includes(account.refreshToken), false)
  }
  // A process-wide selection change must not alter the captured catalog or calls.
  currentProfile = profiles[1]
  for (const account of accounts) {
    const result = await local.get('employee_update').execute({
      authorization_ref: refs[`Store ${account.label}`],
      arguments: { employee_id: `${account.label}-42` },
    }, { agent, callId: `sdk-multi-${account.label}`, signal: new AbortController().signal })
    const decoded = result
    assert.equal(decoded.authorization_ref, refs[`Store ${account.label}`])
    assert.equal(decoded.authorization_label, 'Authorization name pending sync')
    assert.equal(decoded.subject_display, null)
    assert.equal(decoded.result.state, 'executed', serverErrors.map(String).join('\n'))
  }
  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { turn: 1, message: { id: 'sdk-multi-final', role: 'assistant',
      content: [{ type: 'text', text: 'COMBINED_LOCAL_REPLY' }] } },
  })
  host.emit('session/event', agent.session, {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
  })
  const deadline = Date.now() + 2_000
  while (requests.filter((request) => request.path.endsWith('/complete')).length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(serverErrors, [])
  for (const account of accounts) {
    const own = requests.filter((request) => request.account === account.label)
    assert.ok(own.filter((request) => request.path === '/agent-auth/v1/session').length >= 3)
    assert.equal(own.filter((request) => request.path.endsWith('/turns')).length, 1)
    assert.equal(own.filter((request) => request.path === '/agent-api/v1/tool-invocations').length, 1)
    assert.equal(own.filter((request) => request.path.endsWith('/complete')).length, 1)
    assert.equal(own.filter((request) => request.path.endsWith('/resume')).length, account.label === 'A' ? 1 : 0)
  }
  assert.equal(invocations.size, 2)
})

test('matches the real generic SDK facade argument and HTTP DTO contract', async () => {
  const sdk = await import(moduleUrl(sdkDist))
  assert.equal(typeof sdk.createAgentClientTransport, 'function')

  const now = Date.now()
  const nonSecretAccessValue = ['integration', 'access', 'value'].join('-')
  const nonSecretRefreshValue = ['integration', 'refresh', 'value'].join('-')
  const profile = {
    connectionKey: `conn_${'a'.repeat(32)}`,
    alias: 'personal',
    baseUrl: 'https://hub.example.com',
    clientAppId: 'dsh_client',
    workspace: 'demo',
    allowInsecureHttp: false,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }
  const credentials = {
    schema_version: 1,
    base_url: profile.baseUrl,
    client_app_id: profile.clientAppId,
    route: profile.workspace,
    session_id: '123e4567-e89b-42d3-a456-426614179001',
    access_token: nonSecretAccessValue,
    refresh_token: nonSecretRefreshValue,
    access_expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
    refresh_expires_at: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
  }
  const credentialStore = new sdk.MemoryCredentialStore(credentials)
  const connectionStore = {
    registry: {
      list: async () => [profile],
      current: async () => profile,
      get: async (key) => key === profile.connectionKey ? profile : undefined,
      getByAlias: async (alias) => alias === profile.alias ? profile : undefined,
    },
    credentialStore: () => credentialStore,
    load: async (key) => key === profile.connectionKey ? { profile, credentials: await credentialStore.load() } : undefined,
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === '/agent-api/v1/task-control/capabilities') return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    const headers = new Headers(init.headers)
    requests.push({
      path,
      method: init.method,
      body,
      authorized: headers.get('authorization')?.startsWith('Bearer ') === true,
    })

    if (path === '/agent-auth/v1/session') {
      return jsonResponse({
        session_id: credentials.session_id, client_app_id: profile.clientAppId,
        device_label: 'single-authorization integration fixture',
        principal: { subject: 'fixture-operator' }, on_behalf_of: 'fixture-operator',
        allowed_routes: [profile.workspace],
        created_at: new Date(now).toISOString(), expires_at: credentials.access_expires_at,
        refresh_expires_at: credentials.refresh_expires_at,
      })
    }
    if (path === '/agent-api/v1/workspaces/demo/turns') return jsonResponse(turnResponse())
    if (path === '/agent-api/v1/workspaces/demo/system-info') return jsonResponse({
      schema_version: 'bailing.agent-system-info.v1',
      binding: { client_app_id: profile.clientAppId, session_id: credentials.session_id, workspace: profile.workspace },
      metadata_status: 'configured', revision: 'a'.repeat(64),
      system: { name: 'Service scheduling', summary: 'Coordinate appointments and service delivery.', domains: ['Appointments'], boundaries: ['Use only permitted account actions.'] },
      tool_status: 'not_loaded', availability: 'unknown',
    })
    if (path === '/agent-api/v1/workspaces/demo/capabilities/search') {
      return jsonResponse({
        schema: 'bailing.agent-capability-search.v1',
        capability_revision: SEARCH_CAPABILITY_REVISION,
        tools: [activeTool('employee_read')],
      })
    }
    if (path === '/agent-api/v1/tool-invocations') {
      return jsonResponse({
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: body.invocation_id,
        route: 'demo',
        tool: body.tool,
        state: 'awaiting_approval',
        ok: false,
        auto_retry_allowed: false,
        text: 'Approval is pending.',
        approval_id: 42,
      })
    }
    if (/^\/agent-api\/v1\/tool-invocations\/[0-9a-f]{64}\/resume$/u.test(path)) {
      return jsonResponse({
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: path.split('/').at(-2),
        route: 'demo',
        tool: 'employee_update',
        state: 'executed',
        ok: true,
        auto_retry_allowed: false,
        text: 'Invocation recovered.',
      })
    }
    const completion = path.match(/^\/agent-api\/v1\/runs\/([^/]+)\/complete$/u)
    if (completion) {
      return jsonResponse({
        schema: 'bailing.agent-run-completion.v1',
        run_id: completion[1],
        status: body.status,
      })
    }
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const transport = sdk.createAgentClientTransport({
    hubUrl: profile.baseUrl,
    clientAppId: profile.clientAppId,
    workspace: profile.workspace,
    connectionName: profile.alias,
  }, { connectionStore, fetchImpl, now: () => now })
  const host = createMockHost()
  createAgentClientPlugin({ scopeStore: createMemorySessionScopeStore(), archiveStore: createMemoryConversationArchiveStore(),
    transport,
    recovery: { pollIntervalMilliseconds: 1 },
  }).apply(host.ctx, {
    hubUrl: profile.baseUrl,
    clientAppId: profile.clientAppId,
    workspace: profile.workspace,
    connectionName: profile.alias,
  })
  const { agent, local } = createMockAgent('real-sdk')
  await selectSessionScope(host, agent, [profile.connectionKey])
  host.emit('agent/inbox/claimed', {
    agent,
    turn: 1,
    message: userMessage('real-sdk-user-message', 'Update employee 42.'),
  })
  const initial = await host.waterfall(
    'system-prompt/assemble',
    baseAssembly(),
    { agent, signal: new AbortController().signal },
    async () => baseAssembly(),
  )

  await local.get('employee_update').execute(
    { employee_id: '42' },
    { agent, callId: 'sdk-call-1', signal: new AbortController().signal },
  )
  await local.get('search_business_capabilities').execute(
    { query: 'read employee', limit: 8 },
    { agent, callId: 'sdk-search-1', signal: new AbortController().signal },
  )
  await assert.rejects(() => local.get('resume_governed_tool_invocation').execute(
    { invocation_id: 'b'.repeat(64) },
    { agent, callId: 'sdk-resume-unknown', signal: new AbortController().signal },
  ), (error) => error.feedback.category === 'unsupported' && error.feedback.code === 'invocation_store_unsupported' && error.feedback.dispatch === 'not_dispatched')

  host.emit('session/event', agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 0, callId: 'sdk-call-1', name: 'employee_update', arguments: {} },
  })
  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'sdk-visible-final',
        role: 'assistant',
        source: { provider: 'deepseek', model: 'deepseek-chat' },
        content: [{ type: 'text', text: 'Employee 42 was updated.' }],
      },
      usage: { inputTokens: 8, cacheReadTokens: 2, outputTokens: 5, reasoningTokens: 1 },
    },
  })
  host.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await settle()

  assert.equal(requests.every((request) => request.authorized), true)
  const descriptionRequests = requests.filter((request) => request.path.endsWith('/system-info'))
  if (typeof transport.getSystemInfo === 'function') {
    assert.equal(descriptionRequests.length, 1)
    assert.equal(descriptionRequests[0].method, 'GET')
    assert.equal(descriptionRequests[0].body, undefined)
    assert.match(JSON.stringify(initial), /Service scheduling/)
  }
  const businessRequests = requests.filter((request) => request.path.startsWith('/agent-api/') && !request.path.startsWith('/agent-api/v1/conversation-audits') && !request.path.endsWith('/system-info'))
  assert.ok(requests.some((request) => request.path === '/agent-auth/v1/session'))
  assert.deepEqual(businessRequests.map((request) => request.path), [
    '/agent-api/v1/workspaces/demo/turns',
    '/agent-api/v1/tool-invocations',
    `/agent-api/v1/tool-invocations/${businessRequests[1].body.invocation_id}/resume`,
    '/agent-api/v1/workspaces/demo/capabilities/search',
    '/agent-api/v1/runs/123e4567-e89b-42d3-a456-426614174000/complete',
  ])
  assert.match(businessRequests[0].body.client_conversation_id, /^dsh\.conversation\.[0-9a-f]{32}$/u)
  assert.equal(businessRequests[1].body.agent_run_id, '123e4567-e89b-42d3-a456-426614174000')
  assert.equal(businessRequests[2].body, undefined)
  assert.equal(businessRequests[3].body.run_id, '123e4567-e89b-42d3-a456-426614174000')
  assert.deepEqual(businessRequests[4].body.usage, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    total_tokens: 15,
    tool_calls: 1,
  })
  assert.equal(Object.hasOwn(businessRequests[4].body, 'reasoning'), false)
})

test('drives the installed SDK connection lifecycle through DSH user commands', async () => {
  const sdk = await import(moduleUrl(sdkDist))
  const root = await mkdtemp(join(tmpdir(), 'dsh-bailinghub-sdk-seam-'))
  const calls = { fetch: 0, login: 0, browser: 0, command: 0 }
  const storagePlatform = process.platform === 'win32' ? 'win32' : 'linux'
  try {
    const registry = new sdk.AgentConnectionRegistry(
      join(root, 'agent-connections.json'),
      storagePlatform,
    )
    const connectionStore = new sdk.AgentConnectionStore({
      platform: storagePlatform,
      environment: {
        ...process.env,
        BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true',
      },
      registry,
      credentialPathFor: (connectionKey) => join(root, `${connectionKey}.json`),
      commandRunner: async () => {
        calls.command += 1
        throw new Error('logged-out connection lifecycle must not invoke a credential command')
      },
    })
    const transport = sdk.createAgentClientTransport({
      hubUrl: 'https://hub.example.com',
      clientAppId: 'dsh_client',
      workspace: 'demo',
      connectionName: 'bootstrap',
    }, {
      connectionStore,
      fetchImpl: async () => {
        calls.fetch += 1
        throw new Error('connection lifecycle must not call the Hub')
      },
      loginImpl: async () => {
        calls.login += 1
        throw new Error('connection lifecycle must not start browser authorization')
      },
      openBrowser: async () => {
        calls.browser += 1
        throw new Error('connection lifecycle must not open a browser')
      },
    })
    const host = createMockHost()
    createAgentClientPlugin({ scopeStore: createMemorySessionScopeStore(), archiveStore: createMemoryConversationArchiveStore(), transport }).apply(host.ctx, {
      hubUrl: 'https://hub.example.com',
      clientAppId: 'dsh_client',
      workspace: 'demo',
      connectionName: 'bootstrap',
    })
    const command = host.commands.get('bailinghub')

    const initial = await command.handler({ rawInput: 'connections list' })
    const personal = await command.handler({
      rawInput: 'connections add personal https://hub.example.com dsh_client demo',
    })
    const second = await command.handler({
      rawInput: 'connections add "second hub" https://two.example.com second_client staff',
    })
    assert.equal((await registry.current())?.alias, 'second hub')
    const selected = await command.handler({ rawInput: 'connections use personal' })
    assert.equal((await registry.current())?.alias, 'personal')
    const listed = await command.handler({ rawInput: 'connections list' })
    const removedPersonal = await command.handler({ rawInput: 'connections remove personal' })
    assert.equal((await registry.current())?.alias, 'second hub')
    const removedSecond = await command.handler({
      rawInput: 'connections remove "second hub"',
    })
    const status = await command.handler({ rawInput: 'status' })
    const final = await command.handler({ rawInput: 'connections list' })

    const results = [initial, personal, second, selected, listed, removedPersonal, removedSecond, status, final]
    for (const result of results) {
      assert.equal(result.kind, 'success')
      assert.doesNotMatch(result.text, /access[_-]?token|refresh[_-]?token|bearer\s+/iu)
    }
    assert.match(personal.text, /"connectionName":"personal"/u)
    assert.match(second.text, /"connectionName":"second hub"/u)
    assert.match(second.text, /"state":"logged_out"/u)
    assert.match(selected.text, /"state":"selected"/u)
    assert.match(listed.text, /"connectionName":"personal"/u)
    assert.match(listed.text, /"connectionName":"second hub"/u)
    assert.match(removedPersonal.text, /"hadCredentials":false/u)
    assert.match(removedPersonal.text, /"remoteRevoked":true/u)
    assert.match(removedSecond.text, /"currentConnectionKey":null/u)
    assert.match(status.text, /"state":"unconfigured"/u)
    assert.deepEqual(calls, { fetch: 0, login: 0, browser: 0, command: 0 })
    assert.equal((await registry.list()).length, 0)
    assert.equal(await registry.current(), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
