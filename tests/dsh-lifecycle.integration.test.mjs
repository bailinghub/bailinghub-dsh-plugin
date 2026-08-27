import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  activeTool,
  createMockTransport,
  SEARCH_CAPABILITY_REVISION,
  userMessage,
} from './helpers/mock-host.mjs'

const dshNodeModules = process.env.DSH_NODE_MODULES

async function importFromDsh(specifier) {
  return import(pathToFileURL(join(dshNodeModules, specifier)).href)
}

test('loads in the installed real DSH lifecycle and safely replaces the executing search tool', {
  skip: dshNodeModules ? false : 'set DSH_NODE_MODULES to the installed DSH node_modules directory',
}, async () => {
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
