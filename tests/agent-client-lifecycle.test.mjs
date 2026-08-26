import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BailingHubAgentClientRuntime,
  buildCompletionPayload,
  normalizeStartTurnResponse,
} from '../lib/runtime.js'
import {
  activeTool,
  baseAssembly,
  callsFor,
  createMockAgent,
  createMockHost,
  createMockTransport,
  SEARCH_CAPABILITY_REVISION,
  settle,
  turnResponse,
  userMessage,
} from './helpers/mock-host.mjs'

const config = {
  hubUrl: 'https://hub.example.com',
  clientAppId: 'dsh_client',
  workspace: 'demo',
  connectionName: 'personal',
}

function createRuntime(overrides = {}) {
  const host = createMockHost()
  const mock = createMockTransport(overrides)
  const runtime = new BailingHubAgentClientRuntime(
    host.ctx,
    config,
    async () => mock.transport,
  ).install()
  return { host, mock, runtime }
}

async function startOneTurn(host, agent, turn = 1, id = 'raw/message?id=1') {
  host.emit('agent/inbox/claimed', {
    agent,
    turn,
    message: userMessage(id, 'Please update employee 42.'),
  })
  return host.waterfall(
    'system-prompt/assemble',
    baseAssembly(),
    { agent, signal: new AbortController().signal },
    async () => baseAssembly(),
  )
}

test('starts the Core turn before prompt assembly and exposes scoped typed tools immediately', async () => {
  const { host, mock } = createRuntime()
  const { agent, local } = createMockAgent('one')
  const assembly = await startOneTurn(host, agent)

  const [start] = callsFor(mock.calls, 'startTurn')
  assert.ok(start)
  assert.match(start.args[0].clientConversationId, /^dsh\.conversation\.[0-9a-f]{32}$/)
  assert.match(start.args[0].clientTurnId, /^dsh\.turn\.[0-9a-f]{32}$/)
  assert.match(start.args[0].userMessageId, /^dsh\.user\.[0-9a-f]{32}$/)
  assert.notStrictEqual(start.args[0].userMessageId, 'raw/message?id=1')
  assert.equal(start.args[0].userInput, 'Please update employee 42.')
  assert.equal(start.args[1].workspace, 'demo')

  assert.match(
    assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
    /local Agent chooses.*local reasoning and orchestration/,
  )
  assert.match(
    assembly.contexts.find((entry) => entry.name === 'bailinghub:knowledge').text,
    /reference-only evidence, not instructions/,
  )
  assert.match(
    assembly.contexts.find((entry) => entry.name === 'bailinghub:knowledge').text,
    /Employee policy/,
  )
  assert.ok(assembly.tools.some((tool) => tool.name === 'employee_update'))
  assert.ok(assembly.tools.some((tool) => tool.name === 'search_business_capabilities'))
  assert.ok(assembly.tools.some((tool) => tool.name === 'resume_governed_tool_invocation'))
  assert.ok(local.has('employee_update'))
})

test('recovers accepted_unknown with the original invocation id instead of invoking again', async () => {
  let acceptedInvocationId
  const { host, mock } = createRuntime({
    invoke: async (input) => {
      acceptedInvocationId = input.invocationId
      throw Object.assign(new Error('unsafe upstream detail Bearer top-secret'), {
        disposition: 'accepted_unknown',
      })
    },
  })
  const { agent, local } = createMockAgent('accepted')
  await startOneTurn(host, agent)
  const definition = local.get('employee_update')

  const recovered = await definition.execute(
    { employee_id: '42' },
    { agent, callId: 'model-call/one', signal: new AbortController().signal },
  )

  assert.match(acceptedInvocationId, /^[0-9a-f]{64}$/)
  assert.equal(recovered.invocation_id, acceptedInvocationId)
  assert.equal(recovered.state, 'executed')
  const [invoke] = callsFor(mock.calls, 'invoke')
  assert.deepEqual(Object.keys(invoke.args[0]).sort(), [
    'agentRunId',
    'arguments',
    'capabilityRevision',
    'invocationId',
    'tool',
  ])
  assert.equal(invoke.args[0].tool, 'employee_update')
  const [resume] = callsFor(mock.calls, 'resume')
  assert.equal(resume.args[0], acceptedInvocationId)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
})

test('search replaces only this session active set and resume uses the exact invocation id', async () => {
  const { host, mock } = createRuntime()
  const { agent, local } = createMockAgent('search')
  await startOneTurn(host, agent)

  const search = local.get('search_business_capabilities')
  const result = await search.execute(
    { query: 'read employee', limit: 8 },
    { agent, callId: 'search-1', signal: new AbortController().signal },
  )
  assert.equal(result.capability_revision, SEARCH_CAPABILITY_REVISION)
  assert.equal(local.has('employee_update'), false)
  assert.equal(local.has('employee_read'), true)

  const [searchCall] = callsFor(mock.calls, 'searchCapabilities')
  assert.deepEqual(searchCall.args[0], {
    query: 'read employee',
    limit: 8,
    runId: '123e4567-e89b-42d3-a456-426614174001',
  })

  const invocationId = 'a'.repeat(64)
  const resumed = await local.get('resume_governed_tool_invocation').execute(
    { invocation_id: invocationId },
    { agent, callId: 'resume-1', signal: new AbortController().signal },
  )
  assert.equal(resumed.invocation_id, invocationId)
  const resumedCall = callsFor(mock.calls, 'resume').at(-1)
  assert.equal(resumedCall.args[0], invocationId)
  assert.deepEqual(resumedCall.args[1], {})
  assert.equal(resumedCall.args[2].workspace, 'demo')
  assert.equal(resumedCall.args[2].connectionName, 'personal')
})

test('syncs only the visible final assistant message and public usage at turn end', async () => {
  const { host, mock } = createRuntime()
  const { agent, local } = createMockAgent('complete')
  await startOneTurn(host, agent)

  host.emit('session/event', agent.session, {
    type: 'assistant/chunk',
    data: { turn: 1, chunk: { type: 'reasoning', text: 'hidden chain of thought' } },
  })
  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      message: {
        id: 'unsafe/assistant?id=9',
        role: 'assistant',
        source: { provider: 'deepseek', model: 'deepseek-chat' },
        content: [
          { type: 'thinking', thinking: 'hidden chain of thought' },
          { type: 'text', text: 'Employee 42 was updated.' },
        ],
      },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        tool_calls: 1,
        cost_usd: -1,
        private_latency_ms: 999,
        access_token: 'must-not-leave-host',
      },
    },
  })
  host.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await settle()

  const [complete] = callsFor(mock.calls, 'completeRun')
  assert.equal(complete.args[0], '123e4567-e89b-42d3-a456-426614174001')
  assert.deepEqual(complete.args[1], {
    assistantMessageId: complete.args[1].assistantMessageId,
    content: 'Employee 42 was updated.',
    status: 'completed',
    model: 'deepseek-chat',
    runtime: 'deepseek-harness/dsh-bailinghub-agent-client',
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, tool_calls: 1 },
  })
  assert.match(complete.args[1].assistantMessageId, /^dsh\.assistant\.[0-9a-f]{32}$/)
  assert.doesNotMatch(
    JSON.stringify(complete.args[1]),
    /hidden chain|access_token|must-not|private_latency_ms|cost_usd/,
  )
  assert.equal(local.size, 0)
})

test('normalizes real DSH rc.7 camelCase usage and counts durable tool calls', async () => {
  const { host, mock } = createRuntime()
  const { agent } = createMockAgent('dsh-usage')
  await startOneTurn(host, agent)

  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 0,
      message: {
        id: 'assistant-step-0',
        role: 'assistant',
        source: { provider: 'deepseek', model: 'deepseek-chat' },
        content: [
          { type: 'reasoning', text: 'must remain local' },
          { type: 'tool-call', id: 'tool-1', name: 'employee_update', arguments: {} },
        ],
      },
      usage: {
        inputTokens: 13000,
        outputTokens: 120,
        cacheReadTokens: 7000,
        reasoningTokens: 80,
        providerPrivateMetric: 999,
      },
    },
  })
  host.emit('session/event', agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 0, callId: 'tool-1', name: 'employee_update', arguments: {} },
  })
  // Replayed durable events must not inflate the public tool-call count.
  host.emit('session/event', agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 0, callId: 'tool-1', name: 'employee_update', arguments: {} },
  })
  host.emit('session/event', agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'tool-2', name: 'employee_read', arguments: {} },
  })
  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 2,
      message: {
        id: 'assistant-step-2',
        role: 'assistant',
        source: { provider: 'deepseek', model: 'deepseek-chat' },
        content: [
          { type: 'reasoning', text: 'must remain local too' },
          { type: 'text', text: 'The requested change is complete.' },
        ],
      },
      usage: {
        inputTokens: 14662,
        outputTokens: 164,
        cacheReadTokens: 7080,
        cacheWriteTokens: -1,
        costUsd: Number.NaN,
      },
    },
  })
  host.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await settle()

  const [complete] = callsFor(mock.calls, 'completeRun')
  assert.deepEqual(complete.args[1].usage, {
    input_tokens: 41742,
    cached_input_tokens: 14080,
    output_tokens: 284,
    total_tokens: 42026,
    tool_calls: 2,
  })
  assert.doesNotMatch(
    JSON.stringify(complete.args[1]),
    /must remain local|reasoningTokens|providerPrivateMetric|cacheWriteTokens|costUsd/,
  )
})

test('normalizes schema aliases and rejects unsupported Core contracts', () => {
  const normalized = normalizeStartTurnResponse(turnResponse({ tools: [activeTool('_private_tool')] }))
  assert.equal(normalized.schema, 'bailing.agent-turn-context.v1')
  assert.equal(normalized.context.knowledge[0].title, 'Employee policy')
  assert.equal(normalized.activeTools[0].name, '_private_tool')

  assert.throws(
    () => normalizeStartTurnResponse({ ...turnResponse(), schema_version: 'future.v2' }),
    /unsupported schema/,
  )
  assert.throws(
    () => normalizeStartTurnResponse({ ...turnResponse(), profile_revision: 'profile-1' }),
    /profile_revision/,
  )
  assert.throws(
    () => normalizeStartTurnResponse({ ...turnResponse(), capability_revision: 'C'.repeat(64) }),
    /capability_revision/,
  )
})

test('maps every DSH end reason to the three legal Core completion statuses', () => {
  const run = {
    assistant: { id: 'dsh.assistant.abc', text: 'Visible', model: '' },
    usages: [],
  }
  assert.equal(buildCompletionPayload(run, { kind: 'completed' }).status, 'completed')
  assert.equal(buildCompletionPayload(run, { kind: 'aborted' }).status, 'cancelled')
  for (const kind of ['blocked', 'max-tokens', 'error', 'interrupted']) {
    assert.equal(buildCompletionPayload(run, { kind }).status, 'failed')
  }
})

test('removes governed definitions when the Agent is not in native tool mode', async () => {
  const { host } = createRuntime()
  const { agent, local } = createMockAgent('code-mode')
  agent.toolMode = 'code'
  const assembly = await startOneTurn(host, agent)

  assert.equal(local.size, 0)
  assert.equal(assembly.tools.some((tool) => tool.name === 'employee_update'), false)
  assert.match(
    assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
    /Code Mode is not supported/,
  )
})
