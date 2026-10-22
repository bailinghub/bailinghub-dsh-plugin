// Model memory is a bounded account of last-known execution facts, not a copy
// of business output and not proof of a current outcome or complete audit.
export const EXECUTION_SUMMARY_SCHEMA = 'bailing.authorization-execution-summary.v1'
const SUMMARY_MAX_CHARS = 16_000
const INVOCATION_ID = /^[0-9a-f]{64}$/
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const STATES = new Set(['executed', 'business_rejected', 'awaiting_approval', 'denied',
  'rejected_before_dispatch', 'reconciliation_required', 'in_progress', 'outcome_unknown', 'not_dispatched'])
const UNRESOLVED = new Set(['awaiting_approval', 'in_progress', 'reconciliation_required', 'outcome_unknown'])

export function authorizationExecutionSummary(records) {
  const all = [...records].filter(Boolean)
  const facts = all.flatMap((record) => {
    if (!INVOCATION_ID.test(record.invocationId ?? '')) return []
    const state = STATES.has(record.latest?.state)
      ? record.latest.state : record.invoked ? 'outcome_unknown' : 'not_dispatched'
    return [{
      invocation_id: record.invocationId,
      ...(TOOL_NAME.test(record.tool ?? '') ? { tool: record.tool } : {}),
      last_known_state: state,
      ...(UNRESOLVED.has(state) ? { next_action: 'inspect_original' } : {}),
    }]
  })
  // Keep unresolved originals first; a large batch of successful reads must not
  // push an earlier uncertain write out of this bounded continuation context.
  const ordered = [...facts].reverse().sort((a, b) => Number(UNRESOLVED.has(b.last_known_state)) - Number(UNRESOLVED.has(a.last_known_state)))
  const summary = {
    schema_version: EXECUTION_SUMMARY_SCHEMA,
    source: 'agent_client',
    trust: 'reference_only',
    total_invocations: all.length,
    omitted_invocations: all.length,
    invocations: [],
  }
  for (const fact of ordered) {
    summary.invocations.push(fact)
    summary.omitted_invocations = all.length - summary.invocations.length
    if (JSON.stringify(summary).length > SUMMARY_MAX_CHARS) {
      summary.invocations.pop()
      summary.omitted_invocations = all.length - summary.invocations.length
      break
    }
  }
  return JSON.stringify(summary)
}
