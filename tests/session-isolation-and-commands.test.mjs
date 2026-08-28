import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClientPlugin } from '../lib/index.js'
import { parseCommandArguments } from '../lib/runtime.js'
import {
  baseAssembly,
  callsFor,
  createMockAgent,
  createMockHost,
  createMockTransport,
  userMessage,
} from './helpers/mock-host.mjs'

const config = {
  hubUrl: 'https://hub.example.com',
  clientAppId: 'dsh_client',
  workspace: 'demo',
  connectionName: 'personal',
}

async function assemble(host, agent, turn, text) {
  host.emit('agent/inbox/claimed', {
    agent,
    turn,
    message: userMessage(`message-${agent.id}-${turn}`, text),
  })
  return host.waterfall(
    'system-prompt/assemble',
    baseAssembly(),
    { agent, signal: new AbortController().signal },
    async () => baseAssembly(),
  )
}

async function waitFor(check, timeoutMilliseconds = 1_500) {
  const deadline = Date.now() + timeoutMilliseconds
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for asynchronous lifecycle work')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('keeps connection, conversation, run, and active definitions isolated per Agent session', async () => {
  const host = createMockHost()
  const mock = createMockTransport()
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)
  const first = createMockAgent('first')
  const second = createMockAgent('second')

  await Promise.all([
    assemble(host, first.agent, 1, 'First request'),
    assemble(host, second.agent, 1, 'Second request'),
  ])

  const starts = callsFor(mock.calls, 'startTurn')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].args[0].clientConversationId, starts[1].args[0].clientConversationId)
  assert.notEqual(starts[0].args[0].clientTurnId, starts[1].args[0].clientTurnId)
  assert.notEqual(starts[0].args[0].userMessageId, starts[1].args[0].userMessageId)
  assert.notEqual(first.local.get('employee_update'), second.local.get('employee_update'))

  await first.local.get('employee_update').execute(
    { employee_id: '1' },
    { agent: first.agent, callId: 'call-a', signal: new AbortController().signal },
  )
  await second.local.get('employee_update').execute(
    { employee_id: '2' },
    { agent: second.agent, callId: 'call-b', signal: new AbortController().signal },
  )
  const invokes = callsFor(mock.calls, 'invoke')
  assert.notEqual(invokes[0].args[0].agentRunId, invokes[1].args[0].agentRunId)
})

test('registers a real DSH command entrypoint including a credential-safe doctor', async () => {
  const host = createMockHost()
  const mock = createMockTransport()
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)

  const command = host.commands.get('bailinghub')
  assert.ok(command)
  const doctor = await command.handler({ rawInput: 'doctor' })
  assert.equal(doctor.kind, 'success')
  assert.match(doctor.text, /Overall: PASS/)
  assert.match(doctor.text, /DSH host contract: PASS/)
  assert.match(doctor.text, /connectionName selects one isolated browser authorization/)
  assert.doesNotMatch(doctor.text, /access_token|not-exposed|hub\.example\.com|personal/)

  for (const rawInput of ['login', 'status', 'logout', 'workspaces', 'sync']) {
    const result = await command.handler({ rawInput })
    assert.equal(result.kind, 'success')
  }
  const selected = await command.handler({ rawInput: 'use second_workspace' })
  assert.equal(selected.kind, 'success')

  const [login] = callsFor(mock.calls, 'login')
  assert.equal(login.args[0].workspace, 'demo')
  assert.equal(login.args[0].route, 'demo')
  assert.equal(login.args[0].clientAppId, 'dsh_client')
  const [use] = callsFor(mock.calls, 'use')
  assert.equal(use.args[0].workspace, 'second_workspace')
  assert.equal(use.args[0].route, 'second_workspace')
  assert.ok(host.services.has('bailingHubAgentClient'))
})

test('parses quoted connection names and exposes user-only connection lifecycle commands', async () => {
  assert.deepEqual(
    parseCommandArguments('connections add "second hub" https://two.example.com second_client staff'),
    ['connections', 'add', 'second hub', 'https://two.example.com', 'second_client', 'staff'],
  )
  assert.throws(() => parseCommandArguments('connections use "unfinished'), /unfinished quote/)

  const host = createMockHost()
  const mock = createMockTransport()
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)
  const command = host.commands.get('bailinghub')

  for (const rawInput of [
    'connections list',
    'connections add "second hub" https://two.example.com second_client staff',
    'connections use second',
    'connections remove second',
  ]) {
    const result = await command.handler({ rawInput })
    assert.equal(result.kind, 'success')
  }
  assert.deepEqual(callsFor(mock.calls, 'connectionsAdd')[0].args[0], {
    connectionName: 'second hub',
    hubUrl: 'https://two.example.com',
    clientAppId: 'second_client',
    workspace: 'staff',
  })
  assert.equal(callsFor(mock.calls, 'connectionsUse')[0].args[0], 'second')
  assert.equal(callsFor(mock.calls, 'connectionsRemove')[0].args[0], 'second')
})

test('connection switching affects only new Agent sessions while existing sessions stay pinned', async () => {
  const host = createMockHost()
  const mock = createMockTransport()
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)
  const first = createMockAgent('connection-first')
  await assemble(host, first.agent, 1, 'First request')

  const switched = await host.commands.get('bailinghub').handler({ rawInput: 'connections use second' })
  assert.equal(switched.kind, 'success')
  const second = createMockAgent('connection-second')
  await assemble(host, second.agent, 1, 'Second request')
  await assemble(host, first.agent, 2, 'First connection again')

  const starts = callsFor(mock.calls, 'startTurn')
  assert.equal(starts[0].args[1].connectionName, 'personal')
  assert.equal(starts[0].args[1].workspace, 'demo')
  assert.equal(starts[1].args[1].connectionName, 'second')
  assert.equal(starts[1].args[1].workspace, 'staff')
  assert.equal(starts[2].args[1].connectionName, 'personal')
  assert.equal(starts[2].args[1].workspace, 'demo')
})

test('doctor stops before SDK load when configuration is invalid', async () => {
  const host = createMockHost()
  let transportRequested = false
  createAgentClientPlugin({
    transportFactory: () => {
      transportRequested = true
      throw new Error('private transport failure')
    },
  }).apply(host.ctx, {
    hubUrl: '',
    clientAppId: '',
    workspace: '',
    connectionName: 'default',
  })

  const result = await host.commands.get('bailinghub').handler({ rawInput: 'doctor' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Overall: FAIL/)
  assert.match(result.text, /hubUrl, clientAppId, workspace/)
  assert.doesNotMatch(result.text, /private transport failure/)
  assert.equal(transportRequested, false)
})

test('doctor reports logged-out isolation without probing authorized workspaces', async () => {
  const host = createMockHost()
  const mock = createMockTransport({
    status: async () => ({ state: 'logged_out', refresh_token: 'must-not-leak' }),
    workspaces: async () => {
      throw new Error('must not probe workspaces before authorization')
    },
  })
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)

  const result = await host.commands.get('bailinghub').handler({ rawInput: 'doctor' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Authorization: FAIL \(logged_out\)/)
  assert.match(result.text, /Run \/bailinghub login/)
  assert.doesNotMatch(result.text, /refresh_token|must-not-leak/)
  assert.equal(callsFor(mock.calls, 'workspaces').length, 0)
})

test('keeps an immutable pending completion and lets the sync command replay it', async () => {
  let attempts = 0
  const host = createMockHost()
  const mock = createMockTransport({
    completeRun: async (runId, input) => {
      attempts += 1
      if (attempts <= 3) throw new Error('temporary upstream failure with unsafe details')
      return {
        schema: 'bailing.agent-run-completion.v1',
        run_id: runId,
        status: input.status,
      }
    },
  })
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)
  const { agent } = createMockAgent('completion-retry')
  await assemble(host, agent, 1, 'Update employee 42')

  host.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      message: {
        id: 'assistant-final',
        role: 'assistant',
        source: { provider: 'deepseek', model: 'deepseek-chat' },
        content: [{ type: 'text', text: 'Employee 42 was updated.' }],
      },
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  })
  host.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })

  await waitFor(() => callsFor(mock.calls, 'completeRun').length === 3)
  const failedPayloads = callsFor(mock.calls, 'completeRun').map((call) => call.args[1])
  assert.deepEqual(failedPayloads[1], failedPayloads[0])
  assert.deepEqual(failedPayloads[2], failedPayloads[0])

  const blockedSwitch = await host.commands.get('bailinghub').handler({
    rawInput: 'use second_workspace',
  })
  assert.equal(blockedSwitch.kind, 'error')
  assert.match(blockedSwitch.text, /sync pending completions/)
  assert.equal(callsFor(mock.calls, 'use').length, 0)

  const syncResult = await host.commands.get('bailinghub').handler({ rawInput: 'sync' })
  assert.equal(syncResult.kind, 'success')
  assert.match(syncResult.text, /"synced":1/)
  const allPayloads = callsFor(mock.calls, 'completeRun').map((call) => call.args[1])
  assert.equal(allPayloads.length, 4)
  assert.deepEqual(allPayloads[3], failedPayloads[0])
  assert.doesNotMatch(JSON.stringify(allPayloads[3]), /reasoning|unsafe upstream/)
})

test('degrades an unconfigured turn without loading the SDK or leaking tools', async () => {
  const host = createMockHost()
  let transportRequested = false
  const runtime = createAgentClientPlugin({
    transportFactory: () => {
      transportRequested = true
      throw new Error('should not load')
    },
  })
  runtime.apply(host.ctx, {
    hubUrl: '',
    clientAppId: '',
    workspace: '',
    connectionName: 'default',
  })
  const { agent } = createMockAgent('unconfigured')

  const assembly = await assemble(host, agent, 1, 'Try a business operation')
  assert.equal(transportRequested, false)
  assert.equal(assembly.tools.length, 0)
  assert.match(
    assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
    /configuration required/,
  )
})

test('does not upload non-user injected messages as new Core turns', async () => {
  const host = createMockHost()
  const mock = createMockTransport()
  createAgentClientPlugin({ transport: mock.transport }).apply(host.ctx, config)
  const { agent } = createMockAgent('synthetic')
  host.emit('agent/inbox/claimed', {
    agent,
    turn: 1,
    message: {
      id: 'plugin-message',
      role: 'user',
      source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'text', text: 'Synthetic context' }],
    },
  })
  await host.waterfall(
    'system-prompt/assemble',
    baseAssembly(),
    { agent, signal: new AbortController().signal },
    async () => baseAssembly(),
  )
  assert.equal(callsFor(mock.calls, 'startTurn').length, 0)
})
