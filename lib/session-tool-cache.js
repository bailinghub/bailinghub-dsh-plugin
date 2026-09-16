import { Buffer } from 'node:buffer'
import { declarationKey } from './authorizations.js'

const TOOL_FIELDS = ['name', 'description', 'parameters', 'scope', 'risk', 'approvalRequired', 'readonly', 'idempotent']

function immutable(value) {
  const copy = structuredClone(value)
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
    return item
  }
  return freeze(copy)
}

function normalizeTool(value) {
  if (!value || typeof value.name !== 'string' || !value.name || value.name.length > 256 ||
    !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) return null
  try {
    // Only declarations belong here: never retain invocation arguments, results,
    // credentials, a run, or the business context from an earlier turn.
    return JSON.parse(JSON.stringify(Object.fromEntries(TOOL_FIELDS
      .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))))
  } catch { return null }
}

/** In-memory declaration cache. Create one instance per trusted DSH Session. */
export class SessionToolCache {
  #targets = new Map()
  #clock = 0

  constructor({ maxTools = 64, maxBytes = 2 * 1024 * 1024, maxTargets = 64 } = {}) {
    for (const [name, value, maximum] of [['maxTools', maxTools, 64], ['maxBytes', maxBytes, 2 * 1024 * 1024], ['maxTargets', maxTargets, 64]]) {
      if (!Number.isSafeInteger(value) || value < (name === 'maxBytes' ? 14 : 1) || value > maximum) throw new TypeError(`Invalid ${name}`)
    }
    Object.defineProperties(this, {
      maxTools: { value: maxTools, enumerable: true },
      maxBytes: { value: maxBytes, enumerable: true },
      maxTargets: { value: maxTargets, enumerable: true },
    })
  }

  #snapshot(target) {
    return { capabilityRevision: target.capabilityRevision,
      tools: [...target.tools.values()].map((entry) => entry.tool),
      conflicts: [...target.conflicts].sort(), quarantined: target.quarantined }
  }

  #json() {
    return { targets: [...this.#targets].map(([targetKey, target]) => ({ targetKey, ...this.#snapshot(target) })) }
  }

  #bytes() { return Buffer.byteLength(JSON.stringify(this.#json())) }
  #metadataBytes() {
    return Buffer.byteLength(JSON.stringify({ targets: this.#json().targets.map((target) => ({ ...target, tools: [] })) }))
  }
  #count() { return [...this.#targets.values()].reduce((count, target) => count + target.tools.size, 0) }

  #trim(evicted) {
    while (this.#count() > this.maxTools || this.#bytes() > this.maxBytes) {
      let oldest
      for (const [targetKey, target] of this.#targets) {
        for (const [name, entry] of target.tools) {
          if (!oldest || entry.used < oldest.entry.used) oldest = { targetKey, target, name, entry }
        }
      }
      if (!oldest) return false
      oldest.target.tools.delete(oldest.name)
      evicted.push({ targetKey: oldest.targetKey, name: oldest.name })
    }
    return true
  }

  /** Reading and rediscovering a declaration do not refresh its usage order. */
  get(targetKey) {
    const target = this.#targets.get(targetKey)
    return target ? immutable(this.#snapshot(target)) : null
  }

  /** Merge a bounded search response; an omitted declaration is not a deletion. */
  merge(targetKey, { capabilityRevision, tools } = {}) {
    if (typeof targetKey !== 'string' || !targetKey || targetKey.length > 512) throw new TypeError('A trusted target key is required')
    if (!Array.isArray(tools)) throw new TypeError('Tool declarations must be an array')
    const evicted = []
    const skipped = []
    const response = (extra = {}) => immutable({ ...this.get(targetKey), evicted, skipped, revisionChanged: false, ...extra })
    if (typeof capabilityRevision !== 'string' || !capabilityRevision || capabilityRevision.length > 256) {
      skipped.push({ name: null, reason: 'missing_revision' })
      return response({ cached: false })
    }
    const previous = this.#targets.get(targetKey)
    if (!previous && this.#targets.size >= this.maxTargets) {
      // Do not discard conflict tombstones to make room for another identity.
      skipped.push({ name: null, reason: 'target_limit' })
      return response({ cached: false })
    }
    const revisionChanged = !!previous && previous.capabilityRevision !== capabilityRevision
    const target = previous && !revisionChanged ? previous : {
      capabilityRevision, tools: new Map(), conflicts: new Set(), quarantined: false,
    }
    this.#targets.set(targetKey, target)
    if (this.#metadataBytes() > this.maxBytes) {
      if (previous) this.#targets.set(targetKey, previous)
      else this.#targets.delete(targetKey)
      skipped.push({ name: null, reason: 'metadata_limit' })
      return response({ cached: false })
    }
    this.#trim(evicted)
    for (const input of tools) {
      const tool = normalizeTool(input)
      if (!tool) { skipped.push({ name: null, reason: 'invalid_declaration' }); continue }
      const name = tool.name
      if (target.quarantined || target.conflicts.has(name)) {
        skipped.push({ name, reason: 'declaration_conflict' }); continue
      }
      const existing = target.tools.get(name)
      if (existing && declarationKey(existing.tool) !== declarationKey(tool)) {
        target.tools.delete(name)
        target.conflicts.add(name)
        skipped.push({ name, reason: 'declaration_conflict' })
        // Conflict names themselves are bounded. If the quarantine metadata
        // cannot fit, quarantine this entire revision instead of forgetting it.
        if (target.conflicts.size > this.maxTools || this.#bytes() > this.maxBytes) {
          for (const cachedName of target.tools.keys()) evicted.push({ targetKey, name: cachedName })
          target.tools.clear()
          target.conflicts.clear()
          target.quarantined = true
        }
        continue
      }
      if (existing) continue
      if (Buffer.byteLength(JSON.stringify(tool)) + this.#metadataBytes() > this.maxBytes) {
        skipped.push({ name, reason: 'declaration_too_large' }); continue
      }
      // New entries have an initial insertion order; only touch() subsequently
      // changes that order. Repeated discovery cannot keep an unused tool alive.
      target.tools.set(name, { tool, used: ++this.#clock })
      this.#trim(evicted)
      if (!target.tools.has(name)) skipped.push({ name, reason: 'cache_budget' })
    }
    return response({ cached: true, revisionChanged })
  }

  touch(targetKey, name) {
    const entry = this.#targets.get(targetKey)?.tools.get(name)
    if (!entry) return false
    entry.used = ++this.#clock
    return true
  }

  /** Discard reusable declarations without forgetting this revision's conflicts. */
  invalidate(targetKey) {
    const target = this.#targets.get(targetKey)
    if (!target) return false
    target.tools.clear()
    return true
  }

  clear() { this.#targets.clear(); this.#clock = 0 }

  view() {
    return immutable({ targetCount: this.#targets.size, toolCount: this.#count(), bytes: this.#bytes(),
      maxTargets: this.maxTargets, maxTools: this.maxTools, maxBytes: this.maxBytes,
      targets: this.#json().targets })
  }
}
