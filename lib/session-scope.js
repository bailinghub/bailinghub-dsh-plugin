import { createHash } from 'node:crypto'
import { createFileSessionScopeStore } from './session-scope-store.js'

const SCHEMA = 'bailing.agent-session-scope.v1'
const KEY = /^conn_[0-9a-f]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function scopeError(code = 'SESSION_SCOPE_UNAVAILABLE') {
  const error = new Error(`BailingHub session scope is unavailable (${code}); select a scope before the first message or start a new conversation`)
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
    if (!this.entries.has(sessionId)) this.entries.set(sessionId, { sessionId, record: null, loaded: false, claimed: false, blocked: false, pending: false, generation: 0 })
    return this.entries.get(sessionId)
  }

  validate(record, sessionId) {
    if (!record || record.schema !== SCHEMA || record.sessionId !== sessionId ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !['ready', 'needs_selection'].includes(record.state) || typeof record.locked !== 'boolean' ||
      !Array.isArray(record.authorizations) || record.authorizations.length > 64 ||
      Object.keys(record).some((key) => !['schema', 'sessionId', 'revision', 'state', 'locked', 'binding', 'authorizations'].includes(key))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
    const keys = new Set()
    for (const item of record.authorizations) {
      if (!KEY.test(item?.connectionKey ?? '') || keys.has(item.connectionKey) || !UUID.test(item.sessionId ?? '') ||
        typeof item.label !== 'string' || item.label.length > 128 || item.workspace !== record.binding?.workspace ||
        Object.keys(item).some((key) => !['connectionKey', 'sessionId', 'label', 'workspace'].includes(key))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
      keys.add(item.connectionKey)
    }
    if (record.authorizations.length) {
      if (!record.binding || typeof record.binding !== 'object' || Array.isArray(record.binding) ||
        Object.keys(record.binding).some((key) => !['hubUrl', 'clientAppId', 'workspace'].includes(key))) throw scopeError('INVALID_SCOPE_SNAPSHOT')
      const binding = this.normalizeConfig(record.binding)
      if (!binding.valid || binding.hubUrl !== record.binding.hubUrl || binding.clientAppId !== record.binding.clientAppId || binding.workspace !== record.binding.workspace || record.state !== 'ready') throw scopeError('INVALID_SCOPE_SNAPSHOT')
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
    const blocked = entry.blocked || entry.pending || record?.state === 'needs_selection'
    const state = blocked ? 'needs_selection' : record ? 'ready' : 'unselected'
    return {
      schema: SCHEMA, sessionId: entry.sessionId, revision: record?.revision ?? null,
      state, locked: entry.claimed || record?.locked === true,
      mode: blocked ? 'blocked' : record?.authorizations.length ? 'business' : 'chat',
      authorizations: blocked ? [] : (record?.authorizations ?? []).map((item) => ({
        authorizationRef: `auth_${createHash('sha256').update(`${entry.sessionId}\0${item.connectionKey}`).digest('hex').slice(0, 24)}`,
        connectionKey: item.connectionKey, label: item.label, workspace: item.workspace,
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
    const record = this.validate({ schema: SCHEMA, sessionId: entry.sessionId, revision: (expected ?? 0) + 1, ...values }, entry.sessionId)
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
    try { await this.resolve(original.authorizations.map((item) => item.connectionKey), original) }
    catch {
      if (entry.record === original && entry.generation === generation) entry.blocked = true
    }
  }

  async resolve(connectionKeys, original) {
    if (!connectionKeys.length) return { binding: null, authorizations: [] }
    const transport = await this.getTransport()
    const registry = await transport.connectionsList()
    if (!Array.isArray(registry?.connections)) throw scopeError('AUTHORIZATION_UNAVAILABLE')
    let binding
    const authorizations = []
    for (const connectionKey of connectionKeys) {
      const matches = registry.connections.filter((item) => item?.connectionKey === connectionKey)
      if (matches.length !== 1 || matches[0].state !== 'authorized') throw scopeError('AUTHORIZATION_UNAVAILABLE')
      const selected = this.normalizeConfig(matches[0])
      if (!selected.valid) throw scopeError('AUTHORIZATION_UNAVAILABLE')
      const candidate = { hubUrl: selected.hubUrl, clientAppId: selected.clientAppId, workspace: selected.workspace }
      binding ??= candidate
      if (JSON.stringify(binding) !== JSON.stringify(candidate)) throw scopeError('CROSS_SYSTEM_SCOPE_UNSUPPORTED')
      if (original && JSON.stringify(original.binding) !== JSON.stringify(candidate)) throw scopeError('AUTHORIZATION_CHANGED')
      // Only selected keys are probed. Never resolve the SDK's current connection.
      const status = await transport.status({ connectionKey })
      const saved = original?.authorizations.find((item) => item.connectionKey === connectionKey)
      if (status?.state !== 'authorized' || status.connectionKey !== connectionKey || status.workspace !== binding.workspace ||
        !UUID.test(status.sessionId ?? '') || (original && saved?.sessionId !== status.sessionId)) throw scopeError('AUTHORIZATION_CHANGED')
      const label = String(this.sanitize(matches[0].connectionName ?? 'Authorized account'))
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128).trim() || 'Authorized account'
      authorizations.push({ connectionKey, sessionId: status.sessionId, label: saved?.label ?? label, workspace: binding.workspace })
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
    } catch (error) {
      if (error?.code !== 'SESSION_SCOPE_LOCKED') entry.blocked = true
      throw scopeError(error?.code === 'SESSION_SCOPE_LOCKED' ? error.code : 'SESSION_SCOPE_SELECTION_FAILED')
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
      // Validate the entire selection before the first selected system sees input.
      await this.resolve(entry.record.authorizations.map((item) => item.connectionKey), entry.record)
      if (entry.pending) throw scopeError()
    } catch { entry.blocked = true }
    return this.view(entry)
  }

  snapshot(sessionId) { return structuredClone(this.entry(sessionId).record) }

  async assertUsable(sessionId) {
    const entry = await this.load(this.entry(sessionId))
    this.assertCurrent(sessionId)
    await this.checkStored(entry)
    this.assertCurrent(sessionId)
  }

  // Last synchronous dispatch gate: a scope invalidated while an SDK/status
  // promise was pending cannot send input or a write after that promise resolves.
  assertCurrent(sessionId) {
    const entry = this.entry(sessionId)
    if (entry.pending || entry.blocked || entry.record?.state !== 'ready' || !entry.record.locked || !entry.record.authorizations.length) throw scopeError()
  }

  invalidate(sessionId) { this.entry(sessionId).blocked = true }
}
