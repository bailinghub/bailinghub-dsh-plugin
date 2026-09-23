import test from 'node:test'
import assert from 'node:assert/strict'
import { usageLlmChunks } from '../lib/usage-llm-stream.js'

const receipt = { delivery_state: 'response_ready', host_turn_active: true, response: { choices: [{
  message: { role: 'assistant', content: 'Hello world', tool_calls: [{ type: 'function', id: 'call-1', function: { name: 'inspect', arguments: '{"id":7}' } }] }, finish_reason: 'tool_calls',
}], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } } }

test('native text deltas are immediate, tools wait for durable final response, final text does not duplicate previews', async () => {
  let released = false
  async function* events() {
    yield { type: 'delta', delta: { content: 'Hello' } }
    yield { type: 'delta', delta: { tool_calls: [{ index: 0, function: { name: 'inspect', arguments: '{' } }] } }
    released = true
    yield { type: 'operation', operation: receipt }
  }
  const chunks = [], iterator = usageLlmChunks(events())
  assert.equal((await iterator.next()).value.type, 'block-start')
  const delta = (await iterator.next()).value
  assert.equal(delta.type, 'text-delta'); assert.equal(released, false)
  chunks.push(delta)
  for await (const chunk of iterator) { if (chunk.type === 'tool-call-delta') assert.equal(released, true); chunks.push(chunk) }
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello world')
  assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 1)
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('incomplete, cancelled and inconsistent final streams cannot produce executable tool blocks or finish', async () => {
  for (const ending of [null, { ...receipt, host_turn_active: false, delivery_state: 'cancelled_late_result' },
    { ...receipt, response: { choices: [{ ...receipt.response.choices[0], message: { ...receipt.response.choices[0].message, content: 'different' } }] } }]) {
    const chunks = []
    async function* events() { yield { type: 'delta', delta: { content: 'Hello' } }; if (ending) yield { type: 'operation', operation: ending } }
    await assert.rejects(async () => { for await (const chunk of usageLlmChunks(events())) chunks.push(chunk) })
    assert.ok(chunks.some(c => c.type === 'text-delta'))
    assert.ok(!chunks.some(c => c.type === 'finish' || c.type === 'tool-call-delta' || c.type === 'block-end'))
  }
})
