import { randomUUID } from 'node:crypto'

export const MODEL_REQUEST_EVENT = 'bailinghub/model-request'
const CLOSED_EVENT = 'bailinghub/model-request-group-ended'
const SCHEMA = 'bailing.usage-session.v1'
const META_SCHEMA = 'bailing.model-request.v1'
const REQUIRED = ['modelModels', 'modelSummary', 'modelComplete', 'modelStream', 'inspectModelRequest', 'cancelModelRequest']
const clone = value => structuredClone(value)

/** Request-sized sidecars prevent a long task from consuming a session-wide metadata budget.
 * The real durable Session is the original request index. No transcript or credential is copied.
 */
export class ModelGatewayTransport {
  constructor(host, helpers) { this.host = host; Object.assign(this, helpers) }
  assertSupported() {
    if (REQUIRED.some(name => typeof this.host.client?.[name] !== 'function')) throw this.failure('USAGE_UNSUPPORTED')
  }
  markers(session) { return session.events.filter(e => e.type === MODEL_REQUEST_EVENT) }
  locate(session, id) {
    const found = this.markers(session).filter(e => e.data?.operationId === id)
    if (found.length !== 1) throw this.failure('USAGE_RECOVERY_GAP')
    return found[0].data
  }
  key(session, id) { return `model:${this.hash(session.id)}:${id}` }
  async load(session, meta) {
    const owner = this.eventFor(session, meta.turnId)
    if (meta.schema !== META_SCHEMA || meta.conversationId !== session.id || meta.eventSeq !== owner.seq
      || meta.eventHash !== this.hash(owner.data) || this.hash(meta.binding) !== this.hash(this.host.assertSupported())) throw this.failure('USAGE_RECOVERY_GAP')
    let record
    try { record = await this.host.store.load(this.key(session, meta.operationId)) } catch { throw this.failure('USAGE_STORAGE_ERROR') }
    if (!record || record.schema !== SCHEMA || record.entries?.length !== 1
      || this.hash(record.entries[0].request?.metadata) !== this.hash(meta)) throw this.failure('USAGE_RECOVERY_GAP')
    return record
  }
  async save(session, record) {
    const previous = record.revision; record.revision++
    try { await this.host.store.save(record.sessionId, clone(record), previous || null) }
    catch { this.host.storageFailures.add(session.id); throw this.failure('USAGE_STORAGE_ERROR') }
  }
  closed(session, meta) {
    return this.host.cancelled.has(`${session.id}:${meta.turnId}`) || this.host.ended.has(`${session.id}:${meta.turnId}`)
      || session.events.some(e => e.type === CLOSED_EVENT && e.data?.id === meta.turnId)
      || !this.isLiveMessage(session, this.eventFor(session, meta.turnId))
  }
  async model(options = {}) {
    this.assertSupported()
    const key = options.serviceId ?? this.host.client.binding.serviceId
    const cached = this.host.modelModelsCache
    const hit = !options.refresh && cached?.until > Date.now()
    const models = hit ? cached.value : await this.host.client.modelModels(options)
    // Cache hits do not extend the freshness deadline; live plan edits must become visible.
    if (!hit) this.host.modelModelsCache = { value: clone(models), until: Date.now() + 60_000 }
    const model = models.items.find(item => item.service_id === key)
    if (!model) throw this.failure('SERVICE_NOT_ENTITLED', { feedback: { schema: 'bailing.usage-feedback.v1', code: 'SERVICE_NOT_ENTITLED', dispatch: 'not_dispatched', next_action: 'select_model', retryable: false } })
    return clone(model)
  }
  async complete(session, input, options = {}, modelTool = false) {
    this.assertSupported()
    let copied
    try { copied = clone(input) } catch { throw this.failure('USAGE_INPUT_INVALID') }
    if (!copied || typeof copied !== 'object' || Array.isArray(copied)
      || Object.keys(copied).some(key => !['userMessageId', 'modelRequestId', 'serviceId', 'requestGroupId', 'requestKind',
        ...(modelTool ? ['arguments'] : ['messages', 'tools', 'tool_choice', 'temperature', 'provider_options'])].includes(key))) throw this.failure('USAGE_INPUT_INVALID')
    const prepared = await this.host.serial(session, async () => {
      await this.host.durable(session)
      const binding = this.host.assertSupported()
      if (this.markers(session).some(marker => this.hash(marker.data?.binding) !== this.hash(binding))) throw this.failure('USAGE_BINDING_MISMATCH')
      const event = this.eventFor(session, copied.userMessageId), requestKey = this.exact(copied.modelRequestId)
      const serviceId = this.exact(copied.serviceId ?? this.host.client.binding.serviceId)
      const request = Object.fromEntries((modelTool ? ['arguments'] : ['messages', 'tools', 'tool_choice', 'temperature', 'provider_options'])
        .filter(key => copied[key] !== undefined).map(key => [key, copied[key]]))
      if (modelTool ? !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)
        : !Array.isArray(request.messages) || !request.messages.length) throw this.failure('USAGE_INPUT_INVALID')
      const requestHash = this.hash({ serviceId, kind: modelTool ? 'tool' : 'chat', ...request })
      const existing = this.markers(session).filter(item => item.data?.turnId === copied.userMessageId && item.data?.requestKey === requestKey)
      if (existing.length > 1) throw this.failure('USAGE_RECOVERY_GAP')
      if (existing.length) {
        const meta = existing[0].data
        if (meta.requestHash !== requestHash || meta.serviceId !== serviceId) throw this.failure('USAGE_IDEMPOTENCY_CONFLICT')
        return { receipt: await this.inspect(session, meta, options) }
      }
      if (this.host.cancelled.has(`${session.id}:${copied.userMessageId}`)) throw this.failure('USAGE_CANCELLED')
      this.signalActive(options.signal)
      if (this.host.ended.has(`${session.id}:${copied.userMessageId}`) || !this.isLiveMessage(session, event) || session.events.some(e => e.type === CLOSED_EVENT && e.data?.id === copied.userMessageId)) throw this.failure('USAGE_TURN_ENDED')
      // Preserve the original user/account/service credential binding alongside the selected model.
      // The server remains authoritative for its current plan and credential scope.
      if (modelTool) {
        const directory = await this.host.client.modelTools(options)
        const tool = directory.items.find(item => item.service_id === serviceId)
        if (!tool) throw this.failure('SERVICE_NOT_ENTITLED')
        if (!tool.callable) throw this.failure('USAGE_MODEL_TOOL_UNAVAILABLE')
      }
      const meta = { schema: META_SCHEMA, kind: modelTool ? 'tool' : 'chat', operationId: randomUUID(), requestKey, requestHash,
        binding: clone(this.host.assertSupported()), serviceId, conversationId: this.exact(session.id),
        turnId: copied.userMessageId, eventSeq: event.seq, eventHash: this.hash(event.data) }
      const record = { schema: SCHEMA, sessionId: this.key(session, meta.operationId), revision: 0,
        entries: [{ request: { metadata: meta, state: 'prepared' } }] }
      await this.save(session, record)
      if (typeof session.append !== 'function') throw this.failure('USAGE_RECOVERY_GAP')
      session.append(MODEL_REQUEST_EVENT, meta)
      await this.host.durable(session)
      if (options.signal?.aborted || this.closed(session, meta)) {
        record.entries[0].request.state = 'rejected'
        await this.save(session, record)
        throw this.afterFailure(this.failure(options.signal?.aborted ? 'USAGE_CANCELLED' : 'USAGE_TURN_ENDED'), meta, 'not_dispatched')
      }
      return { meta, request }
    })
    if (prepared.receipt) return prepared.receipt
    const { meta, request } = prepared
    const wire = { ...request, operation_id: meta.operationId, service_id: meta.serviceId,
      conversation_id: meta.conversationId, turn_id: meta.turnId }
    let result, receivedFrame = false
    try {
      await this.host.primary(session); this.signalActive(options.signal)
      if (this.closed(session, meta)) throw this.failure('USAGE_TURN_ENDED')
      if (modelTool) result = await this.host.client.runModelTool(wire, options)
      else if (options.onDelta) {
        for await (const frame of this.host.client.modelStream(wire, options)) {
          receivedFrame = true
          if (frame.type === 'operation') result = frame.operation
          else if (['delta', 'provider'].includes(frame.type) && !options.signal?.aborted && !this.closed(session, meta)) {
            await this.host.primary(session)
            await options.onDelta({ ...frame, preview: true, executable: false })
          }
        }
        if (!result) throw this.failure('USAGE_STREAM_INCOMPLETE', { feedback: { schema: 'bailing.usage-feedback.v1', code: 'USAGE_STREAM_INCOMPLETE', dispatch: 'unknown', next_action: 'inspect_original', retryable: true } })
      } else result = await this.host.client.modelComplete(wire, options)
    } catch (error) {
      if (receivedFrame && error?.feedback) error.feedback = { ...error.feedback, dispatch: 'unknown', next_action: 'inspect_original' }
      if (['USAGE_INPUT_LIMIT', 'USAGE_UNSUPPORTED', 'SERVICE_NOT_ENTITLED'].includes(error?.code)) this.host.modelModelsCache = null
      try {
        await this.update(session, meta, item => { item.state = error?.feedback?.dispatch === 'not_dispatched' ? 'rejected' : 'unknown' })
        await this.host.primary(session)
      } catch (primary) { throw this.afterFailure(primary, meta) }
      throw this.afterFailure(error?.feedback ? error : this.failure('USAGE_TRANSPORT_UNAVAILABLE'), meta, error?.feedback?.dispatch)
    }
    try {
      this.check(result, meta)
      await this.update(session, meta, item => { item.state = this.state(result) })
      await this.host.primary(session)
    } catch (error) { throw this.afterFailure(error, meta) }
    return this.delivery(session, meta, result, Boolean(options.signal?.aborted))
  }
  afterFailure(error, meta, dispatch = 'unknown') {
    return Object.assign(error, { operationId: meta.operationId, turnId: meta.turnId,
      feedback: { ...error.feedback, dispatch, ...(dispatch === 'unknown' ? { next_action: 'inspect_original' } : {}) } })
  }
  check(result, meta) {
    if (result?.schema !== 'bailing.model-operation.v1' || result.operation_id !== meta.operationId
      || result.account_id !== meta.binding.accountId || result.user_id !== meta.binding.userId
      || result.service_id !== meta.serviceId || result.conversation_id !== meta.conversationId || result.turn_id !== meta.turnId
      || !['pending', 'complete', 'unknown', 'cancelled', 'failed'].includes(result.result_state)
      || !['pending', 'settled'].includes(result.billing_state)) throw this.failure('USAGE_RECOVERY_GAP')
  }
  state(result) { return result.response_expired === true ? 'closed_unresolved' : result.result_state === 'complete' ? 'completed' : result.result_state === 'cancelled' ? 'cancelled' : result.result_state === 'failed' ? 'rejected' : 'unknown' }
  delivery(session, meta, result, aborted = false) {
    const closed = aborted || this.closed(session, meta), ready = result.result_state === 'complete' && result.response && typeof result.response === 'object'
    return { ...result, host_turn_active: Boolean(!closed && ready),
      delivery_state: closed ? 'cancelled_late_result' : ready ? 'response_ready' : result.result_state === 'failed' ? 'request_failed' : result.response_expired === true || result.result_state === 'unknown' ? 'unresolved_original' : 'pending_original',
      ...(closed ? { next_action: 'inspect_original' } : result.response_expired === true ? { next_action: 'contact_operator' } : {}) }
  }
  async update(session, meta, update) {
    return this.host.serial(session, async () => {
      await this.host.primary(session)
      const record = await this.load(session, meta)
      update(record.entries[0].request)
      await this.save(session, record)
    })
  }
  async inspect(session, meta, options = {}) {
    const record = await this.load(session, meta)
    const result = await this.host.client.inspectModelRequest(meta.operationId, { ...options, serviceId: meta.serviceId, conversationId: meta.conversationId, turnId: meta.turnId })
    this.check(result, meta)
    record.entries[0].request.state = this.state(result)
    await this.save(session, record)
    await this.host.primary(session)
    return { ...this.delivery(session, meta, result), recovered_original: true }
  }
  async recover(session, operationId, options = {}) {
    this.assertSupported()
    return this.host.serial(session, async () => {
      await this.host.durable(session)
      return this.inspect(session, this.locate(session, operationId), options)
    })
  }
  async close(session, userMessageId, cancelled, options = {}) {
    const id = this.exact(userMessageId)
    ;(cancelled ? this.host.cancelled : this.host.ended).add(`${session.id}:${id}`)
    return this.host.serial(session, async () => {
      await this.host.primary(session)
      this.eventFor(session, id)
      if (!session.events.some(e => e.type === CLOSED_EVENT && e.data?.id === id)) {
        session.append(CLOSED_EVENT, { id, cancelled: Boolean(cancelled) })
        await this.host.durable(session)
      }
      const results = []
      for (const marker of this.markers(session).filter(e => e.data?.turnId === id)) {
        const meta = marker.data, record = await this.load(session, meta)
        if (cancelled && !['completed', 'rejected', 'cancelled'].includes(record.entries[0].request.state)) {
          // Original request cancellation only. No turn exists and no model operation is replayed.
          const result = await this.host.client.cancelModelRequest(meta.operationId,
            { ...options, serviceId: meta.serviceId, conversationId: meta.conversationId, turnId: meta.turnId })
          this.check(result, meta); results.push(result)
          record.entries[0].request.state = this.state(result)
          await this.save(session, record)
        }
      }
      return { state: cancelled ? 'cancelled' : 'ended', requests: results, model_operation_performed: false }
    })
  }
  async status(session, options = {}) {
    const pending = []
    for (const marker of this.markers(session)) {
      const record = await this.load(session, marker.data)
      if (['prepared', 'unknown'].includes(record.entries[0].request.state)) pending.push(marker.data.operationId)
    }
    let summary
    try { summary = await this.host.client.modelSummary(options) }
    catch (error) { await this.host.primary(session); throw error }
    await this.host.primary(session)
    const presentation = summary?.presentation
    // Hosts may provide a custom client. Never hand an old/raw summary to a customer UI.
    if (presentation?.schema !== 'bailing.usage-presentation.v1'
      || !['credits', 'percentage', 'none'].includes(presentation.kind)
      || !['active', 'depleted', 'not_started', 'expired', 'suspended', 'unavailable'].includes(presentation.state)
      || !['remaining', 'total'].every(key => presentation[key] === null || typeof presentation[key] === 'number' && Number.isFinite(presentation[key]) && presentation[key] >= 0)
      || !(presentation.displayValue === null || typeof presentation.displayValue === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$|^<(?:1|0\.01)$/.test(presentation.displayValue))) throw this.failure('USAGE_RESPONSE_INVALID')
    const usable = ['active', 'depleted'].includes(presentation.state)
    if (presentation.kind === 'none') {
      if (presentation.state !== 'unavailable' || presentation.remaining !== null || presentation.total !== null || presentation.displayValue !== null) throw this.failure('USAGE_RESPONSE_INVALID')
    } else if (!usable) {
      if (!['not_started', 'expired', 'suspended'].includes(presentation.state) || presentation.remaining !== null || presentation.displayValue !== null) throw this.failure('USAGE_RESPONSE_INVALID')
    } else {
      if (presentation.remaining === null || presentation.total === null || presentation.displayValue === null
        || presentation.state === 'active' && presentation.remaining <= 0
        || presentation.state === 'depleted' && (presentation.remaining !== 0 || presentation.displayValue !== '0')) throw this.failure('USAGE_RESPONSE_INVALID')
      if (presentation.kind === 'percentage') {
        if (presentation.total !== 100 || presentation.remaining > 100 || !/^(?:0|[1-9][0-9]?|100|<1)$/.test(presentation.displayValue)) throw this.failure('USAGE_RESPONSE_INVALID')
      } else if (presentation.displayValue === '<1') throw this.failure('USAGE_RESPONSE_INVALID')
    }
    return { schema: 'bailing.usage-host-status.v1', state: 'ready', binding: clone(this.host.assertSupported()),
      mode: 'model_gateway', summary: clone(summary), pendingOperations: pending,
      model_transport_required: true, byok_metered: false, turn_required: false }
  }
}
