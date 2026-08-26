import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  baseAssembly,
  callsFor,
  createMockAgent,
  createMockHost,
  createMockTransport,
  settle,
  userMessage,
} from './helpers/mock-host.mjs'

const config = {
  hubUrl: 'https://hub.example.com',
  clientAppId: 'dsh_client',
  workspace: 'demo',
  connectionName: 'personal',
}

function invocation(input, state, overrides = {}) {
  return {
    schema_version: 'bailing.agent-tool-invocation.v1',
    invocation_id: input.invocationId,
    route: 'demo',
    tool: 'employee_update',
    state,
    ok: state === 'executed',
    auto_retry_allowed: false,
    text: state === 'executed' ? 'Employee updated.' : `Invocation is ${state}.`,
    ...overrides,
  }
}

async function createApprovalRuntime(overrides, recovery = {}) {
  const host = createMockHost()
  const mock = createMockTransport(overrides)
  createAgentClientPlugin({
    transport: mock.transport,
    recovery: {
      pollIntervalMilliseconds: 1,
      maxWaitMilliseconds: 10_000,
      maxAttempts: 5,
      sleep: async () => {},
      ...recovery,
    },
  }).apply(host.ctx, config)
  const client = createMockAgent('approval')
  host.emit('agent/inbox/claimed', {
    agent: client.agent,
    turn: 1,
    message: userMessage('approval-message', 'Update employee 42.'),
  })
  await host.waterfall(
    'system-prompt/assemble',
    baseAssembly(),
    { agent: client.agent, signal: new AbortController().signal },
    async () => baseAssembly(),
  )
  return { host, mock, ...client }
}

test('waits for approval, resumes the original invocation, and completes the original run', async () => {
  let invocationId
  let resumeCount = 0
  const { host, mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => {
      invocationId = input.invocationId
      return invocation(input, 'awaiting_approval', { approval_id: 42 })
    },
    resume: async (id) => {
      assert.equal(id, invocationId)
      resumeCount += 1
      return invocation(
        { invocationId: id },
        resumeCount === 1 ? 'awaiting_approval' : 'executed',
        resumeCount === 1 ? { approval_id: 42 } : {},
      )
    },
  })
  const definition = local.get('employee_update')
  const exec = {
    agent,
    callId: 'approval-call',
    signal: new AbortController().signal,
  }

  const completed = await definition.execute({ employee_id: '42' }, exec)
  assert.equal(completed.state, 'executed')
  assert.equal(completed.invocation_id, invocationId)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.deepEqual(
    callsFor(mock.calls, 'resume').map((call) => call.args[0]),
    [invocationId, invocationId],
  )

  const replayed = await definition.execute({ employee_id: '42' }, exec)
  assert.deepEqual(replayed, completed)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 2)

  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      message: {
        id: 'approval-finished',
        role: 'assistant',
        source: { provider: 'deepseek', model: 'deepseek-chat' },
        content: [{ type: 'text', text: 'Employee 42 was updated.' }],
      },
    },
  })
  host.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await settle()

  const [invokeCall] = callsFor(mock.calls, 'invoke')
  const [completion] = callsFor(mock.calls, 'completeRun')
  assert.equal(completion.args[0], invokeCall.args[0].agentRunId)
  assert.equal(completion.args[1].status, 'completed')
})

test('keeps denial terminal and never resumes or invokes it twice', async () => {
  let invocationId
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => {
      invocationId = input.invocationId
      return invocation(input, 'awaiting_approval', { approval_id: 43 })
    },
    resume: async (id) => invocation({ invocationId: id }, 'denied'),
  })
  const definition = local.get('employee_update')
  const exec = {
    agent,
    callId: 'denied-call',
    signal: new AbortController().signal,
  }

  const denied = await definition.execute({ employee_id: '42' }, exec)
  assert.equal(denied.state, 'denied')
  assert.equal(denied.invocation_id, invocationId)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 1)

  assert.deepEqual(await definition.execute({ employee_id: '42' }, exec), denied)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 1)
})

test('coalesces concurrent DSH replays and rejects argument drift for the same call id', async () => {
  let invocationId
  let releaseResume
  let reportResumeStarted
  const resumeStarted = new Promise((resolve) => {
    reportResumeStarted = resolve
  })
  const resumeGate = new Promise((resolve) => {
    releaseResume = resolve
  })
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => {
      invocationId = input.invocationId
      return invocation(input, 'awaiting_approval', { approval_id: 45 })
    },
    resume: async (id) => {
      reportResumeStarted()
      await resumeGate
      return invocation({ invocationId: id }, 'executed')
    },
  })
  const definition = local.get('employee_update')
  const exec = {
    agent,
    callId: 'concurrent-call',
    signal: new AbortController().signal,
  }

  const first = definition.execute({ employee_id: '42' }, exec)
  const replay = definition.execute({ employee_id: '42' }, exec)
  await resumeStarted
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 1)

  releaseResume()
  const [firstResult, replayResult] = await Promise.all([first, replay])
  assert.deepEqual(replayResult, firstResult)
  assert.equal(firstResult.invocation_id, invocationId)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 1)

  await assert.rejects(
    definition.execute({ employee_id: '43' }, exec),
    /changed the original arguments/,
  )
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 1)
})

test('returns a bounded pending result, then explicit resume continues the same invocation', async () => {
  let invocationId
  let approved = false
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => {
      invocationId = input.invocationId
      return invocation(input, 'awaiting_approval', { approval_id: 44 })
    },
    resume: async (id) => invocation(
      { invocationId: id },
      approved ? 'executed' : 'awaiting_approval',
      approved ? {} : { approval_id: 44 },
    ),
  }, { maxAttempts: 2 })
  const definition = local.get('employee_update')

  const pending = await definition.execute(
    { employee_id: '42' },
    { agent, callId: 'timeout-call', signal: new AbortController().signal },
  )
  assert.equal(pending.state, 'awaiting_approval')
  assert.deepEqual(pending.agent_client_wait, {
    state: 'timed_out',
    invocation_id: invocationId,
    resume_required: true,
    resume_tool: 'resume_governed_tool_invocation',
    resume_attempts: 2,
    next_action: 'Resume this exact invocation_id; never call the original business tool again.',
  })
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 2)

  approved = true
  const resumed = await local.get('resume_governed_tool_invocation').execute(
    { invocation_id: invocationId },
    { agent, callId: 'manual-resume', signal: new AbortController().signal },
  )
  assert.equal(resumed.state, 'executed')
  assert.equal(resumed.invocation_id, invocationId)
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 3)

  const replayed = await local.get('resume_governed_tool_invocation').execute(
    { invocation_id: invocationId },
    { agent, callId: 'manual-resume-replay', signal: new AbortController().signal },
  )
  assert.deepEqual(replayed, resumed)
  assert.equal(callsFor(mock.calls, 'resume').length, 3)
})

test('retries only the same invocation for in-progress and retryable pre-dispatch states', async () => {
  let invocationId
  let resumeCount = 0
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => {
      invocationId = input.invocationId
      return invocation(input, 'in_progress', { auto_retry_allowed: true })
    },
    resume: async (id) => {
      resumeCount += 1
      if (resumeCount === 1) {
        return invocation(
          { invocationId: id },
          'rejected_before_dispatch',
          { auto_retry_allowed: true },
        )
      }
      return invocation({ invocationId: id }, 'executed')
    },
  })

  const result = await local.get('employee_update').execute(
    { employee_id: '42' },
    { agent, callId: 'in-progress-call', signal: new AbortController().signal },
  )
  assert.equal(result.state, 'executed')
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.deepEqual(
    callsFor(mock.calls, 'resume').map((call) => call.args[0]),
    [invocationId, invocationId],
  )
})
