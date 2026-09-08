import { createHash } from 'node:crypto'

const CONNECTION_KEY = /^conn_[0-9a-f]{32}$/

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

/** A declaration can be shared; its authorization, run and revision cannot. */
export function declarationKey(tool) {
  return JSON.stringify(canonical(tool))
}

export function sameSystemAuthorizations(registry, binding, sessionId, normalizeConfig, sanitize) {
  if (!Array.isArray(registry?.connections)) return []
  const selected = normalizeConfig(binding)
  if (!selected.valid) return []
  const candidates = new Map()
  const duplicates = new Set()
  for (const entry of registry.connections) {
    if (!entry || typeof entry !== 'object' || !CONNECTION_KEY.test(entry.connectionKey)) continue
    const publicBinding = normalizeConfig(entry)
    if (!publicBinding.valid || publicBinding.hubUrl !== selected.hubUrl ||
      publicBinding.clientAppId !== selected.clientAppId || publicBinding.workspace !== selected.workspace ||
      entry.state !== 'authorized') continue
    if (candidates.has(entry.connectionKey)) duplicates.add(entry.connectionKey)
    const ref = `auth_${createHash('sha256').update(`${sessionId}\0${entry.connectionKey}`).digest('hex').slice(0, 24)}`
    const label = String(sanitize(entry.connectionName ?? 'Authorized account'))
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128).trim() || 'Authorized account'
    candidates.set(entry.connectionKey, Object.freeze({
      ref, label,
      connectionKey: entry.connectionKey,
      workspace: publicBinding.workspace,
    }))
  }
  // Ambiguous registry entries must never choose an arbitrary identity binding.
  for (const key of duplicates) candidates.delete(key)
  return [...candidates.values()].sort((a, b) => a.connectionKey.localeCompare(b.connectionKey))
}

export function sharedDeclarations(targets, limit, preferredNames = []) {
  const grouped = new Map()
  const conflicts = new Set()
  for (const target of targets) {
    const run = target.currentRun
    if (run?.status !== 'active') continue
    for (const tool of run.activeTools) {
      const key = declarationKey(tool)
      const existing = grouped.get(tool.name)
      if (existing && existing.key !== key) conflicts.add(tool.name)
      if (!existing) grouped.set(tool.name, { tool, key, targets: [] })
      grouped.get(tool.name).targets.push(target)
    }
  }
  const priority = new Map(preferredNames.map((name, index) => [name, index]))
  const tools = [...grouped.values()].filter(({ tool }) => !conflicts.has(tool.name))
    .sort((a, b) => (priority.get(a.tool.name) ?? Infinity) - (priority.get(b.tool.name) ?? Infinity))
  return { tools: tools.slice(0, limit), conflicts: [...conflicts].sort(), omitted: Math.max(0, tools.length - limit) }
}

export function authorizationEnvelope(tool, refs) {
  return {
    type: 'object',
    properties: {
      authorization_ref: {
        type: 'string', enum: refs,
        description: 'Use the authorization matching the user\'s intended account. Ask when the target is ambiguous.',
      },
      arguments: structuredClone(tool.parameters),
    },
    required: ['authorization_ref', 'arguments'],
    additionalProperties: false,
  }
}

export function unwrapAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'authorization_ref' && key !== 'arguments') ||
    typeof value.authorization_ref !== 'string' || !value.arguments ||
    typeof value.arguments !== 'object' || Array.isArray(value.arguments)) {
    throw new TypeError('An authorization_ref and an object of business arguments are required')
  }
  return { ref: value.authorization_ref, arguments: structuredClone(value.arguments) }
}

export function authorizedResult(target, result) {
  return { authorization_ref: target.authorization.ref, authorization_label: target.authorization.label, result }
}
