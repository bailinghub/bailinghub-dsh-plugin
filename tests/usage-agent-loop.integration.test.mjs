import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { usageLlmChunks } from '../lib/usage-llm-stream.js'
import { createUsageModelTransport } from '../lib/usage-model-transport.js'
import { createFileSessionUsageStore } from '../lib/session-usage-store.js'

// Run against an installed DSH distribution: DSH_NODE_MODULES=/path/to/node_modules.
// The pinned development dependency makes this regression mandatory in normal verification.
const modules = process.env.DSH_NODE_MODULES ?? resolve('node_modules')
const entry = name => join(modules, '@deepseek-ai', name, 'lib/index.js')
await access(entry('dsh-agent-loop'))
const load = name => import(pathToFileURL(entry(name)).href)

for (const streaming of [false, true]) test(`real AgentLoop retains the real user input through runtime snapshots and tool additionalContexts (${streaming ? 'stream' : 'buffered'})`, { timeout: 15_000 }, async t => {
  const [{ Context }, { default: Agents }, { default: Sessions, Session }, { default: Llm, LlmAdapter, createUserMessage },
    { default: SystemPrompt }, { default: Tools }, { default: AgentLoop }] = await Promise.all([
    load('cordis'), load('dsh-agent'), load('dsh-session'), load('dsh-llm'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-agent-loop'),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'bailing-usage-loop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Agents, {}); await ctx.plugin(Sessions, {}); await ctx.plugin(Llm, {})
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, { mode: 'native' }); await ctx.plugin(AgentLoop, { agents: [] })
  let contextVersion = 1, dispatches = 0, inspections = 0, toolCalls = 0
  const originals = new Map(), deliveries = [], observed = [], errors = []
  const binding = { hubUrl: 'https://hub.example.com', userId: 'synthetic-user', accountId: 'synthetic-account', serviceId: 'text' }
  const client = {
    binding, capabilities: async () => ({ schema: 'bailing.usage.v1', supported: true, streaming: true, orchestration: 'host', model_gateway: {
      schema: 'bailing.model-gateway.v1', supported: true, streaming: true, orchestration: 'host', billing_unit: 'USD', turn_required: false, provider_response: 'bailing.provider-response.v1', settlement: 'asynchronous',
    } }), modelSummary: async () => ({}), modelModels: async () => ({ items: [] }),
    modelComplete: async input => {
      dispatches++
      const result = { schema: 'bailing.model-operation.v1', operation_id: input.operation_id, turn_id: input.turn_id, conversation_id: input.conversation_id,
        account_id: binding.accountId, user_id: binding.userId, service_id: input.service_id, state: 'completed', result_state: 'complete', billing_state: 'pending', dispatch: 'completed',
        response: { blocks: dispatches === 1 ? [{ type: 'tool-call', id: 'synthetic-tool-call', name: 'synthetic_read', arguments: '{}' }]
          : [{ type: 'text', text: 'Synthetic task complete.' }] } }
      originals.set(input.operation_id, result); return result
    },
    inspectModelRequest: async id => { inspections++; return originals.get(id) }, cancelModelRequest: async id => originals.get(id),
  }
  client.modelStream = async function* (input) {
    const result = await client.modelComplete(input)
    const tool = result.response.blocks.find(block => block.type === 'tool-call')
    const text = result.response.blocks.find(block => block.type === 'text')?.text
    const message = { role: 'assistant', content: text ?? null, ...(tool ? { tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] } : {}) }
    result.response = { choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }] }
    if (tool) {
      assert.equal(toolCalls, 0)
      yield { type: 'delta', delta: { tool_calls: [{ index: 0, id: tool.id, function: { name: tool.name, arguments: '{' } }] } }
      assert.equal(toolCalls, 0, 'partial function deltas never execute in the native loop')
    } else {
      yield { type: 'delta', delta: { content: text.slice(0, 10) } }
      yield { type: 'delta', delta: { content: text.slice(10) } }
    }
    yield { type: 'operation', operation: result }
  }
  const persisted = join(directory, 'session.json')
  const usage = createUsageModelTransport({ client, store: createFileSessionUsageStore({ directory: join(directory, 'usage') }),
    ensureSessionPersisted: async session => { await writeFile(`${persisted}.tmp`, JSON.stringify({ id: session.id, events: session.events })); await rename(`${persisted}.tmp`, persisted); return true } })
  ctx.systemPrompt.context({ name: 'synthetic-runtime', order: 1, text: () => `Synthetic context revision ${contextVersion}.` })
  ctx.tools.register({ name: 'synthetic_read', description: 'Read a synthetic value.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, render: () => [{ type: 'text', text: 'Synthetic result' }] },
    execute: async (_args, exec) => { toolCalls++; contextVersion++
      exec.deferContext(createUserMessage({ source: { kind: 'plugin', plugin: 'synthetic-tool' }, content: [{ type: 'text', text: 'Synthetic tool context' }] }))
      return { ok: true }
    } })
  ctx.on('agent/error', event => errors.push(event.error ?? event))
  class ControlledSyntheticAdapter extends LlmAdapter {
    async *stream(options) {
      const session = ctx.sessions.get(options.sessionId)
      const anchor = session.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const step = session.events.findLast(event => event.type === 'step/start')
      const modelRequestId = `step-${step.seq}`
      session.append('synthetic/model-step', { id: modelRequestId, userMessageId: anchor.data.id })
      const input = { userMessageId: anchor.data.id, modelRequestId, messages: options.messages }
      observed.push({ anchor: anchor.data.id, sources: session.events.filter(event => event.type === 'user/message').map(event => event.data.source.kind) })
      if (streaming) {
        async function* observedStream() {
          for await (const event of usage.stream(session, input, { signal: options.signal })) {
            if (event.type === 'operation') deliveries.push(event.operation)
            yield event
          }
        }
        yield* usageLlmChunks(observedStream())
        return
      }
      const receipt = await usage.complete(session, input, { signal: options.signal })
      assert.equal(receipt.host_turn_active, true); deliveries.push(receipt)
      if (dispatches === 2) {
        assert.ok(session.events.some(event => event.type === 'tool/result'))
        assert.ok(session.events.some(event => event.type === 'user/message' && event.data.source.plugin === 'synthetic-tool'))
        const before = dispatches
        assert.equal((await usage.complete(session, input)).host_turn_active, true)
        assert.equal((await usage.recoverOperation(session, receipt.operation_id)).host_turn_active, true)
        assert.equal(dispatches, before)
        const plugin = session.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
        await assert.rejects(usage.complete(session, { ...input, userMessageId: plugin.data.id, modelRequestId: 'plugin-cannot-pay' }), { code: 'USAGE_USER_MESSAGE_REQUIRED' })
      }
      for (const [index, block] of receipt.response.blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: receipt.response.blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['synthetic-controlled'], new ControlledSyntheticAdapter())
  const handle = await ctx.agents.create({ sessionId: 'synthetic-usage-loop', agentOptions: { provider: 'synthetic-controlled', model: 'synthetic' } })
  t.after(() => handle.dispose())
  const first = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic first task.' }] })
  handle.agent.send(first, 'next-turn', true); await handle.agent.whenIdle()
  assert.deepEqual(errors, []); assert.equal(dispatches, 2); assert.equal(toolCalls, 1); assert.equal(inspections, streaming ? 0 : 2)
  assert.equal(observed[0].sources.at(-1), 'plugin'); assert.equal(observed[1].sources.filter(source => source === 'plugin').length, 3)
  assert.equal(deliveries[0].turn_id, deliveries[1].turn_id)
  assert.equal((await usage.recoverOperation(handle.agent.session, deliveries[0].operation_id)).host_turn_active, false)
  const second = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic next task.' }] })
  handle.agent.send(second, 'next-turn', true); await handle.agent.whenIdle()
  assert.deepEqual(errors, []); assert.equal(dispatches, 3); assert.notEqual(deliveries[2].turn_id, deliveries[1].turn_id)
  const saved = JSON.parse(await readFile(persisted, 'utf8'))
  assert.equal(saved.events.filter(event => event.type === 'bailinghub/model-request').length, 3)
  assert.equal(Session.create(saved.id, saved.events).id, handle.agent.session.id)
})
