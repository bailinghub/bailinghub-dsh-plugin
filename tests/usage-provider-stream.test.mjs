import test from 'node:test'
import assert from 'node:assert/strict'
import { usageNativeModelChunks, usageLlmChunks } from '../lib/index.js'
const header = { schema: 'bailing.provider-response.v1', format: 'sse', status: 200, content_type: 'text/event-stream' }
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
const receipt = (body, extra = {}, h = header) => ({ delivery_state: 'response_ready', host_turn_active: true,
  billing_state: 'pending', response: { ...h, body }, ...extra })
const collect = async iterable => { const out = []; for await (const value of iterable) out.push(value); return out }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function* events(body, extra = {}, h = header) {
  for (let i = 0; i < body.length; i += 7) yield { type: 'provider', provider: { ...h, data: body.slice(i, i + 7) } }
  yield { type: 'operation', operation: receipt(body, extra, h) }
}

test('native adapter sees original SSE bytes and can stop early; pump still waits for durable receipt, not billing', async () => {
  const gate = deferred(), reached = deferred(); let saved = false, original = ''
  const body = frame({ content: '你好' }, 'stop') + 'data: [DONE]\n\n'
  async function* source() {
    yield { type: 'provider', provider: { ...header, data: body } }
    reached.resolve(); await gate.promise; saved = true
    yield { type: 'operation', operation: receipt(body) }
  }
  async function* parser(response) {
    const reader = response.body.getReader(); original = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel() // Native parsers commonly do this on [DONE].
    yield { type: 'text-delta', index: 0, text: '你好' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const iterator = usageNativeModelChunks(source(), parser)
  assert.equal((await iterator.next()).value.type, 'text-delta'); await reached.promise
  let finished = false; const terminal = iterator.next().then(result => { finished = true; return result })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(saved, false)
  gate.resolve(); assert.equal((await terminal).value.type, 'finish'); assert.equal(saved, true)
  assert.equal((await iterator.next()).done, true); assert.equal(original, body)
})

test('stop with tools and length with unfinished arguments follow local model semantics', async () => {
  for (const [reason, args, expected] of [['stop', '{"id":1}', 'stop'], ['length', '{"id":', 'max-tokens'], ['tool_calls', '{}', 'tool-calls']]) {
    const body = frame({ reasoning_content: 'check', content: null, tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'inspect', arguments: args } }] }, reason) + 'data: [DONE]\n\n'
    const chunks = await collect(usageLlmChunks(events(body)))
    assert.equal(chunks.at(-1).reason.kind, expected)
    assert.equal(chunks.find(c => c.type === 'tool-call-delta').argumentsDelta, args)
  }
})

test('JSON stays JSON, usage is optional, empty streams and native HTTP errors do not turn into unknown operations', async () => {
  const jsonHeader = { ...header, format: 'json', content_type: 'application/json' }
  const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], extension: 'retained' })
  let seen
  await collect(usageNativeModelChunks(events(body, {}, jsonHeader), async function* (response) {
    seen = [response.headers.get('content-type'), await response.text()]; yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  assert.deepEqual(seen, ['application/json', body])
  assert.equal((await collect(usageLlmChunks(events(body, {}, jsonHeader)))).at(-1).type, 'finish')
  await assert.rejects(collect(usageLlmChunks(events('{"error":"synthetic"}', {}, { ...jsonHeader, status: 429 }))), { code: 'MODEL_PROVIDER_HTTP_ERROR', status: 429 })
  await assert.rejects(collect(usageLlmChunks(events(frame({ content: 'partial' }) + 'data: [DONE]\n\n'))), { code: 'MODEL_PROVIDER_RESPONSE_INVALID' })
})

test('cancellation, failed local persistence, changed body and missing receipt never release tool execution or finish', async () => {
  const body = frame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'
  for (const scenario of ['cancel', 'persist', 'mismatch', 'absent']) {
    const chunks = []
    async function* source() {
      yield { type: 'provider', provider: { ...header, data: body } }
      if (scenario === 'persist') throw Object.assign(new Error('synthetic persistence failure'), { code: 'storage_error' })
      if (scenario !== 'absent') yield { type: 'operation', operation: receipt(body, scenario === 'cancel'
        ? { delivery_state: 'cancelled_late_result', host_turn_active: false }
        : scenario === 'mismatch' ? { response: { ...header, body: body + ' ' } } : {}) }
    }
    await assert.rejects(async () => { for await (const chunk of usageLlmChunks(source())) chunks.push(chunk) })
    assert(!chunks.some(c => c.type === 'finish' || c.type === 'tool-call-delta'))
  }
})

test('recovery parses saved envelope once without needing preview packets or a new request', async () => {
  const body = frame({ content: 'original' }, 'stop') + 'data: [DONE]\n\n'
  async function* source() { yield { type: 'operation', operation: receipt(body) } }
  const chunks = await collect(usageLlmChunks(source()))
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'original')
})

test('native parser returning without finish cannot advance before original receipt', async () => {
  const gate = deferred(); let returned = false
  async function* source() { yield { type: 'provider', provider: { ...header, data: 'data: [DONE]\n\n' } }; await gate.promise; yield { type: 'operation', operation: receipt('data: [DONE]\n\n') } }
  async function* parser(response) { await response.body.cancel() }
  const done = collect(usageNativeModelChunks(source(), parser)).then(() => { returned = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false); gate.resolve(); await done; assert.equal(returned, true)
})

test('late original persistence failure retains priority over an early native parser error', async () => {
  async function* source() {
    yield { type: 'provider', provider: { ...header, data: 'synthetic error body' } }
    await new Promise(resolve => setImmediate(resolve))
    throw Object.assign(new Error('synthetic primary failure'), { code: 'USAGE_STORAGE_ERROR' })
  }
  async function* parser(response) {
    await response.body.cancel()
    throw Object.assign(new Error('synthetic parser error'), { code: 'MODEL_PROVIDER_RESPONSE_INVALID' })
  }
  await assert.rejects(collect(usageNativeModelChunks(source(), parser)), { code: 'USAGE_STORAGE_ERROR' })
})
