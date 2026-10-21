import { createHash, randomBytes } from 'node:crypto'

const ID = /^[0-9a-f]{64}$/u
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const MAX_FRAGMENTS = 256
const MAX_CONFIRM_BYTES = 4 * 1024 * 1024
const TTL_MS = 60_000
const digest = value => createHash('sha256').update(value).digest('hex')
export const contextDigest = value => digest(JSON.stringify(value ?? null))
const bytes = value => Buffer.byteLength(value, 'utf8')
const copy = value => structuredClone(value)
const key = value => `${value.kind}:${value.name}`
const record = value => value && typeof value === 'object' && !Array.isArray(value)

/** Local, presentation-only confirmation. Never grants business permission. */
export class ContextDeliveryCoordinator {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.entries = new Map()
  }

  stage(sessionId, binding, fragments) {
    const previous = this.entries.get(sessionId)
    const generation = (previous?.generation ?? 0) + 1
    if (!binding || !fragments.length || fragments.length > MAX_FRAGMENTS) {
      this.entries.set(sessionId, { generation, reason: 'context_unavailable' })
      return
    }
    const required = fragments.map(fragment => ({ kind: fragment.kind, name: fragment.name,
      sha256: digest(fragment.text), bytes: bytes(fragment.text) }))
    this.entries.set(sessionId, { generation, binding: contextDigest(binding),
      targets: copy(binding.targets), turn: binding.turn, context_revision: binding.context_revision,
      delivery_id: randomBytes(32).toString('hex'), expires_at: this.now() + TTL_MS,
      fragments: required, confirmed: undefined })
  }

  current(sessionId, binding) {
    const entry = this.entries.get(sessionId)
    if (!entry?.delivery_id) return { reason: entry?.reason ?? 'host_unconfirmed' }
    if (entry.invalidated) return { reason: entry.invalidated }
    if (!binding || entry.binding !== contextDigest(binding)) {
      entry.confirmed = undefined; entry.invalidated = 'binding_changed'
      return { reason: 'binding_changed' }
    }
    if (entry.expires_at <= this.now()) {
      entry.confirmed = undefined; entry.invalidated = 'expired'
      return { reason: 'expired' }
    }
    return { entry }
  }

  manifest(sessionId, binding) {
    const { entry, reason } = this.current(sessionId, binding)
    if (!entry) return { schema: 'bailing.agent-context-delivery-manifest.v1', state: 'unavailable', reason }
    return { schema: 'bailing.agent-context-delivery-manifest.v1', state: 'available', mode: 'named_runtime',
      delivery_id: entry.delivery_id, generation: entry.generation, turn: entry.turn,
      context_revision: entry.context_revision, expires_at: entry.expires_at,
      targets: copy(entry.targets), fragments: copy(entry.fragments),
      confirmation_scope: 'one_final_provider_request', business_permission: false }
  }

  reject(reason, generation) {
    return { schema: 'bailing.agent-context-delivery-confirmation.v1', state: 'rejected', reason,
      ...(generation === undefined ? {} : { generation }),
      next_action: 'reassemble_context_before_model_request', business_permission: false }
  }

  confirm(sessionId, binding, input) {
    const { entry, reason } = this.current(sessionId, binding)
    if (!entry) return this.reject(reason)
    // A late confirmation cannot revoke or replace a newer request's receipt.
    if (!record(input) || input.delivery_id !== entry.delivery_id || input.generation !== entry.generation) {
      return this.reject('stale_confirmation', entry.generation)
    }
    const fail = code => { entry.confirmed = undefined; entry.invalidated = code; return this.reject(code, entry.generation) }
    if (Object.keys(input).some(name => !['delivery_id', 'generation', 'request_id', 'fragments'].includes(name)) ||
      !ID.test(input.delivery_id) || typeof input.request_id !== 'string' || !REQUEST.test(input.request_id) || !Array.isArray(input.fragments) ||
      input.fragments.length !== entry.fragments.length || input.fragments.length > MAX_FRAGMENTS) return fail('invalid_confirmation')
    if (entry.confirmed && entry.confirmed.request_ref !== digest(input.request_id)) return fail('request_generation_reused')
    const actual = new Map()
    let total = 0
    for (const fragment of input.fragments) {
      if (!record(fragment) || Object.keys(fragment).some(name => !['kind', 'name', 'text'].includes(name)) ||
        !['system', 'runtime_context'].includes(fragment.kind) || typeof fragment.name !== 'string' || fragment.name.length > 256 ||
        typeof fragment.text !== 'string' || actual.has(key(fragment))) return fail('invalid_fragment')
      total += bytes(fragment.text)
      if (total > MAX_CONFIRM_BYTES) return fail('confirmation_too_large')
      actual.set(key(fragment), { sha256: digest(fragment.text), bytes: bytes(fragment.text) })
    }
    for (const expected of entry.fragments) {
      const fragment = actual.get(key(expected))
      if (!fragment || fragment.sha256 !== expected.sha256 || fragment.bytes !== expected.bytes) return fail('fragment_mismatch')
    }
    entry.confirmed = { request_ref: digest(input.request_id), confirmed_at: this.now() }
    return { schema: 'bailing.agent-context-delivery-confirmation.v1', state: 'confirmed',
      delivery_id: entry.delivery_id, generation: entry.generation, request_ref: entry.confirmed.request_ref,
      context_revision: entry.context_revision, expires_at: entry.expires_at,
      next_request_requires_confirmation: true, business_permission: false }
  }

  invalidate(sessionId, reason = 'host_reset') {
    const allowed = ['host_reset', 'request_failed', 'assembly_discarded', 'authorization_unavailable']
    const entry = this.entries.get(sessionId)
    this.entries.set(sessionId, { generation: (entry?.generation ?? 0) + 1,
      reason: allowed.includes(reason) ? reason : 'host_reset' })
    return { schema: 'bailing.agent-context-delivery-reset.v1', state: 'inline', business_permission: false }
  }

  invalidateConfirmation(sessionId, input, reason) {
    const entry = this.entries.get(sessionId)
    if (entry?.delivery_id === input?.delivery_id && entry?.generation === input?.generation) this.invalidate(sessionId, reason)
  }

  projection(sessionId, binding, contexts) {
    const { entry, reason } = this.current(sessionId, binding)
    const compact = Boolean(entry?.confirmed)
    return { contexts: compact ? [] : contexts,
      context_delivery: { schema: 'bailing.agent-context-delivery.v1',
        mode: compact ? 'named_runtime' : 'inline', state: compact ? 'confirmed' : 'inline_fallback',
        body_omitted: compact, reason: compact ? 'confirmed_named_runtime' : reason ?? 'host_unconfirmed',
        ...(compact ? { delivery_id: entry.delivery_id, generation: entry.generation,
          request_ref: entry.confirmed.request_ref, context_revision: entry.context_revision,
          references: copy(entry.targets), next_request_requires_confirmation: true } : {}),
        business_permission: false } }
  }

  forget(sessionId) { this.entries.delete(sessionId) }
}

export function preparationByteMetrics(contexts, returned, schemas, guidance) {
  const source = bytes(JSON.stringify(contexts))
  const inline = bytes(JSON.stringify(returned))
  return { source_context_bytes: source, inline_context_bytes: inline, omitted_context_bytes: source - inline,
    tool_schema_bytes: bytes(JSON.stringify(schemas)), usage_guidance_bytes: guidance === undefined ? 0 : bytes(JSON.stringify(guidance)) }
}
