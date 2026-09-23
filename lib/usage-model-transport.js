import { createHash } from 'node:crypto'
import { createFileSessionUsageStore } from './session-usage-store.js'
import { ModelGatewayTransport } from './model-gateway-transport.js'

const REQUEST_EVENT = 'bailinghub/usage-request'
const REQUIRED = ['capabilities', 'modelModels', 'modelSummary', 'modelComplete', 'modelStream', 'inspectModelRequest', 'cancelModelRequest']
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function exact(value, maximum = 191) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw failure('USAGE_INPUT_INVALID')
  return value
}
function failure(code, extra = {}) {
  const priority = code === 'USAGE_STORAGE_ERROR' ? 'storage_error' : code === 'USAGE_RECOVERY_GAP' ? 'recovery_gap' : 'blocked'
  return Object.assign(new Error(`The controlled usage service is unavailable (${code}).`), {
    code, state: priority, feedback: { schema: 'bailing.usage-feedback.v1', code,
      dispatch: 'not_dispatched', next_action: code === 'USAGE_UNSUPPORTED' ? 'upgrade' : 'resolve_error', retryable: false }, ...extra,
  })
}
function bindingOf(client) {
  const binding = client?.binding
  if (!binding || typeof binding !== 'object') throw failure('USAGE_UNSUPPORTED')
  return Object.fromEntries(['hubUrl', 'userId', 'accountId', 'serviceId'].map((key) => [key, exact(binding[key], key === 'hubUrl' ? 2048 : 191)]))
}
function signalActive(signal) { if (signal?.aborted) throw failure('USAGE_CANCELLED') }
function validSession(session) {
  exact(session?.id, 4096)
  if (!Array.isArray(session.events)) throw failure('USAGE_RECOVERY_GAP')
}
// DSH also persists plugin context as user-role messages. Only the trusted
// producer's explicit source marks a real user input, never the model-facing role.
function isUserInput(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}
function eventFor(session, userMessageId) {
  validSession(session)
  const id = exact(userMessageId)
  const events = session.events.filter((event) => ['user/message', REQUEST_EVENT].includes(event?.type) && event.data?.id === id)
  if (events.length !== 1 || !Number.isSafeInteger(events[0].seq) || events[0].seq < 0) throw failure('USAGE_RECOVERY_GAP')
  if (events[0].type === REQUEST_EVENT) {
    if (events[0].data?.source !== 'host' || !['auxiliary', 'subagent', 'model'].includes(events[0].data?.kind)) throw failure('USAGE_RECOVERY_GAP')
  } else if (!isUserInput(events[0]) || events[0].data.role !== 'user') throw failure('USAGE_USER_MESSAGE_REQUIRED')
  return events[0]
}
function isLiveMessage(session, event) {
  if (event.type === REQUEST_EVENT) return !session.events.some(item => item.seq > event.seq && item.type === 'bailinghub/model-request-group-ended' && item.data?.id === event.data.id)
  return !session.events.some(item => item.seq > event.seq && (isUserInput(item) || item.type === 'turn/end'))
}
function primaryFailure(status) {
  if (status?.state === 'storage_error' || status?.status === 'storage_error' || status?.storageError || status?.unsavedEvents > 0) return failure('USAGE_STORAGE_ERROR')
  if (status?.state === 'recovery_gap' || status?.status === 'recovery_gap' || status?.recoveryGap) return failure('USAGE_RECOVERY_GAP')
  return null
}

/** Host-owned USD model transport. Planning and tool execution remain in the native AgentLoop. */
export class BailingHubUsageModelTransport {
  constructor({ client, store, ensureSessionPersisted, getPrimaryStatus, mode } = {}) {
    if (mode !== undefined && mode !== 'model_gateway') throw failure('USAGE_INPUT_INVALID')
    this.client = client
    this.store = store ?? createFileSessionUsageStore()
    this.ensureSessionPersisted = ensureSessionPersisted
    this.getPrimaryStatus = getPrimaryStatus
    this.queues = new Map()
    this.cancelled = new Set()
    this.ended = new Set()
    this.storageFailures = new Set()
    this.capabilitiesCache = null
    this.modelTransport = new ModelGatewayTransport(this, { failure, hash, exact, eventFor, isLiveMessage, signalActive })
  }
  assertSupported() {
    if (REQUIRED.some(method => typeof this.client?.[method] !== 'function') || typeof this.ensureSessionPersisted !== 'function') throw failure('USAGE_UNSUPPORTED')
    return bindingOf(this.client)
  }
  async primary(session) {
    validSession(session)
    let status
    try { status = await this.getPrimaryStatus?.(session) } catch { throw failure('USAGE_STORAGE_ERROR') }
    const existing = primaryFailure(status)
    if (existing) throw existing
    if (this.storageFailures.has(session.id)) throw failure('USAGE_STORAGE_ERROR')
  }
  async durable(session) {
    await this.primary(session)
    this.assertSupported()
    try { if (await this.ensureSessionPersisted(session) !== true) throw new Error() }
    catch { throw failure('USAGE_STORAGE_ERROR') }
  }
  serial(session, operation) {
    const previous = this.queues.get(session.id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.queues.set(session.id, current)
    current.finally(() => { if (this.queues.get(session.id) === current) this.queues.delete(session.id) }).catch(() => {})
    return current
  }
  async negotiate(options = {}) {
    this.assertSupported()
    if (!options.refresh && this.capabilitiesCache?.until > Date.now()) return this.capabilitiesCache.value
    const caps = await this.client.capabilities(options), token = caps?.model_gateway
    if (caps?.schema !== 'bailing.usage.v1' || caps.supported !== true || caps.streaming !== true || caps.orchestration !== 'host'
      || token?.schema !== 'bailing.model-gateway.v1' || token.supported !== true || token.turn_required !== false
      || token.provider_response !== 'bailing.provider-response.v1' || token.settlement !== 'asynchronous'
      || token.orchestration !== 'host' || token.streaming !== true || token.billing_unit !== 'USD') throw failure('USAGE_UNSUPPORTED')
    this.capabilitiesCache = { value: caps, until: Date.now() + 60_000 }
    return caps
  }
  async model(options = {}) {
    await this.negotiate(options)
    return this.modelTransport.model(options)
  }
  /** Fetch permitted tools for the local host to register, without starting a business run. */
  async modelTools(options = {}) {
    await this.negotiate(options)
    if (typeof this.client.modelTools !== 'function') throw failure('USAGE_UNSUPPORTED')
    return this.client.modelTools(options)
  }
  /** One local tool call, tracked durably using the same original-request recovery protocol. */
  async runModelTool(session, input, options = {}) {
    validSession(session)
    await this.durable(session)
    eventFor(session, input?.userMessageId)
    await this.negotiate(options)
    if (typeof this.client.runModelTool !== 'function' || typeof this.client.modelTools !== 'function') throw failure('USAGE_UNSUPPORTED')
    return this.modelTransport.complete(session, input, options, true)
  }
  async status(session, options = {}) {
    await this.primary(session)
    await this.negotiate(options)
    return this.modelTransport.status(session, options)
  }
  async complete(session, input, options = {}) {
    validSession(session)
    await this.durable(session)
    eventFor(session, input?.userMessageId)
    await this.negotiate(options)
    return this.modelTransport.complete(session, input, options)
  }
  /** A trusted host can meter a local helper/child request without inventing a user message.
   * For requests inside a user turn, prefer complete/stream with that original owner Session and userMessageId.
   */
  async prepareRequest(session, input) {
    validSession(session)
    if (!input || Object.keys(input).some(key => !['modelRequestId', 'serviceId', 'requestGroupId', 'requestKind',
      'messages', 'tools', 'tool_choice', 'temperature', 'provider_options'].includes(key))) throw failure('USAGE_INPUT_INVALID')
    const requestGroupId = exact(input.requestGroupId ?? `request_${hash(exact(input.modelRequestId)).slice(0, 40)}`)
    const kind = input.requestKind ?? 'model'
    if (!['model', 'auxiliary', 'subagent'].includes(kind)) throw failure('USAGE_INPUT_INVALID')
    await this.serial(session, async () => {
      await this.primary(session)
      const existing = session.events.find(e => [REQUEST_EVENT, 'user/message'].includes(e.type) && e.data?.id === requestGroupId)
      if (existing && (existing.type !== REQUEST_EVENT || existing.data.kind !== kind)) throw failure('USAGE_IDEMPOTENCY_CONFLICT')
      if (!existing) {
        if (typeof session.append !== 'function') throw failure('USAGE_RECOVERY_GAP')
        session.append(REQUEST_EVENT, { id: requestGroupId, kind, source: 'host' })
      }
      await this.durable(session)
    })
    return { ...input, userMessageId: requestGroupId }
  }
  async completeRequest(session, input, options = {}) {
    const prepared = await this.prepareRequest(session, input)
    return { ...await this.complete(session, prepared, options), request_group_id: prepared.userMessageId }
  }
  async *streamRequest(session, input, options = {}) {
    const prepared = await this.prepareRequest(session, input)
    for await (const event of this.stream(session, prepared, options)) yield event.type === 'operation'
      ? { ...event, operation: { ...event.operation, request_group_id: prepared.userMessageId } } : event
  }
  /** Backpressured preview stream; only the terminal delivery may resume the local loop. */
  async *stream(session, input, options = {}) {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const queue = []; let wake, stopped = false
    const put = value => { queue.push(value); wake?.(); wake = null }
    const running = this.complete(session, input, { ...options, signal,
      onDelta: event => stopped ? undefined : new Promise(resolve => put({ event, ack: resolve })) })
      .then(receipt => put({ event: { type: 'operation', operation: receipt }, done: true }), error => put({ error, done: true }))
    let current
    try {
      for (;;) {
        if (!queue.length) await new Promise(resolve => { wake = resolve })
        current = queue.shift()
        if (current.error) throw current.error
        if (!current.done && (signal.aborted || this.cancelled.has(`${session.id}:${input.userMessageId}`) || this.ended.has(`${session.id}:${input.userMessageId}`)
          || !isLiveMessage(session, eventFor(session, input.userMessageId)))) { current.ack?.(); current = null; continue }
        yield current.event
        const terminal = current.done
        current.ack?.(); current = null
        if (terminal) return
      }
    } finally {
      stopped = true; controller.abort(); current?.ack?.()
      for (const item of queue) item.ack?.()
      await running
    }
  }
  async recoverOperation(session, operationId, options = {}) {
    validSession(session)
    return this.modelTransport.recover(session, operationId, options)
  }
  async close(session, userMessageId, cancelled, options = {}) {
    validSession(session)
    return this.modelTransport.close(session, userMessageId, cancelled, options)
  }
  endTurn(session, userMessageId, options) { return this.close(session, userMessageId, false, options) }
  cancelTurn(session, userMessageId, options) { return this.close(session, userMessageId, true, options) }
}
export function createUsageModelTransport(options) { return new BailingHubUsageModelTransport(options) }
