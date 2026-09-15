// The SDK owns HTTP error classification. This projection also supports older
// SDKs and custom transports without importing an optional SDK entry point.
const ID = /^[0-9a-f]{64}$/
const CATEGORIES = new Set(['tool_not_loaded', 'capability_changed', 'transport_unavailable', 'authorization_unavailable', 'unsupported', 'invocation_outcome_unknown', 'unknown_failure', 'cancelled', 'invalid_request', 'storage_error', 'invocation_recovery_unavailable'])
const ACTIONS = new Set(['rediscover', 'retry_discovery', 'restore_scope', 'reauthorize', 'check_compatibility', 'resume_original', 'inspect_original', 'restore_invocations', 'none'])
const ORIGINS = new Set(['core', 'sdk', 'mcp', 'dsh', 'host'])
const CODES = new Set([
  'invocation_binding_unavailable', 'invocation_binding_conflict', 'invocation_store_unavailable', 'invocation_store_conflict', 'invocation_store_unsupported',
  'agent_client_disabled', 'agent_direct_disabled', 'agent_runtime_unavailable', 'agent_tools_unavailable',
  'arguments_too_large', 'assistant_message_conflict', 'audience_not_allowed', 'capability_changed',
  'hub_paused', 'invalid_request', 'invalid_route', 'invocation_conflict', 'invocation_not_found',
  'page_context_too_large', 'route_not_allowed', 'route_unavailable', 'run_completion_conflict',
  'run_not_found', 'tool_not_found', 'turn_conflict', 'conversation_audit_conflict',
  'conversation_audit_not_found', 'conversation_audit_not_ready', 'conversation_audit_authorization_invalid',
  'conversation_audit_limit', 'conversation_audit_unavailable', 'conversation_audit_internal_error',
  'conversation_audit_cross_binding_unavailable', 'system_info_unsupported', 'agent_binding_changed',
  'agent_request_cancelled', 'agent_transport_unavailable', 'agent_request_timeout',
  'agent_authorization_unavailable', 'agent_schema_unsupported', 'agent_invalid_response',
  'tool_not_loaded', 'reconciliation_required', 'unknown_failure',

  'agent_invalid_request', 'unauthorized', 'forbidden', 'agent_tool_internal_error',
  'BAILINGHUB_ACCEPTED_UNKNOWN', 'BAILINGHUB_AGENT_CLIENT_UNAVAILABLE',
  'AUTHORIZATION_CHANGED', 'AUTHORIZATION_UNVERIFIED', 'SESSION_SCOPE_UNAVAILABLE',
  'CROSS_SYSTEM_SCOPE_UNSUPPORTED', 'CROSS_HUB_SCOPE_UNSUPPORTED',
])

const MESSAGES = {
  storage_error: 'The local invocation recovery record could not be saved or verified. Restore invocation storage before continuing; do not create a replacement write. This does not confirm the original business outcome.',
  invocation_recovery_unavailable: 'The original invocation binding is missing or conflicts with this fixed session scope. Inspect the original record; never switch target, guess arguments or create a replacement write.',
  tool_not_loaded: 'This business tool is no longer loaded. Discover capabilities for the same selected target; an existing invocation must be recovered using its original ID.',
  capability_changed: 'The capability declaration or its authorization changed. Keep any original invocation and its target; never create a replacement write to recover an uncertain result.',
  transport_unavailable: 'The connection is temporarily unavailable. Retry only the indicated discovery, identity check or original invocation recovery.',
  authorization_unavailable: 'The original authorization cannot currently be used. Do not switch to a default, different authorization or a surviving subset.',
  unsupported: 'The current component does not support this capability. Check compatibility; this does not mean the business system has no capabilities.',
  invocation_outcome_unknown: 'The original operation outcome is unconfirmed. Recover only the original invocation_id; never create a replacement business call.',
  unknown_failure: 'The failure could not be classified. Do not infer that the business capability is absent or repeat an uncertain write.',
  cancelled: 'This operation or turn has ended. Do not reactivate its tools or create a replacement business call.',
  invalid_request: 'The request is invalid for this tool. Check the current tool declaration and selected target.',
}

// A generic 404 or error message cannot establish that Core looked up the
// original invocation. Require the SDK's structured public code and HTTP status.
export function isInvocationNotFound(error) {
  return error?.publicCode === 'invocation_not_found' && error?.statusCode === 404
}

export function describeFailure(error, context = {}) {
  const source = error?.feedback?.schema === 'bailing.agent-feedback.v1' ? error.feedback : undefined
  const operation = context.operation ?? 'tool_dispatch'
  const id = context.invocationId ?? source?.invocation_id ?? error?.invocationId
  const invocationId = typeof id === 'string' && ID.test(id) ? id : undefined
  const rawCode = source?.code ?? error?.publicCode ?? error?.code
  const code = CODES.has(rawCode) ? rawCode : 'unknown_failure'
  const missingOriginal = (operation === 'resume' && isInvocationNotFound(error)) ||
    (source?.code === 'invocation_not_found' && source?.next_action === 'inspect_original' && source?.original_outcome === 'unverified')
  let category = CATEGORIES.has(source?.category) ? source.category : 'unknown_failure'
  let next = ACTIONS.has(source?.next_action) ? source.next_action : 'none'
  let dispatch = ['not_dispatched', 'attempted', 'unknown'].includes(source?.dispatch)
    ? source.dispatch : context.dispatch ?? (['invoke', 'resume'].includes(operation) ? 'unknown' : 'not_dispatched')
  if (!source) {
    if (error?.name === 'AbortError' || code === 'agent_request_cancelled') category = 'cancelled'
    else if (code === 'tool_not_loaded' || code === 'tool_not_found') { category = 'tool_not_loaded'; next = 'rediscover' }
    else if (code === 'capability_changed') { category = 'capability_changed'; next = operation === 'resume' ? 'inspect_original' : 'rediscover' }
    else if (['agent_transport_unavailable', 'agent_request_timeout'].includes(code)) { category = 'transport_unavailable'; next = operation === 'search' ? 'retry_discovery' : 'restore_scope' }
    else if (['unauthorized', 'forbidden', 'agent_authorization_unavailable', 'agent_binding_changed', 'AUTHORIZATION_CHANGED', 'route_not_allowed', 'audience_not_allowed', 'conversation_audit_authorization_invalid'].includes(code) || [401, 403].includes(error?.statusCode)) { category = 'authorization_unavailable'; next = 'reauthorize' }
    else if (['AUTHORIZATION_UNVERIFIED', 'SESSION_SCOPE_UNAVAILABLE'].includes(code)) { category = 'authorization_unavailable'; next = 'restore_scope' }
    else if (['agent_schema_unsupported', 'CROSS_SYSTEM_SCOPE_UNSUPPORTED', 'CROSS_HUB_SCOPE_UNSUPPORTED'].includes(code)) { category = 'unsupported'; next = 'check_compatibility' }
    else if (['agent_invalid_request', 'invalid_request', 'invalid_route', 'arguments_too_large', 'page_context_too_large'].includes(code) || error instanceof TypeError && !['invoke', 'resume'].includes(operation)) { category = 'invalid_request'; dispatch = 'not_dispatched' }
  }
  if (!source && operation === 'invoke' && ['definitive_rejection', 'refresh_required'].includes(error?.disposition) &&
    ([401, 403].includes(error?.statusCode) || ['capability_changed', 'tool_not_found', 'invalid_request', 'route_not_allowed', 'audience_not_allowed'].includes(code))) {
    dispatch = 'not_dispatched'
  }
  // A previously dispatched call takes precedence over tool discovery advice.
  if (error?.disposition === 'accepted_unknown' || source?.disposition === 'accepted_unknown' || category === 'invocation_outcome_unknown') {
    category = 'invocation_outcome_unknown'; dispatch = dispatch === 'not_dispatched' ? 'unknown' : dispatch; next = source?.next_action === 'inspect_original' || code === 'reconciliation_required' || !invocationId ? 'inspect_original' : 'resume_original'
  } else if (!source && operation === 'resume' && invocationId && !['cancelled', 'authorization_unavailable', 'unsupported'].includes(category)) {
    next = ['transport_unavailable', 'unknown_failure'].includes(category) ? 'resume_original' : 'inspect_original'
  } else if (!source && operation === 'invoke' && invocationId && dispatch !== 'not_dispatched' && !['cancelled', 'authorization_unavailable', 'unsupported', 'capability_changed'].includes(category)) {
    category = 'invocation_outcome_unknown'; next = 'resume_original'
  }
  if (missingOriginal) {
    // This is evidence about recovery availability, not proof that the original
    // business action never ran. Preserve it through the host's second projection.
    category = 'invocation_outcome_unknown'
    dispatch = dispatch === 'attempted' ? 'attempted' : 'unknown'
    next = 'inspect_original'
  }
  return {
    schema: 'bailing.agent-feedback.v1', category, code: missingOriginal ? 'invocation_not_found' : code,
    origin: ORIGINS.has(context.origin) ? context.origin : ORIGINS.has(source?.origin) ? source.origin : 'dsh',
    operation, dispatch,
    retryable: ['rediscover', 'retry_discovery', 'restore_scope', 'resume_original', 'restore_invocations'].includes(next),
    next_action: next,
    ...(invocationId ? { invocation_id: invocationId } : {}),
    ...(missingOriginal || source?.original_outcome === 'unverified' ? { original_outcome: 'unverified' } : {}),
    ...(['accepted_unknown', 'definitive_rejection', 'refresh_required'].includes(source?.disposition ?? error?.disposition) ? { disposition: source?.disposition ?? error.disposition } : {}),
    message: missingOriginal
      ? 'The original invocation record was not found. Inspect its original execution evidence; this does not prove that the business action never ran. Do not recreate the call, switch authorization or submit a replacement write.'
      : MESSAGES[category],
  }
}

export function normalizeDiscovery(value, returnedCount) {
  // Missing or malformed optional metadata must not disable an older Core/SDK.
  const base = {
    mode: 'unknown', scope: 'current_authorization', returned_count: returnedCount,
    authorized_total: null, matched_total: null, matched_total_exact: false,
    limit: null, truncated: null, has_more: null, truncation_scope: 'unknown', pagination: 'unsupported',
  }
  if (!value || value.mode !== 'ranked_candidates' || value.scope !== 'current_authorization' ||
    value.returned_count !== returnedCount || !Number.isSafeInteger(value.authorized_total) || value.authorized_total < returnedCount ||
    !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 12 || returnedCount > value.limit ||
    value.matched_total !== null || value.matched_total_exact !== false || value.truncation_scope !== 'authorized_catalog' || value.pagination !== 'unsupported' ||
    value.truncated !== (value.authorized_total > returnedCount) || value.has_more !== value.truncated) return base
  return { ...base, mode: 'ranked_candidates', authorized_total: value.authorized_total, limit: value.limit,
    truncated: value.truncated, has_more: value.has_more, truncation_scope: 'authorized_catalog' }
}

export const DISCOVERY_GUIDANCE = 'Capability search returns bounded ranked candidates, not an exhaustive matching list or pageable catalog. Search adds candidates to the current turn while the authorization catalog revision is unchanged; a changed revision resets that target’s cache. active_tools lists retained, directly callable tools (up to 64 shared); visible_tools is the smaller full-schema window (up to 12). Tools outside that window remain callable using their known exact schema and target. Only eviction, changed declarations or an ended turn require rediscovery. Use currently loaded, valid tools directly when the selected target is clear; search again only when needed. not_loaded means not yet loaded, not no capability. Never use discovery to replace an uncertain invocation.'
