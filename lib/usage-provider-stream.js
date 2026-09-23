const envelope = value => value?.schema === 'bailing.provider-response.v1'
const failure = code => Object.assign(new Error(`Model response unavailable (${code}).`), { code })

/** Feed a local provider adapter without replacing global fetch. The receipt pump is independent
 * of the body reader: adapters may stop at [DONE], but original-result persistence must finish.
 */
export async function* usageNativeModelChunks(events, consumeResponse) {
  let openResponse, failResponse, resolveReceipt, rejectReceipt, controller, cancelled = false
  let header, body = '', bytes = 0, ended = false
  const responseReady = new Promise((resolve, reject) => { openResponse = resolve; failResponse = reject })
  const receiptReady = new Promise((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject })
  // The pump can reject before either consumer reaches its await.
  responseReady.catch(() => {}); receiptReady.catch(() => {})
  const encoder = new TextEncoder()
  function open(value) {
    if (!envelope(value) || !['sse', 'json'].includes(value.format)
      || !Number.isInteger(value.status) || value.status < 200 || value.status > 599
      || value.content_type !== (value.format === 'sse' ? 'text/event-stream' : 'application/json')) throw failure('USAGE_STREAM_INCOMPLETE')
    if (header) {
      if (['format', 'status', 'content_type'].some(key => header[key] !== value[key])) throw failure('USAGE_STREAM_INCOMPLETE')
      return
    }
    header = value
    const stream = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled = true } })
    // Fetch forbids a body for these status codes. The saved body remains available to the receipt check.
    openResponse(new Response([204, 205, 304].includes(value.status) ? null : stream,
      { status: value.status, headers: { 'content-type': value.content_type } }))
  }
  function append(text) {
    if (typeof text !== 'string') throw failure('USAGE_STREAM_INCOMPLETE')
    const chunk = encoder.encode(text); bytes += chunk.byteLength
    if (bytes > 4 * 1024 * 1024) throw failure('USAGE_PROVIDER_RESPONSE_TOO_LARGE')
    body += text
    if (!cancelled) controller.enqueue(chunk)
  }
  const pump = (async () => {
    try {
      for await (const event of events) {
        if (ended) throw failure('USAGE_STREAM_INCOMPLETE')
        if (event.type === 'provider') { open(event.provider); append(event.provider.data) }
        if (event.type !== 'operation') continue
        const receipt = event.operation, saved = receipt?.response
        if (receipt?.result_state === 'failed' && receipt.delivery_state !== 'cancelled_late_result') throw Object.assign(new Error(receipt.error?.message ?? 'Model service rejected the request.'), {code: 'USAGE_PROVIDER_REJECTED', operationId: receipt.operation_id, feedback: {schema:'bailing.usage-feedback.v1',code:'USAGE_PROVIDER_REJECTED',dispatch:'rejected',next_action:'contact_operator',retryable:false}})
        if (receipt?.delivery_state !== 'response_ready' || receipt.host_turn_active !== true) throw failure(
          receipt?.delivery_state === 'cancelled_late_result' ? 'USAGE_CANCELLED' : 'USAGE_ORIGINAL_PENDING')
        const hadPreview = Boolean(header)
        open(saved)
        if (typeof saved.body !== 'string') throw failure('USAGE_STREAM_INCOMPLETE')
        if (!hadPreview) append(saved.body) // Recovery reads the recorded body once, never reissues a request.
        if (body !== saved.body) throw failure('USAGE_STREAM_INCOMPLETE')
        ended = true
        if (!cancelled) controller.close()
        resolveReceipt(receipt)
      }
      if (!ended) throw failure('USAGE_STREAM_INCOMPLETE')
    } catch (error) {
      if (controller && !cancelled) { try { controller.error(error) } catch {} }
      failResponse(error); rejectReceipt(error)
      throw error
    }
  })()
  pump.catch(() => {})
  try {
    const response = await responseReady
    for await (const chunk of consumeResponse(response)) {
      // No executable tool block or terminal marker before the original receipt is durable locally.
      if (chunk.type === 'finish' || chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
        || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) await receiptReady
      yield chunk
    }
    // Some native parsers return without a finish marker; AgentLoop must still not advance early.
    await receiptReady
    await pump
  } finally {
    // Drain the original operation even when a parser throws, returns early or cancels its reader.
    // No retry/model call is performed by this adapter.
    cancelled = true
    // A late local persistence/identity failure keeps priority over a parser error.
    await pump
  }
}
