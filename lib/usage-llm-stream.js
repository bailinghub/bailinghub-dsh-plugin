import { usageNativeModelChunks } from './usage-provider-stream.js'

const fail = (code = 'USAGE_STREAM_INCOMPLETE') => Object.assign(new Error(`Model gateway response is unavailable (${code}).`), {
  code, feedback: { schema: 'bailing.usage-feedback.v1', code, dispatch: 'unknown', next_action: 'inspect_original', retryable: true },
})
const object = value => value && typeof value === 'object' && !Array.isArray(value)

/** Convert gateway events to the native DSH model stream. No planning or tool execution lives here.
 * Preview text is incremental. Tool blocks and finish are exposed only after an active durable receipt.
 */
async function* legacyChunks(events) {
  const textBlocks = new Map(); let index = 0, ended = false
  function block(type) {
    let value = textBlocks.get(type)
    if (!value) { value = { index: index++, text: '', started: false }; textBlocks.set(type, value) }
    return value
  }
  for await (const event of events) {
    if (ended) throw fail()
    if (event.type === 'delta') {
      for (const [key, type] of [['reasoning_content', 'reasoning'], ['content', 'text']]) {
        const value = event.delta?.[key]
        if (value == null || value === '') continue
        if (typeof value !== 'string') throw fail()
        const part = block(type)
        if (!part.started) { part.started = true; yield { type: 'block-start', index: part.index, blockType: type } }
        part.text += value
        yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: part.index, text: value }
      }
      continue
    }
    if (event.type !== 'operation') continue
    const receipt = event.operation
    if (receipt?.result_state === 'failed' && receipt.delivery_state !== 'cancelled_late_result') throw Object.assign(new Error(receipt.error?.message ?? 'Model service rejected the request.'), {code: 'USAGE_PROVIDER_REJECTED', operationId: receipt.operation_id, feedback: {schema:'bailing.usage-feedback.v1',code:'USAGE_PROVIDER_REJECTED',dispatch:'rejected',next_action:'contact_operator',retryable:false}})
    if (receipt?.delivery_state !== 'response_ready' || receipt.host_turn_active !== true) throw fail(
      receipt?.delivery_state === 'cancelled_late_result' ? 'USAGE_CANCELLED' : receipt?.response_expired === true ? 'USAGE_ORIGINAL_RESULT_EXPIRED' : 'USAGE_ORIGINAL_PENDING')
    const response = receipt.response, choice = response?.choices?.[0], message = choice?.message
    if (!Array.isArray(response?.choices) || !object(message)
      || !['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw fail('USAGE_RESPONSE_INVALID')
    const calls = message.tool_calls ?? [], ids = new Set()
    if (!Array.isArray(calls)) throw fail('USAGE_RESPONSE_INVALID')
    for (const call of calls) {
      if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id)
        || typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') throw fail('USAGE_RESPONSE_INVALID')
      ids.add(call.id)
    }
    // Validate the whole final response against displayed previews before completing any native block.
    for (const [key, type] of [['reasoning_content', 'reasoning'], ['content', 'text']]) {
      const value = message[key] ?? ''
      if (typeof value !== 'string' || !value.startsWith(textBlocks.get(type)?.text ?? '')) throw fail('USAGE_RESPONSE_INVALID')
    }
    for (const [key, type] of [['reasoning_content', 'reasoning'], ['content', 'text']]) {
      const value = message[key] ?? ''
      if (!value && !textBlocks.has(type)) continue
      const part = block(type)
      if (!part.started) yield { type: 'block-start', index: part.index, blockType: type }
      if (value.length > part.text.length) yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: part.index, text: value.slice(part.text.length) }
      yield { type: 'block-end', index: part.index, block: { type, text: value } }
    }
    for (const call of calls) {
      const i = index++, value = { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments }
      yield { type: 'block-start', index: i, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: i, id: value.id, name: value.name, argumentsDelta: value.arguments }
      yield { type: 'block-end', index: i, block: value }
    }
    const usage = response.usage, count = value => Number.isSafeInteger(value) && value >= 0
    if (count(usage?.prompt_tokens) && count(usage?.completion_tokens)) {
      const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
      if (count(cached) && cached <= usage.prompt_tokens) yield { type: 'usage', usage: {
        inputTokens: usage.prompt_tokens - cached, outputTokens: usage.completion_tokens, ...(cached ? { cacheReadTokens: cached } : {}),
      } }
    }
    ended = true
    yield { type: 'finish', reason: { kind: choice.finish_reason === 'length' ? 'max-tokens' : choice.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop' } }
  }
  if (!ended) throw fail()
}


/** OpenAI-compatible parsing is local. Provider-specific adapters can use usageNativeModelChunks. */
async function* compatibleChunks(response) {
  const localError = () => Object.assign(new Error('The provider response could not be parsed by the local model adapter.'), {
    code: 'MODEL_PROVIDER_RESPONSE_INVALID', status: response.status,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(new Error(`Model provider returned HTTP ${response.status}.`), { code: 'MODEL_PROVIDER_HTTP_ERROR', status: response.status })
  }
  async function* parsed() {
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      let value
      try { value = await response.json() } catch { throw localError() }
      yield { type: 'operation', operation: { delivery_state: 'response_ready', host_turn_active: true, response: value } }
      return
    }
    let buffer = '', data = [], content = '', reasoning = '', finish, usage
    const calls = new Map(), reader = response.body.getReader(), decoder = new TextDecoder()
    const frame = text => {
      if (!text || text === '[DONE]') return null
      try { return JSON.parse(text) } catch { throw localError() }
    }
    try {
      let eof = false
      while (!eof) {
        const next = await reader.read(); eof = next.done
        buffer += eof ? decoder.decode() : decoder.decode(next.value, { stream: true })
        let match
        while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
          const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length)
          if (line) { if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, '')); continue }
          const text = data.join('\n'); data = []
          if (text === '[DONE]') { eof = true; break }
          const value = frame(text)
          if (!value) continue
          if (value.error) throw localError()
          if (value.usage) usage = value.usage
          const choice = value.choices?.[0], delta = choice?.delta
          if (choice?.finish_reason != null) finish = choice.finish_reason
          if (!delta) continue
          if (typeof delta.content === 'string') content += delta.content
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0
            const target = calls.get(index) ?? { type: 'function', id: '', function: { name: '', arguments: '' } }
            if (call.id) target.id = call.id
            if (call.function?.name) target.function.name += call.function.name
            if (typeof call.function?.arguments === 'string') target.function.arguments += call.function.arguments
            calls.set(index, target)
          }
          yield { type: 'delta', delta: { content: delta.content, reasoning_content: delta.reasoning_content } }
        }
      }
    } finally { await reader.cancel().catch(() => {}) }
    // An incomplete provider stream is a local adapter error, not an unknown Hub operation.
    if (finish == null) throw localError()
    yield { type: 'operation', operation: { delivery_state: 'response_ready', host_turn_active: true, response: {
      choices: [{ message: { role: 'assistant', content, reasoning_content: reasoning, tool_calls: [...calls.values()] }, finish_reason: finish }], usage,
    } } }
  }
  try { yield* legacyChunks(parsed()) } catch (error) {
    if (['USAGE_RESPONSE_INVALID', 'USAGE_STREAM_INCOMPLETE'].includes(error.code)) throw localError()
    throw error
  }
}

export async function* usageLlmChunks(events) {
  const iterator = events[Symbol.asyncIterator]()
  let first
  do { first = await iterator.next() } while (!first.done && !['provider', 'delta', 'operation'].includes(first.value.type))
  async function* remaining() {
    try { if (!first.done) yield first.value; for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value } }
    finally { await iterator.return?.() }
  }
  if (first.value?.type === 'provider' || first.value?.operation?.response?.schema === 'bailing.provider-response.v1') {
    yield* usageNativeModelChunks(remaining(), compatibleChunks)
  } else yield* legacyChunks(remaining()) // Original saved requests from before the transport envelope.
}
