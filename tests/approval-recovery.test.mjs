import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  baseAssembly,
  callsFor,
  createMockAgent,
  createMockHost,
  createMemorySessionScopeStore,
  selectSessionScope,
  MOCK_CONNECTION_KEY,
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
  createAgentClientPlugin({ scopeStore: createMemorySessionScopeStore(),
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
  await selectSessionScope(host, client.agent, [MOCK_CONNECTION_KEY])
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
    (error) => error.feedback.category === 'invalid_request' && error.feedback.dispatch === 'not_dispatched',
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

test('rate hints pause polling and manual resume retains the original call and authorization', async () => {
  let now = 0
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => invocation(input, 'rejected_before_dispatch', {
      auto_retry_allowed: true, retry_after_ms: 3_600_000,
      rate_limit: { level: 'tool', count: 120, window_sec: 3600, scope: 'tool_provider_shared', source: 'declaration' },
    }),
    resume: async (id) => invocation({ invocationId: id }, 'executed'),
  }, { now: () => now, sleep: async (ms) => { now += ms } })
  const result = await local.get('employee_update').execute({ employee_id: '42' }, { agent, callId: 'rate-first', signal: new AbortController().signal })
  assert.equal(result.agent_client_wait.state, 'rate_limited')
  assert.equal(result.rate_limit.count, 120)
  assert.equal(callsFor(mock.calls, 'resume').length, 0)
  const early = await local.get('resume_governed_tool_invocation').execute({ invocation_id: result.invocation_id }, { agent, callId: 'rate-early', signal: new AbortController().signal })
  assert.equal(early.agent_client_wait.state, 'rate_limited')
  assert.equal(callsFor(mock.calls, 'resume').length, 0)
  now = 3_600_000
  const completed = await local.get('resume_governed_tool_invocation').execute({ invocation_id: result.invocation_id }, { agent, callId: 'rate-due', signal: new AbortController().signal })
  assert.equal(completed.state, 'executed')
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.deepEqual(callsFor(mock.calls, 'resume').map((call) => call.args[0]), [result.invocation_id])
})

test('short rate waits honor the server delay before resuming', async () => {
  let now = 0
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => invocation(input, 'rejected_before_dispatch', { auto_retry_allowed: true, retry_after_ms: 250 }),
    resume: async (id) => { assert.ok(now >= 250); return invocation({ invocationId: id }, 'executed') },
  }, { now: () => now, sleep: async (ms) => { now += ms } })
  const result = await local.get('employee_update').execute({ employee_id: '42' }, { agent, callId: 'rate-short', signal: new AbortController().signal })
  assert.equal(result.state, 'executed')
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 1)
})

test('cancellation during a rate wait prevents resume even if host sleep resolves', async () => {
  const controller = new AbortController()
  const { mock, agent, local } = await createApprovalRuntime({
    invoke: async (input) => invocation(input, 'rejected_before_dispatch', { auto_retry_allowed: true, retry_after_ms: 250 }),
  }, { sleep: async () => { controller.abort() } })
  await assert.rejects(local.get('employee_update').execute({ employee_id: '42' }, { agent, callId: 'rate-cancel', signal: controller.signal }), (error) => error.feedback?.category === 'cancelled')
  assert.equal(callsFor(mock.calls, 'invoke').length, 1)
  assert.equal(callsFor(mock.calls, 'resume').length, 0)
})

for (const [label, fields] of [
  ['legacy transport without a public code', {}],
  ['generic HTTP 404', { statusCode: 404 }],
  ['unknown public code', { statusCode: 404, publicCode: 'private_unknown_code' }],
  ['public code without HTTP status', { publicCode: 'invocation_not_found' }],
  ['public code with conflicting HTTP 500', { statusCode: 500, publicCode: 'invocation_not_found' }],
  ['untrusted error code field', { statusCode: 404, code: 'invocation_not_found' }],
  ['temporary network failure', { statusCode: 0, publicCode: 'agent_transport_unavailable' }],
  ['timeout', { statusCode: 408, publicCode: 'agent_request_timeout' }],
]) {
  test(`recovery remains conservative for ${label}, without inferring from error text`, async () => {
    let originalId
    const unknown = () => Object.assign(new Error('PRIVATE_BODY invocation_not_found'), {
      disposition: 'accepted_unknown', ...fields,
    })
    const { host, mock, agent, local } = await createApprovalRuntime({
      invoke: async input => { originalId = input.invocationId; throw unknown() },
      resume: async id => { assert.equal(id, originalId); throw unknown() },
    }, { maxAttempts: 2 })
    const checkUnknown = error => {
      assert.equal(error.feedback.code, 'BAILINGHUB_ACCEPTED_UNKNOWN')
      assert.equal(error.feedback.category, 'invocation_outcome_unknown')
      assert.equal(error.feedback.next_action, 'resume_original')
      assert.equal(error.feedback.retryable, true)
      assert.equal(error.feedback.invocation_id, originalId)
      assert.notEqual(error.feedback.dispatch, 'not_dispatched')
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_BODY|private_unknown_code/)
      return true
    }
    await assert.rejects(local.get('employee_update').execute({ employee_id: '42' }, {
      agent, callId: 'original-unknown-write', signal: new AbortController().signal,
    }), checkUnknown)
    assert.equal(callsFor(mock.calls, 'resume').length, 2, 'polling keeps its finite recovery bound')
    await assert.rejects(host.services.get('bailingHubAgentClient').resume(originalId), checkUnknown)
    assert.equal(callsFor(mock.calls, 'resume').length, 3)
    assert.equal(callsFor(mock.calls, 'invoke').length, 1, 'no replacement business invocation')
  })
}

test('direct recovery keeps the original ID on definitive authorization errors', async () => {
  const id = 'c'.repeat(64)
  const { host, mock } = await createApprovalRuntime({
    resume: async () => { throw Object.assign(new Error('PRIVATE_AUTH_BODY'), {
      publicCode: 'unauthorized', statusCode: 401, disposition: 'definitive_rejection',
    }) },
  })
  await assert.rejects(host.services.get('bailingHubAgentClient').resume(id), error => {
    assert.equal(error.feedback.invocation_id, id)
    assert.equal(error.feedback.category, 'authorization_unavailable')
    assert.equal(error.feedback.next_action, 'reauthorize')
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_AUTH_BODY/)
    return true
  })
  assert.equal(callsFor(mock.calls, 'invoke').length, 0)
})

for (const ending of ['signal cancellation', 'turn end']) {
  test(`late invocation_not_found preserves ${ending} and never revives an original write`, async () => {
    let originalId
    let reportResumeStarted
    let releaseResume
    const started = new Promise(resolve => { reportResumeStarted = resolve })
    const gate = new Promise(resolve => { releaseResume = resolve })
    const controller = new AbortController()
    const { host, mock, agent, local } = await createApprovalRuntime({
      invoke: async input => {
        originalId = input.invocationId
        return invocation(input, 'awaiting_approval', { approval_id: 47 })
      },
      resume: async id => {
        assert.equal(id, originalId)
        reportResumeStarted()
        await gate
        throw Object.assign(new Error('PRIVATE_LATE_RESPONSE'), {
          publicCode: 'invocation_not_found', statusCode: 404, disposition: 'accepted_unknown',
        })
      },
    })
    const definition = local.get('employee_update')
    const execution = definition.execute({ employee_id: '42' }, {
      agent, callId: 'cancel-before-missing-response', signal: controller.signal,
    })
    const rejected = assert.rejects(execution, error => {
      assert.equal(error.feedback.category, 'cancelled')
      assert.equal(error.feedback.invocation_id, originalId)
      assert.equal(error.feedback.retryable, false)
      assert.notEqual(error.feedback.code, 'invocation_not_found')
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_LATE_RESPONSE/)
      return true
    })
    await started
    if (ending === 'signal cancellation') controller.abort()
    else host.emit('session/event', agent.session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } },
    })
    releaseResume()
    await rejected
    await settle()
    assert.equal(callsFor(mock.calls, 'invoke').length, 1)
    assert.deepEqual(callsFor(mock.calls, 'resume').map(call => call.args[0]), [originalId])
    if (ending === 'turn end') {
      const runtime = host.services.get('bailingHubAgentClient')
      assert.equal(runtime.getSessionToolState(agent.session.id).state, 'inactive')
      assert.equal(local.has('employee_update'), false, 'a late response must not register tools again')
      await assert.rejects(definition.execute({ employee_id: '42' }, {
        agent, callId: 'ended-turn-write', signal: new AbortController().signal,
      }))
      assert.equal(callsFor(mock.calls, 'invoke').length, 1)
    }
  })
}

test('late invocation_not_found in direct recovery preserves an aborted signal and original ID', async () => {
  const id = 'd'.repeat(64)
  const controller = new AbortController()
  let reportResumeStarted
  let releaseResume
  const started = new Promise(resolve => { reportResumeStarted = resolve })
  const gate = new Promise(resolve => { releaseResume = resolve })
  const { host, mock } = await createApprovalRuntime({
    resume: async original => {
      assert.equal(original, id)
      reportResumeStarted()
      await gate
      throw Object.assign(new Error('PRIVATE_DIRECT_LATE_RESPONSE'), {
        publicCode: 'invocation_not_found', statusCode: 404, disposition: 'accepted_unknown',
      })
    },
  })
  const execution = host.services.get('bailingHubAgentClient').resume(id, { signal: controller.signal })
  const rejected = assert.rejects(execution, error => {
    assert.equal(error.feedback.category, 'cancelled')
    assert.equal(error.feedback.invocation_id, id)
    assert.equal(error.feedback.retryable, false)
    assert.notEqual(error.feedback.code, 'invocation_not_found')
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_DIRECT_LATE_RESPONSE/)
    return true
  })
  await started
  controller.abort()
  releaseResume()
  await rejected
  assert.equal(callsFor(mock.calls, 'invoke').length, 0)
  assert.deepEqual(callsFor(mock.calls, 'resume').map(call => call.args[0]), [id])
})
