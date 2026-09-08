import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  activeTool,
  callsFor,
  createMockTransport,
  SEARCH_CAPABILITY_REVISION,
  turnResponse,
  userMessage,
} from './helpers/mock-host.mjs'

const dshNodeModules = process.env.DSH_NODE_MODULES ?? resolve('node_modules')

async function importFromDsh(specifier) {
  return import(pathToFileURL(join(dshNodeModules, specifier)).href)
}

test('executes shared authorization envelopes in real DSH before and after scoped search replacement', { timeout: 10_000 }, async () => {
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime },
    { default: CommandRuntime }, { createScope }] = await Promise.all([
    importFromDsh('@deepseek-ai/cordis/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-system-prompt/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-tools/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-commands/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-scope/lib/index.js'),
  ])
  const config = {
    hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client',
    workspace: 'demo', connectionName: 'Store A',
  }
  const accounts = ['A', 'B'].map((label, index) => ({
    label,
    connectionKey: `conn_${String(index + 1).repeat(32)}`,
    sessionId: `123e4567-e89b-42d3-a456-42661417900${index + 1}`,
    runId: `123e4567-e89b-42d3-a456-42661417800${index + 1}`,
    revision: (index ? 'b' : 'a').repeat(64),
  }))
  const accountFor = (metadata) => {
    const key = metadata?.connectionKey ?? metadata?.connectionName
    const account = accounts.find((entry) => entry.connectionKey === key)
    assert.ok(account, 'real DSH dispatch must retain a fixed connection key')
    return account
  }
  const mock = createMockTransport({
    connectionsList: async () => ({
      currentConnectionKey: accounts[0].connectionKey,
      connections: accounts.map((account) => ({
        ...config,
        connectionKey: account.connectionKey,
        connectionName: `Store ${account.label}`,
        state: 'authorized',
        current: account.label === 'A',
      })),
    }),
    status: async (metadata) => {
      const account = accountFor(metadata)
      return { state: 'authorized', workspace: 'demo', connectionKey: account.connectionKey, sessionId: account.sessionId }
    },
    startTurn: async (_input, metadata) => {
      const account = accountFor(metadata)
      return turnResponse({ runId: account.runId, capabilityRevision: account.revision })
    },
    searchCapabilities: async (input, metadata) => {
      const account = accountFor(metadata)
      assert.equal(account.label, 'A')
      assert.equal(input.runId, account.runId)
      return {
        schema: 'bailing.agent-capability-search.v1',
        capability_revision: SEARCH_CAPABILITY_REVISION,
        tools: [activeTool('employee_read')],
      }
    },
    invoke: async (input, metadata) => {
      const account = accountFor(metadata)
      assert.equal(input.agentRunId, account.runId)
      assert.equal(input.capabilityRevision, input.tool === 'employee_read' ? SEARCH_CAPABILITY_REVISION : account.revision)
      assert.deepEqual(input.arguments, { employee_id: `${account.label}-42` })
      return {
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: input.invocationId,
        route: 'demo', tool: input.tool,
        state: 'executed', ok: true, auto_retry_allowed: false,
        text: `Store ${account.label} operation completed.`,
      }
    },
  })
  const ctx = new Context()
  let agentScope
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(CommandRuntime, {})
    await ctx.plugin(createAgentClientPlugin({ transport: mock.transport }), config)
    const runtime = ctx.get('bailingHubAgentClient')
    const agent = { id: 'real-dsh-multi-agent', session: { id: 'real-dsh-multi-session' } }
    agentScope = createScope(runtime.ctx, agent)
    agent.ctx = agentScope.ctx
    runtime.onInboxClaimed({
      agent, turn: 1,
      message: userMessage('real-dsh-multi-user', 'Update Store A, then find its read capability.'),
    })
    const assemble = () => ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
    const assembly = await assemble()
    const directoryLine = assembly.sections.flatMap((section) => section.text.split('\n'))
      .find((line) => line.startsWith('Authorization directory: '))
    assert.ok(directoryLine)
    const refs = Object.fromEntries(JSON.parse(directoryLine.slice('Authorization directory: '.length))
      .map((entry) => [entry.label, entry.authorization_ref]))
    const initialTools = agent.ctx.tools.schemas(agent)
    assert.equal(initialTools.filter((tool) => tool.name === 'employee_update').length, 1)
    assert.deepEqual(new Set(initialTools.find((tool) => tool.name === 'employee_update')
      .parameters.properties.authorization_ref.enum), new Set(Object.values(refs)))
    const execute = (callId, name, args) => agent.ctx.tools.execute({
      callId, name, arguments: args, agent, signal: new AbortController().signal,
    })
    const first = await execute('real-multi-write-A', 'employee_update', {
      authorization_ref: refs['Store A'], arguments: { employee_id: 'A-42' },
    })
    assert.equal(first.isError, false)
    assert.equal(callsFor(mock.calls, 'invoke').length, 1)
    assert.equal(accountFor(callsFor(mock.calls, 'invoke')[0].args[1]).label, 'A')

    const search = await execute('real-multi-search-A', 'search_business_capabilities', {
      query: 'read employee', limit: 8, authorization_ref: refs['Store A'],
    })
    assert.equal(search.isError, false)
    assert.equal(callsFor(mock.calls, 'searchCapabilities').length, 1)
    const updatedTools = agent.ctx.tools.schemas(agent)
    assert.equal(updatedTools.filter((tool) => tool.name === 'search_business_capabilities').length, 1)
    assert.deepEqual(updatedTools.find((tool) => tool.name === 'employee_read')
      .parameters.properties.authorization_ref.enum, [refs['Store A']])
    assert.deepEqual(updatedTools.find((tool) => tool.name === 'employee_update')
      .parameters.properties.authorization_ref.enum, [refs['Store B']])
    assert.equal((await execute('real-multi-read-A', 'employee_read', {
      authorization_ref: refs['Store A'], arguments: { employee_id: 'A-42' },
    })).isError, false)
    assert.equal((await execute('real-multi-write-B', 'employee_update', {
      authorization_ref: refs['Store B'], arguments: { employee_id: 'B-42' },
    })).isError, false)
    assert.deepEqual(callsFor(mock.calls, 'invoke').map((call) => [call.args[0].tool, accountFor(call.args[1]).label]), [
      ['employee_update', 'A'], ['employee_read', 'A'], ['employee_update', 'B'],
    ])
    const rejected = await execute('real-multi-wrong-target', 'employee_update', {
      authorization_ref: refs['Store A'], arguments: { employee_id: 'A-42' },
    })
    assert.equal(rejected.isError, true)
    assert.equal(callsFor(mock.calls, 'invoke').length, 3)
    const reassembled = await assemble()
    assert.deepEqual(reassembled.tools.find((tool) => tool.name === 'employee_read')
      .parameters.properties.authorization_ref.enum, [refs['Store A']])
    assert.deepEqual(reassembled.tools.find((tool) => tool.name === 'employee_update')
      .parameters.properties.authorization_ref.enum, [refs['Store B']])
  } finally {
    await agentScope?.dispose()
    await ctx.fiber.dispose()
  }
})

test('loads in the installed real DSH lifecycle and safely replaces the executing search tool', async () => {
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime },
    { default: CommandRuntime }, { createScope }] = await Promise.all([
    importFromDsh('@deepseek-ai/cordis/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-system-prompt/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-tools/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-commands/lib/index.js'),
    importFromDsh('@deepseek-ai/dsh-scope/lib/index.js'),
  ])

  const ctx = new Context()
  let agentScope
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(CommandRuntime, {})
    const mock = createMockTransport({
      searchCapabilities: async () => ({
        schema: 'bailing.agent-capability-search.v1',
        capability_revision: SEARCH_CAPABILITY_REVISION,
        tools: [activeTool('employee_read')],
      }),
    })
    await ctx.plugin(createAgentClientPlugin({ transport: mock.transport }), {
      hubUrl: 'https://hub.example.com',
      clientAppId: 'dsh_client',
      workspace: 'demo',
      connectionName: 'personal',
    })

    const runtime = ctx.get('bailingHubAgentClient')
    assert.ok(runtime)
    const agent = { id: 'real-dsh-agent', session: { id: 'real-dsh-session' } }
    // Real DSH creates an Agent scope from a context that has declared the
    // tools dependency. The plugin context has exactly that dependency set.
    agentScope = createScope(runtime.ctx, agent)
    agent.ctx = agentScope.ctx
    const command = ctx.commands.find(agent, 'bailinghub')
    assert.ok(command)
    const status = await command.handler({
      agent,
      rawInput: 'status',
      signal: new AbortController().signal,
    })
    assert.equal(status.kind, 'success')
    const doctor = await command.handler({
      agent,
      rawInput: 'doctor',
      signal: new AbortController().signal,
    })
    assert.equal(doctor.kind, 'success')
    assert.match(doctor.text, /DSH host contract: PASS/)
    runtime.onInboxClaimed({
      agent,
      turn: 1,
      message: userMessage('rc7-user-message', 'Find the employee read capability.'),
    })

    const assembly = await ctx.systemPrompt.assemble({
      scope: agent,
      agent,
      signal: new AbortController().signal,
    })
    assert.ok(assembly.tools.some((tool) => tool.name === 'search_business_capabilities'))
    assert.ok(agent.ctx.tools.get('search_business_capabilities', agent))

    const outcome = await agent.ctx.tools.execute({
      callId: 'rc7_search_1',
      name: 'search_business_capabilities',
      arguments: { query: 'read employee', limit: 8 },
      agent,
      signal: new AbortController().signal,
    })
    assert.equal(outcome.isError, false)
    const visibleNames = agent.ctx.tools.schemas(agent).map((tool) => tool.name)
    assert.equal(visibleNames.includes('employee_update'), false)
    assert.equal(visibleNames.includes('employee_read'), true)
    assert.equal(visibleNames.includes('search_business_capabilities'), true)
  } finally {
    await agentScope?.dispose()
    await ctx.fiber.dispose()
  }
})
