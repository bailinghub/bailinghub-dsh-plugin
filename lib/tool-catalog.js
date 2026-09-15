import { declarationKey } from './authorizations.js'
import { describeFailure } from './capability-feedback.js'

// Full schemas shown to the model are a window, not the execution registry.
export const VISIBLE_TOOL_LIMIT = 12
export const RETAINED_TOOL_LIMIT = 64

export function mergeDiscoveredTools(run, result) {
  const previous = new Map(run.activeTools.map(tool => [tool.name, tool]))
  const changed = run.capabilityRevision !== result.capabilityRevision
  if (changed) run.catalogConflicts = new Set()
  run.catalogConflicts ??= new Set()
  const merged = changed ? new Map() : previous
  // Move search hits to the most recently discovered end, without duplicating.
  for (const tool of result.tools) {
    const old = merged.get(tool.name)
    if (old && declarationKey(old) !== declarationKey(tool)) run.catalogConflicts.add(tool.name)
    merged.delete(tool.name)
    // A stable catalog revision cannot describe two different declarations.
    // Quarantine the name until a new authoritative revision, never last-wins.
    if (!run.catalogConflicts.has(tool.name)) merged.set(tool.name, tool)
  }
  const values = [...merged.values()]
  run.activeTools = values.slice(-RETAINED_TOOL_LIMIT)
  run.capabilityRevision = result.capabilityRevision
  return { candidate_update: changed ? 'reset' : 'merge',
    invalidation_reason: changed ? 'capability_revision_changed' : null,
    conflicting_tools: [...run.catalogConflicts].sort(),
    ...(run.catalogConflicts.size ? { feedback: describeFailure({ code: 'capability_changed' },
      { operation: 'search', dispatch: 'not_dispatched' }) } : {}),
    evicted_count: Math.max(0, values.length - RETAINED_TOOL_LIMIT) }
}

export function touchCatalogTool(run, name) {
  const index = run.activeTools.findIndex(tool => tool.name === name)
  if (index < 0) return
  run.activeTools.push(...run.activeTools.splice(index, 1))
}
