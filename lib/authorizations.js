import { createHash } from 'node:crypto'
import { subjectDisplayLabel, targetSubjectDisplay } from './subject-display.js'

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

export function sharedDeclarations(targets, limit, preferredNames = [], crossSystem = false, preferredRefs = []) {
  const grouped = new Map()
  const conflicts = new Set()
  for (const target of targets) {
    const run = target.currentRun
    if (run?.status !== 'active') continue
    for (const tool of run.activeTools) {
      const key = declarationKey(tool)
      // Identical schemas in different systems do not prove identical meaning.
      // In a cross-system scope, also keep differing declarations within one
      // system distinct instead of hiding an otherwise usable target's tool.
      const identity = crossSystem ? JSON.stringify([target.authorization.systemRef, key]) : tool.name
      const existing = grouped.get(identity)
      if (existing && existing.key !== key) conflicts.add(identity)
      const name = crossSystem
        ? `bh_${createHash('sha256').update(identity).digest('hex').slice(0, 20)}_${tool.name.slice(0, 40)}` : tool.name
      if (!existing) grouped.set(identity, { tool, key, name, identity, targets: [] })
      grouped.get(identity).targets.push(target)
    }
  }
  const priority = new Map(preferredNames.map((name, index) => [name, index]))
  const targetPriority = (entry) => crossSystem && preferredRefs.length
    ? (entry.targets.some((target) => preferredRefs.includes(target.authorization.ref)) ? 0 : 1) : 0
  const tools = [...grouped.values()].filter(({ identity }) => !conflicts.has(identity))
    .sort((a, b) => targetPriority(a) - targetPriority(b) ||
      (priority.get(a.tool.name) ?? Infinity) - (priority.get(b.tool.name) ?? Infinity))
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
  const subject = targetSubjectDisplay(target)
  return { authorization_ref: target.authorization.ref, authorization_label: subjectDisplayLabel(subject),
    subject_display: subject.subjectDisplay, subject_display_status: subject.subjectDisplayStatus,
    ...(target.authorization.systemRef ? { system_ref: target.authorization.systemRef, workspace: target.workspace } : {}), result }
}
