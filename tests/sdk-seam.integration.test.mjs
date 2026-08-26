import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  activeTool,
  baseAssembly,
  createMockAgent,
  createMockHost,
  SEARCH_CAPABILITY_REVISION,
  settle,
  turnResponse,
  userMessage,
} from './helpers/mock-host.mjs'

const sdkDist = process.env.BAILINGHUB_SDK_DIST

function moduleUrl(path) {
  return path.startsWith('file:') ? path : pathToFileURL(resolve(path)).href
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('matches the real generic SDK facade argument and HTTP DTO contract', {
  skip: sdkDist ? false : 'set BAILINGHUB_SDK_DIST to bailinghub-mcp-server dist/sdk.js',
}, async () => {
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
    session_id: 'integration-session',
    access_token: nonSecretAccessValue,
    refresh_token: nonSecretRefreshValue,
    access_expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
    refresh_expires_at: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
  }
  const credentialStore = new sdk.MemoryCredentialStore(credentials)
  const connectionStore = {
    registry: {
      get: async (key) => key === profile.connectionKey ? profile : undefined,
      getByAlias: async (alias) => alias === profile.alias ? profile : undefined,
    },
    credentialStore: () => credentialStore,
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    const headers = new Headers(init.headers)
    requests.push({
      path,
      method: init.method,
      body,
      authorized: headers.get('authorization')?.startsWith('Bearer ') === true,
    })

    if (path === '/agent-api/v1/workspaces/demo/turns') return jsonResponse(turnResponse())
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
        state: 'executed',
        ok: true,
        auto_retry_allowed: false,
        text: 'Employee updated.',
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
  createAgentClientPlugin({ transport }).apply(host.ctx, {
    hubUrl: profile.baseUrl,
    clientAppId: profile.clientAppId,
    workspace: profile.workspace,
    connectionName: profile.alias,
  })
  const { agent, local } = createMockAgent('real-sdk')
  host.emit('agent/inbox/claimed', {
    agent,
    turn: 1,
    message: userMessage('real-sdk-user-message', 'Update employee 42.'),
  })
  await host.waterfall(
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
  const resumeId = 'b'.repeat(64)
  await local.get('resume_governed_tool_invocation').execute(
    { invocation_id: resumeId },
    { agent, callId: 'sdk-resume-1', signal: new AbortController().signal },
  )

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
  assert.deepEqual(requests.map((request) => request.path), [
    '/agent-api/v1/workspaces/demo/turns',
    '/agent-api/v1/tool-invocations',
    '/agent-api/v1/workspaces/demo/capabilities/search',
    `/agent-api/v1/tool-invocations/${resumeId}/resume`,
    '/agent-api/v1/runs/123e4567-e89b-42d3-a456-426614174000/complete',
  ])
  assert.match(requests[0].body.client_conversation_id, /^dsh\.conversation\.[0-9a-f]{32}$/u)
  assert.equal(requests[1].body.agent_run_id, '123e4567-e89b-42d3-a456-426614174000')
  assert.equal(requests[2].body.run_id, '123e4567-e89b-42d3-a456-426614174000')
  assert.equal(requests[3].body, undefined)
  assert.deepEqual(requests[4].body.usage, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    total_tokens: 15,
    tool_calls: 1,
  })
  assert.equal(Object.hasOwn(requests[4].body, 'reasoning'), false)
})
