import { createHash } from 'node:crypto'
import { createFileSessionScopeStore } from './session-scope-store.js'

const SCHEMA = 'bailing.agent-session-scope.v1'
const TARGET_SCHEMA = 'bailing.agent-session-scope.v2'
const KEY = /^conn_[0-9a-f]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOST_AUTHORIZATION_STATES = new Set(['logged_out', 'revoked', 'expired'])

function definitiveAuthorizationFailure(error) {
  return ['AUTHORIZATION_CHANGED', 'CROSS_HUB_SCOPE_UNSUPPORTED'].includes(error?.code) ||
    error?.publicCode === 'agent_binding_changed' ||
    (error?.name === 'AgentAuthHttpError' && [401, 403].includes(error.statusCode))
}

export function isCrossSystemScope(record) { return record?.schema === TARGET_SCHEMA }

export function memberBinding(record, member) {
  return {
    hubUrl: record.binding.hubUrl,
    clientAppId: isCrossSystemScope(record) ? member.clientAppId : record.binding.clientAppId,
    workspace: member.workspace,
  }
}

export function archiveMembers(record) {
  return record.authorizations.map((item) => ({
    connectionKey: item.connectionKey, workspace: item.workspace,
    expectedSessionId: item.sessionId, label: item.label,
    ...(isCrossSystemScope(record) ? memberBinding(record, item) : {}),
  }))
}

export function scopeError(code = 'SESSION_SCOPE_UNAVAILABLE') {
  const error = new Error(`BailingHub session scope is unavailable (${code}); retry original-scope validation when connectivity returns, or confirm scope before the first message`)
  error.code = code
  return error
}

/** Host-owned selection. Neither model arguments nor global defaults can grant scope. */
export class SessionScopeCoordinator {
  constructor({ store = createFileSessionScopeStore(), getTransport, normalizeConfig, sanitize }) {
    if (typeof store?.load !== 'function' || typeof store?.save !== 'function') throw new TypeError('A session scope store with load/save is required')
    this.store = store
    this.getTransport = getTransport
    this.normalizeConfig = normalizeConfig
    this.sanitize = sanitize
    this.entries = new Map()
  }

  entry(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
      throw scopeError('INVALID_SESSION_ID')
    }
    if (!this.entries.has(sessionId)) this.entries.set(sessionId, { sessionId, record: null, loaded: false, claimed: false, blocked: false, retryRequired: false, pending: false, generation: 0 })
    return this.entries.get(sessionId)
  }

  validate(record, sessionId) {
    if (!record || ![SCHEMA, TARGET_SCHEMA].includes(record.schema) || record.sessionId !== sessionId ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !['ready', 'needs_selection'].includes(record.state) || typeof record.locked !== 'boolean' ||
      !Array.isArray(record.authorizations) || record.authorizations.length > 64 ||
      Object.keys(record).some((key) => !['schema', 'sessionId', 'revision', 'state', 'locked', 'binding', 'authorizations'].includes(key))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
    const crossSystem = isCrossSystemScope(record)
    if (crossSystem && (record.authorizations.length < 2 || !record.binding ||
      typeof record.binding !== 'object' || Array.isArray(record.binding))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
    const keys = new Set()
    const sessions = new Set()
    for (const item of record.authorizations) {
      if (!KEY.test(item?.connectionKey ?? '') || keys.has(item.connectionKey) || !UUID.test(item.sessionId ?? '') ||
        typeof item.label !== 'string' || item.label.length > 128 ||
        (!crossSystem && item.workspace !== record.binding?.workspace) ||
        Object.keys(item).some((key) => !['connectionKey', 'sessionId', 'label', 'workspace', ...(crossSystem ? ['clientAppId'] : [])].includes(key))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
      if (crossSystem) {
        const raw = memberBinding(record, item)
        const normalized = this.normalizeConfig(raw)
        if (!normalized.valid || Object.keys(raw).some((key) => raw[key] !== normalized[key]) || sessions.has(item.sessionId.toLowerCase())) throw scopeError('INVALID_SCOPE_SNAPSHOT')
      }
      keys.add(item.connectionKey)
      sessions.add(item.sessionId.toLowerCase())
    }
    if (record.authorizations.length) {
      if (!record.binding || typeof record.binding !== 'object' || Array.isArray(record.binding) ||
        Object.keys(record.binding).some((key) => !(crossSystem ? ['hubUrl'] : ['hubUrl', 'clientAppId', 'workspace']).includes(key))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
      const raw = crossSystem ? memberBinding(record, record.authorizations[0]) : record.binding
      const binding = this.normalizeConfig(raw)
      if (!binding.valid || Object.keys(raw).some((key) => raw[key] !== binding[key]) || record.state !== 'ready') throw scopeError('INVALID_SCOPE_SNAPSHOT')
      if (crossSystem && new Set(record.authorizations.map((item) => JSON.stringify(memberBinding(record, item)))).size < 2) throw scopeError('INVALID_SCOPE_SNAPSHOT')
    } else if (record.binding !== null) throw scopeError('INVALID_SCOPE_SNAPSHOT')
    return structuredClone(record)
  }

  async load(entry) {
    if (!entry.loaded) {
      entry.loading ??= (async () => {
        try {
          const value = await this.store.load(entry.sessionId)
          entry.record = value === null ? null : this.validate(value, entry.sessionId)
          // An unlocked selection is only a draft. A failed replacement may
          // have left its very first tombstone unwritten, so no stored draft
          // can prove the user's latest intent after this runtime is rebuilt.
          if (entry.record && !entry.record.locked) entry.blocked = true
          // A restored business snapshot is not a current authorization proof.
          // This in-memory fence never rewrites its identities or CAS revision.
          entry.retryRequired = Boolean(entry.record?.authorizations.length)
        } catch {
          entry.blocked = true
          entry.loadFailed = true
        }
        entry.loaded = true
      })()
      await entry.loading
    }
    return entry
  }

  view(entry) {
    const record = entry.record
    const blocked = entry.blocked || entry.retryRequired || this.isValidating(entry) || entry.pending || record?.state === 'needs_selection'
    const state = blocked ? 'needs_selection' : record ? 'ready' : 'unselected'
    return {
      schema: SCHEMA, sessionId: entry.sessionId, revision: record?.revision ?? null,
      state, locked: entry.claimed || record?.locked === true,
      mode: blocked ? 'blocked' : record?.authorizations.length ? 'business' : 'chat',
      ...(isCrossSystemScope(record) ? { targetMode: 'multi_system' } : {}),
      ...(blocked && entry.failureCode ? { reason: entry.failureCode } : {}),
      authorizations: blocked ? [] : (record?.authorizations ?? []).map((item) => ({
        authorizationRef: `auth_${createHash('sha256').update(`${entry.sessionId}\0${item.connectionKey}`).digest('hex').slice(0, 24)}`,
        connectionKey: item.connectionKey, label: item.label, workspace: item.workspace,
        clientAppId: memberBinding(record, item).clientAppId,
        systemRef: `sys_${createHash('sha256').update(JSON.stringify(memberBinding(record, item))).digest('hex').slice(0, 16)}`,
      })),
    }
  }

  async get(sessionId) {
    const entry = await this.load(this.entry(sessionId))
    if (entry.record && !entry.pending && !entry.blocked) {
      await this.checkStored(entry)
      if (!entry.blocked && entry.record.state === 'ready') {
        await this.revalidate(entry)
      }
    }
    return this.view(entry)
  }

  async write(entry, values) {
    const expected = entry.record?.revision ?? null
    const schema = values.authorizations?.some((item) => Object.hasOwn(item, 'clientAppId')) ? TARGET_SCHEMA : SCHEMA
    const record = this.validate({ schema, sessionId: entry.sessionId, revision: (expected ?? 0) + 1, ...values }, entry.sessionId)
    await this.store.save(entry.sessionId, structuredClone(record), expected)
    entry.record = record
  }

  async checkStored(entry) {
    const original = entry.record
    const generation = entry.generation
    try {
      const record = this.validate(await this.store.load(entry.sessionId), entry.sessionId)
      if (JSON.stringify(record) !== JSON.stringify(original)) throw scopeError('SESSION_SCOPE_CONFLICT')
    } catch {
      if (entry.record === original && entry.generation === generation) entry.blocked = true
    }
  }

  async revalidate(entry) {
    const original = entry.record
    const generation = entry.generation
    if (!original || entry.blocked || entry.pending) return
    if (this.isValidating(entry)) return entry.validation.promise
    const validation = { record: original, generation }
    entry.validation = validation
    entry.retryRequired = Boolean(original.authorizations.length)
    const current = () => entry.record === original && entry.generation === generation && !entry.blocked && !entry.pending
    validation.promise = (async () => {
      try {
        await this.resolve(original.authorizations.map((item) => item.connectionKey), original)
        if (!current()) return
        // A network wait must not hide a concurrent durable scope change.
        await this.checkStored(entry)
        if (current()) { entry.retryRequired = false; entry.failureCode = undefined }
      } catch (error) {
        if (current()) this.invalidate(entry.sessionId, error)
      } finally {
        if (entry.validation === validation) entry.validation = undefined
      }
    })()
    return validation.promise
  }

  isValidating(entry) {
    return Boolean(entry.validation && entry.validation.record === entry.record && entry.validation.generation === entry.generation)
  }

  validateStatus(status, { connectionKey, workspace, sessionId }) {
    // An incomplete response proves neither identity nor revocation. A retry
    // may proceed only after the exact original identity is actually verified.
    if (!status || !KEY.test(status.connectionKey ?? '') || typeof status.workspace !== 'string' || !status.workspace) throw scopeError('AUTHORIZATION_UNVERIFIED')
    if (!LOST_AUTHORIZATION_STATES.has(status.state) &&
      (status.state !== 'authorized' || !UUID.test(status.sessionId ?? ''))) throw scopeError('AUTHORIZATION_UNVERIFIED')
    if (status.connectionKey !== connectionKey || status.workspace !== workspace || LOST_AUTHORIZATION_STATES.has(status.state)) throw scopeError('AUTHORIZATION_CHANGED')
    if (sessionId && sessionId !== status.sessionId) throw scopeError('AUTHORIZATION_CHANGED')
  }

  async resolve(connectionKeys, original) {
    if (!connectionKeys.length) return { binding: null, authorizations: [] }
    const transport = await this.getTransport()
    const registry = await transport.connectionsList()
    if (!Array.isArray(registry?.connections) || registry.connections.some((item) => !KEY.test(item?.connectionKey ?? ''))) throw scopeError('AUTHORIZATION_UNVERIFIED')
    // Resolve the whole public target set before probing any credential or Hub.
    const selections = connectionKeys.map((connectionKey) => {
      const matches = registry.connections.filter((item) => item?.connectionKey === connectionKey)
      if (!matches.length) throw scopeError('AUTHORIZATION_CHANGED')
      if (matches.length !== 1) throw scopeError('AUTHORIZATION_UNVERIFIED')
      if (LOST_AUTHORIZATION_STATES.has(matches[0].state)) throw scopeError('AUTHORIZATION_CHANGED')
      if (matches[0].state !== 'authorized') throw scopeError('AUTHORIZATION_UNVERIFIED')
      const selected = this.normalizeConfig(matches[0])
      if (!selected.valid) throw scopeError('AUTHORIZATION_UNVERIFIED')
      const candidate = { hubUrl: selected.hubUrl, clientAppId: selected.clientAppId, workspace: selected.workspace }
      const saved = original?.authorizations.find((item) => item.connectionKey === connectionKey)
      if (original && (!saved || JSON.stringify(memberBinding(original, saved)) !== JSON.stringify(candidate))) throw scopeError('AUTHORIZATION_CHANGED')
      return { connectionKey, candidate, saved, entry: matches[0] }
    })
    const first = selections[0].candidate
    if (selections.some(({ candidate }) => candidate.hubUrl !== first.hubUrl)) throw scopeError('CROSS_HUB_SCOPE_UNSUPPORTED')
    const crossSystem = selections.some(({ candidate }) => JSON.stringify(candidate) !== JSON.stringify(first))
    if (crossSystem && typeof transport.getConversationArchiveCapabilities !== 'function') throw scopeError('CROSS_SYSTEM_SCOPE_UNSUPPORTED')
    const binding = crossSystem ? { hubUrl: first.hubUrl } : first
    const authorizations = []
    const sessions = new Set()
    for (const { connectionKey, candidate, saved, entry: selected } of selections) {
      // Only selected keys are probed. Never resolve the SDK's current connection.
      const status = await transport.status({ connectionKey,
        ...(crossSystem && saved ? { expectedBinding: { ...candidate, sessionId: saved.sessionId } } : {}),
      })
      this.validateStatus(status, { connectionKey, workspace: candidate.workspace, sessionId: saved?.sessionId })
      if (crossSystem && sessions.has(status.sessionId.toLowerCase())) throw scopeError('AUTHORIZATION_CHANGED')
      sessions.add(status.sessionId.toLowerCase())
      const label = String(this.sanitize(selected.connectionName ?? 'Authorized account'))
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128).trim() || 'Authorized account'
      authorizations.push({ connectionKey, sessionId: status.sessionId, label: saved?.label ?? label, workspace: candidate.workspace,
        ...(crossSystem ? { clientAppId: candidate.clientAppId } : {}),
      })
    }
    if (crossSystem) {
      const record = { schema: TARGET_SCHEMA, binding, authorizations }
      const capability = await transport.getConversationArchiveCapabilities({ members: archiveMembers(record) })
      if (capability?.schema !== 'bailing.agent-conversation-audit-capabilities.v1' ||
        capability.cross_binding_members !== true || capability.member_bindings !== 'session-client-route.v1') throw scopeError('CROSS_SYSTEM_SCOPE_UNSUPPORTED')
    }
    return { binding, authorizations }
  }

  async set(sessionId, request) {
    const entry = this.entry(sessionId)
    if (entry.claimed || entry.record?.locked) throw scopeError('SESSION_SCOPE_LOCKED')
    // Host UI state may be mutated immediately after calling this API. Capture
    // the requested selection before the first storage/network await.
    try { request = structuredClone(request) } catch { request = null }
    if (entry.pending) {
      entry.blocked = true
      entry.generation += 1
      throw scopeError('SESSION_SCOPE_CONFLICT')
    }
    // Close the gate synchronously, before storage or authorization validation.
    entry.pending = true
    const generation = ++entry.generation
    try {
      await this.load(entry)
      if (entry.claimed || entry.record?.locked) throw scopeError('SESSION_SCOPE_LOCKED')
      const previousRevision = entry.record?.revision ?? null
      const failedLoad = entry.loadFailed
      entry.blocked = true
      // Invalidate the previous selection durably when storage permits it.
      // load() also requires confirmation of every unlocked stored draft,
      // covering failures before this first write can reach storage.
      await this.write(entry, { state: 'needs_selection', locked: false, binding: null, authorizations: [] })
      if (failedLoad) throw scopeError('SESSION_SCOPE_UNAVAILABLE')
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some((key) => !['connectionKeys', 'expectedRevision'].includes(key)) ||
        !Array.isArray(request.connectionKeys) || request.connectionKeys.length > 64 ||
        request.connectionKeys.some((key) => typeof key !== 'string' || !KEY.test(key)) ||
        new Set(request.connectionKeys).size !== request.connectionKeys.length) throw scopeError('INVALID_SCOPE_SELECTION')
      if (Object.hasOwn(request, 'expectedRevision') && request.expectedRevision !== previousRevision) throw scopeError('SESSION_SCOPE_CONFLICT')
      const selected = await this.resolve([...request.connectionKeys].sort())
      if (entry.claimed || generation !== entry.generation) throw scopeError('SESSION_SCOPE_CONFLICT')
      await this.write(entry, { state: 'ready', locked: false, ...selected })
      if (entry.claimed || generation !== entry.generation) {
        await this.write(entry, { state: 'needs_selection', locked: entry.claimed, binding: null, authorizations: [] })
        throw scopeError('SESSION_SCOPE_CONFLICT')
      }
      entry.blocked = false
      entry.retryRequired = false
      entry.failureCode = undefined
    } catch (error) {
      if (error?.code !== 'SESSION_SCOPE_LOCKED') entry.blocked = true
      entry.failureCode = error?.code
      throw scopeError(['SESSION_SCOPE_LOCKED', 'CROSS_SYSTEM_SCOPE_UNSUPPORTED', 'CROSS_HUB_SCOPE_UNSUPPORTED'].includes(error?.code) ? error.code : 'SESSION_SCOPE_SELECTION_FAILED')
    } finally {
      entry.pending = false
    }
    return this.view(entry)
  }

  markStarted(sessionId) {
    const entry = this.entry(sessionId)
    entry.claimed = true
    if (entry.pending) { entry.blocked = true; entry.generation += 1 }
  }

  async restore(sessionId, { knownDraft = false } = {}) {
    const entry = await this.load(this.entry(sessionId))
    if (entry.pending) { entry.blocked = true; entry.generation += 1 }
    if (!entry.record) {
      entry.blocked = true
      // Missing scope is not evidence of a user message. Only the trusted host
      // history can distinguish a never-started draft from unknown old history.
      if (!knownDraft) entry.claimed = true
    } else if (!entry.blocked && entry.record.state === 'ready') {
      await this.checkStored(entry)
      if (!entry.blocked) await this.revalidate(entry)
    }
    return this.view(entry)
  }

  async begin(sessionId, restored = false) {
    const entry = this.entry(sessionId)
    entry.beginPromise ??= this.beginOnce(sessionId, restored).finally(() => { entry.beginPromise = undefined })
    return entry.beginPromise
  }

  async beginOnce(sessionId, restored = false) {
    const entry = await this.load(this.entry(sessionId))
    // Old history must never acquire a fresh selection before it is reopened.
    if (restored && !entry.record?.locked) entry.blocked = true
    if (entry.pending || entry.blocked || entry.record?.state === 'needs_selection') return this.view(entry)
    if (entry.record) await this.checkStored(entry)
    if (entry.blocked) return this.view(entry)
    try {
      if (!entry.record || !entry.record.locked) {
        await this.write(entry, { state: 'ready', locked: true, binding: entry.record?.binding ?? null, authorizations: entry.record?.authorizations ?? [] })
      }
    } catch { entry.blocked = true }
    // Storage failures remain terminal. Unverified authorizations instead keep
    // a closed, retryable gate before any selected system receives user input.
    if (!entry.blocked) await this.revalidate(entry)
    return this.view(entry)
  }

  snapshot(sessionId) { return structuredClone(this.entry(sessionId).record) }

  async assertUsable(sessionId) {
    const entry = await this.load(this.entry(sessionId))
    while (this.isValidating(entry)) await entry.validation.promise
    this.assertCurrent(sessionId)
    await this.checkStored(entry)
    while (this.isValidating(entry)) await entry.validation.promise
    this.assertCurrent(sessionId)
  }

  // Last synchronous dispatch gate: a scope invalidated while an SDK/status
  // promise was pending cannot send input or a write after that promise resolves.
  assertCurrent(sessionId) {
    const entry = this.entry(sessionId)
    if (entry.pending || entry.blocked || entry.retryRequired || this.isValidating(entry) || entry.record?.state !== 'ready' || !entry.record.locked || !entry.record.authorizations.length) throw scopeError()
  }

  // Only authorization probes pass an error here. Unknown transport failures
  // are not revocations; they close dispatch until a fresh whole-scope proof.
  // A newer invalidation always supersedes any in-flight validation success.
  invalidate(sessionId, error) {
    const entry = this.entry(sessionId)
    entry.generation += 1
    entry.failureCode = error?.code
    if (!error || definitiveAuthorizationFailure(error)) entry.blocked = true
    else entry.retryRequired = true
  }
}
