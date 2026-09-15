import { declarationKey, sharedDeclarations } from './authorizations.js'
import { describeFailure } from './capability-feedback.js'
import { VISIBLE_TOOL_LIMIT, RETAINED_TOOL_LIMIT } from './tool-catalog.js'

export const SESSION_TOOL_GUIDANCE = 'Tools can be cached in this same living session, but each target needs current-turn preparation. Check targets.preparation_state before acting. Use search_business_capabilities with the selected authorization and a minimal query; pass tool_name for an exact previously discovered original tool. The runtime prepares current context and reuses a valid complete declaration, or searches when necessary. A broad new query still discovers capabilities. Read the returned context and full tool_schemas before acting. Ready tools can be called repeatedly without another search. Schemas outside the 12-schema window can be fetched locally with tool_name. Cached/not_prepared does not mean absent or expired. A prepared result explicitly performed no business operation; never treat it as a business receipt or silently replay a write. Recover existing uncertain operations only with their original invocation_id; inspect_original means stop automatic retries.'

const copy = value => structuredClone(value)
const failure = code => Object.assign(new Error('Business capability preparation failed'), { publicCode: code })
const keyFor = target => target.toolCacheKey

function candidates(state, group) {
  return sharedDeclarations(group.targets.map(({ state: target }) => ({
    ...target, currentRun: { status: 'active', activeTools: state.sessionToolCache.get(keyFor(target))?.tools ?? [] },
  })), RETAINED_TOOL_LIMIT, [], group.crossSystem)
}

function ready(entry, tool) {
  return entry?.run?.status === 'active' && entry.run.activeTools.some(value => declarationKey(value) === declarationKey(tool))
}

export function captureSessionTools(state, target, run, tools = run.activeTools) {
  const result = state.sessionToolCache.merge(keyFor(target), { capabilityRevision: run.capabilityRevision, tools })
  // A bounded cache is also the current retained registry's ceiling. Eviction
  // never drops original invocation records or a pending operation's binding.
  for (const entry of state.currentRun?.targets ?? []) {
    const current = entry.state === target ? run : entry.run
    if (!current) continue
    const saved = state.sessionToolCache.get(keyFor(entry.state))
    current.activeTools = saved?.capabilityRevision === current.capabilityRevision ? copy(saved.tools) : []
    current.catalogConflicts = new Set(saved?.conflicts ?? [])
  }
  // startRunOnce has not attached the new run to group.targets yet.
  const saved = state.sessionToolCache.get(keyFor(target))
  run.activeTools = saved?.capabilityRevision === run.capabilityRevision ? copy(saved.tools) : []
  run.catalogConflicts = new Set(saved?.conflicts ?? [])
  run.cacheUpdate = { evictedCount: result.evicted.length }
  return result
}

export function sessionToolView(state, group, available) {
  const shared = group?.sessionTools ? candidates(state, group) : { tools: [], conflicts: [] }
  const active = []
  const cached = []
  for (const item of shared.tools) {
    const preparedRefs = item.targets.filter(target => ready(group.targets.find(entry => entry.state.authorization.ref === target.authorization.ref), item.tool))
      .map(target => target.authorization.ref)
    const summary = { name: item.name, original_name: item.tool.name,
      authorization_refs: item.targets.map(target => target.authorization.ref),
      ...(group.crossSystem ? { system_ref: item.targets[0].authorization.systemRef } : {}) }
    if (available && preparedRefs.length) active.push({ ...summary, authorization_refs: preparedRefs })
    cached.push({ ...summary, prepared_authorization_refs: available ? preparedRefs : [],
      state: !available ? 'inactive' : preparedRefs.length === item.targets.length ? 'ready' : 'cached_unverified' })
  }
  const targets = (group?.targets ?? []).map(entry => ({ authorization_ref: entry.state.authorization.ref,
    preparation_state: !available ? 'inactive' : entry.run?.status === 'active' ? 'ready' : entry.run ? 'unavailable' : 'not_prepared',
    ...(available && entry.run?.status === 'active' ? { run_id: entry.run.runId, capability_revision: entry.run.capabilityRevision } : {}),
  }))
  return { active_tools: active, cached_tools: cached, targets,
    visible_tools: active.filter(tool => state.visibleToolNames.includes(tool.name)),
    cache: { lifetime: 'session_runtime', ...state.sessionToolCache.view() } }
}

async function assertCurrent(runtime, state, group, exec) {
  await runtime.sessionScopes.get(state.sessionId)
  await runtime.assertActiveGroup(state, group, exec)
}

function preparationResult(runtime, state, group, results, names) {
  const selected = new Set(results.filter(item => item.state === 'available').map(item => item.authorization_ref))
  const toolSchemas = []
  for (const item of group.shared.tools) {
    if (!names.includes(item.tool.name)) continue
    const refs = item.targets.filter(target => selected.has(target.authorization.ref)).map(target => target.authorization.ref)
    if (!refs.length) continue
    const definition = state.activeDefinitions.get(item.name)
    if (definition) toolSchemas.push({ name: item.name, original_name: item.tool.name,
      authorization_refs: refs, description: definition.description, parameters: copy(definition.parameters) })
  }
  const schemaWindow = toolSchemas.slice(0, VISIBLE_TOOL_LIMIT)
  const view = runtime.getSessionToolState(state.sessionId)
  return {
    preparation: { state: results.every(result => result.state === 'available') ? 'ready' : 'unavailable', business_operation_performed: false },
    business_operation_performed: false, authorizations: results.map(result => ({ ...result,
      returned_schema_count: schemaWindow.filter(schema => schema.authorization_refs.includes(result.authorization_ref)).length })),
    ...view, omitted_tool_count: view.toolset.omitted_tool_count, tool_schemas: schemaWindow,
    contexts: group.targets.filter(entry => selected.has(entry.state.authorization.ref) && entry.run?.status === 'active')
      .map(entry => ({ authorization_ref: entry.state.authorization.ref, run_id: entry.run.runId,
        profile_revision: entry.run.profileRevision, capability_revision: entry.run.capabilityRevision,
        context: copy(entry.run.context) })),
  }
}

export function sessionSearchDefinition(runtime, state, group, normalizeSearch) {
  return {
    name: 'search_business_capabilities', description: SESSION_TOOL_GUIDANCE,
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Minimal current business task for this target, up to 500 characters.' },
      tool_name: { type: 'string', description: 'Optional exact original tool name from cached_tools; use to prepare/retrieve its full declaration without another remote search when valid.' },
      limit: { type: 'integer', minimum: 1, maximum: VISIBLE_TOOL_LIMIT },
      authorization_ref: { type: 'string', enum: state.authorizations.map(target => target.authorization.ref) },
    }, required: group.single ? ['query'] : ['query', 'authorization_ref'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (value, exec) => {
      await assertCurrent(runtime, state, group, exec)
      const query = typeof value?.query === 'string' ? value.query.trim() : ''
      const toolName = value?.tool_name
      const limit = value?.limit ?? VISIBLE_TOOL_LIMIT
      if (!query || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > VISIBLE_TOOL_LIMIT ||
        (toolName !== undefined && (typeof toolName !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(toolName))) ||
        Object.keys(value).some(key => !['query', 'limit', 'tool_name', 'authorization_ref'].includes(key))) throw failure('agent_invalid_request')
      const ref = value.authorization_ref ?? (group.single ? state.authorizations[0].authorization.ref : undefined)
      const entry = group.targets.find(item => item.state.authorization.ref === ref)
      if (!entry) throw failure('agent_invalid_request')
      const search = async () => {
        await assertCurrent(runtime, state, group, exec)
        try {
          const revisionBefore = state.sessionToolCache.get(keyFor(entry.state))?.capabilityRevision
          const wasPrepared = entry.run?.status === 'active'
          await runtime.ensureAuthorizedTarget(state, group, entry, query, exec)
          const run = entry.run
          const preparedEvictions = wasPrepared ? 0 : run.cacheUpdate?.evictedCount ?? 0
          await runtime.assertAuthorization(entry.state)
          await runtime.assertActiveGroup(state, group, exec)
          let tools = toolName ? run.activeTools.filter(tool => tool.name === toolName) : []
          let source = 'cache'
          let discovery
          let update
          if (!tools.length) {
            source = 'discovery'
            const transport = await runtime.getTransport()
            const result = normalizeSearch(await transport.searchCapabilities({ query, limit, runId: run.runId }, runtime.connectionOptions(entry.state, exec.signal)))
            await assertCurrent(runtime, state, group, exec)
            run.capabilityRevision = result.capabilityRevision
            update = captureSessionTools(state, entry.state, run, result.tools)
            tools = result.tools.filter(tool => run.activeTools.some(current => declarationKey(current) === declarationKey(tool)))
            discovery = result.discovery
          }
          for (const tool of tools) state.sessionToolCache.touch(keyFor(entry.state), tool.name)
          await replaceSessionTools(runtime, state, group, tools.map(tool => tool.name), [ref], normalizeSearch)
          const result = { authorization_ref: ref, state: 'available', source,
            capability_revision: run.capabilityRevision,
            candidate_update: revisionBefore && revisionBefore !== run.capabilityRevision ? 'reset' : 'merge',
            ...(revisionBefore && revisionBefore !== run.capabilityRevision ? { invalidation_reason: 'capability_revision_changed' } : {}),
            evicted_count: preparedEvictions + (update?.evicted.length ?? 0),
            conflicting_tools: [...(run.catalogConflicts ?? [])],
            ...(discovery ? { discovery } : { cache_hit: true }),
            ...(toolName ? { requested_tool_available: tools.some(tool => tool.name === toolName) } : {}),
            ...(run.catalogConflicts?.size ? { feedback: describeFailure(failure('capability_changed'), { operation: 'search', dispatch: 'not_dispatched' }) } : {}),
          }
          return preparationResult(runtime, state, group, [result], tools.map(tool => tool.name))
        } catch (error) {
          await runtime.assertActiveGroup(state, group, exec)
          return preparationResult(runtime, state, group, [{ authorization_ref: ref, state: 'unavailable', feedback: describeFailure(error, { operation: 'search' }) }], [])
        }
      }
      const pending = (group.searchPromise ?? Promise.resolve()).then(search)
      group.searchPromise = pending.catch(() => {})
      return pending
    },
  }
}

export async function replaceSessionTools(runtime, state, group, preferredNames = [], preferredRefs = [], normalizeSearch) {
  runtime.assertRegistryTurn(state, group)
  const shared = candidates(state, group)
  const retainedNames = new Set(shared.tools.map(item => item.name))
  for (const name of state.toolUsage.keys()) if (!retainedNames.has(name)) state.toolUsage.delete(name)
  group.shared = { ...shared, omitted: 0 }
  const preferred = shared.tools.filter(item => preferredNames.includes(item.tool.name) &&
    (!preferredRefs.length || item.targets.some(target => preferredRefs.includes(target.authorization.ref))))
  for (const item of [...preferred].reverse()) runtime.touchTool(state, item.name)
  shared.tools.sort((a, b) => (state.toolUsage.get(b.name) ?? 0) - (state.toolUsage.get(a.name) ?? 0))
  state.visibleToolNames = shared.tools.slice(0, VISIBLE_TOOL_LIMIT).map(item => item.name)
  const searchDefinition = sessionSearchDefinition(runtime, state, group, normalizeSearch)
  const definitions = shared.tools.map(item => {
    // Replace pseudo-cache targets with the real current Session target states.
    const real = { ...item, targets: item.targets.map(target => state.authorizations.find(current => current.authorization.ref === target.authorization.ref)) }
    const business = runtime.authorizedDefinition(state, group, real)
    return { ...business,
      parameters: group.single ? copy(item.tool.parameters) : business.parameters,
      description: business.description + '\n' + SESSION_TOOL_GUIDANCE,
      execute: async (value, exec) => {
        const envelope = group.single ? { authorization_ref: real.targets[0].authorization.ref, arguments: value } : value
        const ref = envelope?.authorization_ref
        const entry = group.targets.find(current => current.state.authorization.ref === ref)
        // Parallel calls planned before current context was available must all
        // remain preparation-only, even if another call prepares during an await.
        const preparedAtEntry = ready(entry, item.tool)
        await assertCurrent(runtime, state, group, exec)
        if (typeof exec.callId !== 'string' || !exec.callId) throw failure('agent_invalid_request')
        if (!entry || !real.targets.some(target => target === entry.state) || !envelope?.arguments ||
          Object.keys(envelope).some(key => !['authorization_ref', 'arguments'].includes(key))) throw failure('agent_invalid_request')
        const signature = declarationKey([item.name, envelope])
        const prior = group.preparedCalls.get(exec.callId)
        if (prior) {
          if (prior.signature !== signature) throw failure('agent_invalid_request')
          return prior.promise
        }
        if (!group.calls.has(exec.callId) && (!preparedAtEntry || !ready(entry, item.tool))) {
          const promise = searchDefinition.execute({ query: `Prepare the current context and declaration for ${item.tool.name}.`, tool_name: item.tool.name, authorization_ref: ref }, exec)
          group.preparedCalls.set(exec.callId, { signature, promise })
          return promise
        }
        state.sessionToolCache.touch(keyFor(entry.state), item.tool.name)
        const executionRevision = group.calls.get(exec.callId)?.run.capabilityRevision ?? entry.run.capabilityRevision
        try {
          const result = await business.execute(envelope, exec)
          return group.single ? result.result : result
        } catch (error) {
          if ((error?.publicCode ?? error?.feedback?.code) === 'capability_changed') {
            try {
              runtime.assertRegistryTurn(state, group)
              runtime.sessionScopes.assertCurrent(state.sessionId)
              if (exec.signal?.aborted) throw Object.assign(new Error('The preparation turn ended'), { name: 'AbortError' })
            } catch (cancelled) {
              cancelled.invocationId = error?.feedback?.invocation_id ?? error?.invocationId
              throw cancelled
            }
            // A late receipt cannot invalidate a newer declaration revision.
            if (entry.run.capabilityRevision === executionRevision &&
              state.sessionToolCache.get(keyFor(entry.state))?.capabilityRevision === executionRevision) {
              state.sessionToolCache.invalidate(keyFor(entry.state))
              entry.run.activeTools = []
              await replaceSessionTools(runtime, state, group, [], [], normalizeSearch)
            }
          }
          throw error
        }
      },
    }
  })
  definitions.push(searchDefinition, runtime.authorizedResumeDefinition(state, group))
  runtime.registerArtifactTools(state, group, definitions)
  await runtime.reconcileDefinitions(state, group, definitions)
}
