import { createHash } from 'node:crypto'
import { memberBinding } from './session-scope.js'

const SCHEMA = 'bailing.agent-invocations.v2'
const LEGACY_SCHEMA = 'bailing.agent-invocations.v1'
const ID = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const STATES = new Set(['unknown', 'executed', 'business_rejected', 'awaiting_approval', 'denied', 'rejected_before_dispatch', 'reconciliation_required', 'in_progress'])
const IDENTITY_FIELDS = ['id', 'scopeHash', 'scopeRevision', 'target', 'runId', 'turn', 'callId', 'tool', 'capabilityRevision', 'parameterHash', 'taskBinding']
const FIELDS = [...IDENTITY_FIELDS, 'lastKnownState', 'retryAt', 'resultHash']

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function metadataHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function scopeFingerprint(scope) {
  if (!scope?.locked || scope.state !== 'ready' || !scope.authorizations?.length) throw recoveryError('invocation_binding_conflict')
  return metadataHash({ sessionId: scope.sessionId, revision: scope.revision,
    members: scope.authorizations.map(member => ({ connectionKey: member.connectionKey,
      ...memberBinding(scope, member), agentSessionId: member.sessionId,
    })).sort((a, b) => a.connectionKey.localeCompare(b.connectionKey)),
  })
}

export function recoveryError(code, invocationId, dispatch = 'not_dispatched') {
  const storage = ['invocation_store_unavailable', 'invocation_store_conflict'].includes(code)
  const error = new Error(code)
  error.publicCode = code
  error.feedback = {
    schema: 'bailing.agent-feedback.v1', origin: 'dsh', operation: 'resume', code,
    category: storage ? 'storage_error' : code === 'invocation_store_unsupported' ? 'unsupported' : 'invocation_recovery_unavailable',
    dispatch, next_action: storage ? 'restore_invocations' : 'inspect_original',
    ...(invocationId ? { invocation_id: invocationId, original_outcome: 'unverified' } : {}),
  }
  return error
}

function checkedEntry(value, legacy = false) {
  const entry = structuredClone(value)
  if (!entry || Array.isArray(entry) || Object.keys(entry).some(key => !FIELDS.includes(key)) ||
    !ID.test(entry.id ?? '') || !ID.test(entry.scopeHash ?? '') ||
    !Number.isSafeInteger(entry.scopeRevision) || entry.scopeRevision < 1 || !UUID.test(entry.runId ?? '') ||
    !Number.isSafeInteger(entry.turn) || entry.turn < 0 ||
    typeof entry.callId !== 'string' || !entry.callId.length || entry.callId.length > 4096 ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(entry.tool ?? '') ||
    !ID.test(entry.capabilityRevision ?? '') || !ID.test(entry.parameterHash ?? '') ||
    !STATES.has(entry.lastKnownState) || !Number.isSafeInteger(entry.retryAt) || entry.retryAt < 0 ||
    !(entry.resultHash === null || ID.test(entry.resultHash ?? ''))) throw recoveryError('invocation_binding_conflict')
  if (legacy && Object.hasOwn(entry, 'taskBinding')) throw recoveryError('invocation_binding_conflict')
  if (entry.taskBinding !== undefined && (!entry.taskBinding ||
    Object.keys(entry.taskBinding).sort().join(',') !== 'schema_version,scope_hash,task_id' ||
    entry.taskBinding.schema_version !== 'bailing.agent-task-binding.v1' ||
    !UUID.test(entry.taskBinding.task_id ?? '') || !ID.test(entry.taskBinding.scope_hash ?? ''))) throw recoveryError('invocation_binding_conflict')
  const target = entry.target
  if (!target || Array.isArray(target) || Object.keys(target).sort().join(',') !== 'agentSessionId,authorizationRef,clientAppId,connectionKey,hubUrl,workspace' ||
    !/^conn_[a-f0-9]{32}$/.test(target.connectionKey ?? '') || !UUID.test(target.agentSessionId ?? '') ||
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(target.clientAppId ?? '') ||
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(target.workspace ?? '') ||
    typeof target.hubUrl !== 'string' || target.hubUrl.length > 2048 ||
    typeof target.authorizationRef !== 'string' || !/^auth_[a-f0-9]{24}$/.test(target.authorizationRef)) throw recoveryError('invocation_binding_conflict')
  return entry
}

function sameBinding(a, b) {
  return metadataHash(Object.fromEntries(IDENTITY_FIELDS.map(key => [key, a[key]]))) ===
    metadataHash(Object.fromEntries(IDENTITY_FIELDS.map(key => [key, b[key]])))
}

/** Trusted host metadata only; transcript text and model-provided bindings are never consumed. */
export class InvocationJournal {
  constructor(store) {
    if (store != null && (typeof store.load !== 'function' || typeof store.save !== 'function')) throw new TypeError('An invocation store with load/save is required')
    this.store = store
    this.queues = new Map()
    this.revisions = new Map()
    this.pending = new Map()
    this.failures = new Map()
  }

  serial(sessionId, operation) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.catch(() => {})
    this.queues.set(sessionId, tail)
    void tail.finally(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId) })
    return result
  }

  // Wait only for local work already queued. Do not read, retry or restore records.
  async drain(sessionId) {
    await this.queues.get(sessionId)
  }

  normalizeFailure(error, id) {
    return error?.feedback ? error : recoveryError(error?.code === 'INVOCATION_STORE_CONFLICT'
      ? 'invocation_store_conflict' : 'invocation_store_unavailable', id)
  }

  async read(sessionId) {
    if (!this.store) throw recoveryError('invocation_store_unsupported')
    try {
      const raw = await this.store.load(sessionId)
      const seen = this.revisions.get(sessionId) ?? 0
      if (!raw) {
        if (seen) throw recoveryError('invocation_binding_conflict')
        return { schema: SCHEMA, sessionId, revision: 0, entries: [] }
      }
      if (![SCHEMA, LEGACY_SCHEMA].includes(raw.schema) || raw.sessionId !== sessionId || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision < seen ||
        Object.keys(raw).some(key => !['schema', 'sessionId', 'revision', 'entries'].includes(key)) || !Array.isArray(raw.entries)) throw recoveryError('invocation_binding_conflict')
      const entries = raw.entries.map(value => checkedEntry(value, raw.schema === LEGACY_SCHEMA))
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw recoveryError('invocation_binding_conflict')
      this.revisions.set(sessionId, raw.revision)
      return { schema: SCHEMA, sessionId, revision: raw.revision, entries }
    } catch (error) { throw this.normalizeFailure(error) }
  }

  async write(record, entries) {
    const next = { ...record, revision: record.revision + 1, entries }
    const saved = await this.store.save(record.sessionId, structuredClone(next), record.revision || null)
    if (metadataHash(saved) !== metadataHash(next)) throw recoveryError('invocation_store_unavailable')
    this.revisions.set(record.sessionId, next.revision)
  }

  reserve(sessionId, value) {
    if (!this.store) return Promise.resolve({ created: true, supported: false })
    return this.serial(sessionId, async () => {
      try {
        const entry = checkedEntry(value)
        if (this.failures.has(sessionId) || this.pending.get(sessionId)?.size) throw recoveryError(this.failures.get(sessionId) ?? 'invocation_store_unavailable', entry.id)
        const record = await this.read(sessionId)
        const existing = record.entries.find(item => item.id === entry.id)
        if (existing) {
          if (!sameBinding(existing, entry)) throw recoveryError('invocation_binding_conflict', entry.id)
          return { created: false, supported: true, entry: structuredClone(existing) }
        }
        await this.write(record, [...record.entries, entry])
        this.failures.delete(sessionId)
        return { created: true, supported: true, entry: structuredClone(entry) }
      } catch (error) {
        const failure = this.normalizeFailure(error, value.id)
        this.failures.set(sessionId, failure.publicCode)
        throw failure
      }
    })
  }

  async updateOnce(sessionId, entry, previous) {
    const record = await this.read(sessionId)
    const index = record.entries.findIndex(item => item.id === entry.id)
    if (index < 0 || !sameBinding(record.entries[index], entry)) throw recoveryError('invocation_binding_conflict', entry.id)
    // A lost save acknowledgement is idempotent; a different outcome written by
    // another process must not be overwritten by a stale in-flight response.
    if (metadataHash(record.entries[index]) === metadataHash(entry)) return
    if (metadataHash(record.entries[index]) !== metadataHash(previous)) throw recoveryError('invocation_store_conflict', entry.id)
    const entries = [...record.entries]
    entries[index] = checkedEntry(entry)
    await this.write(record, entries)
  }

  update(sessionId, value, previous) {
    if (!this.store) return Promise.resolve()
    return this.serial(sessionId, async () => {
      const entry = checkedEntry(value)
      const pending = this.pending.get(sessionId) ?? new Map()
      pending.set(entry.id, { entry, previous: checkedEntry(previous) })
      this.pending.set(sessionId, pending)
      try {
        await this.updateOnce(sessionId, entry, previous)
        pending.delete(entry.id)
        if (!pending.size) this.failures.delete(sessionId)
      } catch (error) {
        const failure = this.normalizeFailure(error, entry.id)
        failure.feedback.dispatch = 'unknown'
        this.failures.set(sessionId, failure.publicCode)
        throw failure
      }
    })
  }

  async find(sessionId, id, scopeHash) {
    return this.serial(sessionId, async () => {
      const record = await this.read(sessionId)
      const entry = record.entries.find(value => value.id === id)
      if (!entry) throw recoveryError('invocation_binding_unavailable', id)
      if (entry.scopeHash !== scopeHash) throw recoveryError('invocation_binding_conflict', id)
      return structuredClone(entry)
    })
  }

  status(sessionId, scopeHash, restore = false) {
    if (!this.store) return Promise.resolve({ state: 'unsupported', reason: 'invocation_store_unsupported', entries: [], unsavedRecords: 0 })
    return this.serial(sessionId, async () => {
      try {
        let record = await this.read(sessionId)
        if (record.entries.some(entry => entry.scopeHash !== scopeHash)) throw recoveryError('invocation_binding_conflict')
        if (restore) {
          for (const { entry, previous } of this.pending.get(sessionId)?.values() ?? []) {
            if (entry.scopeHash !== scopeHash) throw recoveryError('invocation_binding_conflict')
            await this.updateOnce(sessionId, entry, previous)
            this.pending.get(sessionId).delete(entry.id)
          }
          this.failures.delete(sessionId)
          record = await this.read(sessionId)
        }
        const unsavedRecords = this.pending.get(sessionId)?.size ?? 0
        const reason = this.failures.get(sessionId)
        return { state: reason || unsavedRecords ? 'storage_error' : 'ready', ...(reason ? { reason } : {}),
          revision: record.revision || null, unsavedRecords,
          entries: record.entries.map(entry => ({ invocation_id: entry.id, authorization_ref: entry.target.authorizationRef,
            tool: entry.tool, ...(entry.taskBinding ? { task_binding: structuredClone(entry.taskBinding) } : {}), original_run_id: entry.runId, last_known_state: entry.lastKnownState,
            result_verified: false, retry_at: entry.retryAt,
          })),
        }
      } catch (error) {
        const failure = this.normalizeFailure(error)
        this.failures.set(sessionId, failure.publicCode)
        return { state: failure.publicCode === 'invocation_binding_conflict' ? 'blocked' : 'storage_error',
          reason: failure.publicCode, entries: [], unsavedRecords: this.pending.get(sessionId)?.size ?? 0 }
      }
    })
  }
}
