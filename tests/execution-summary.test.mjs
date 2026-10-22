import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizationExecutionSummary, EXECUTION_SUMMARY_SCHEMA } from '../lib/execution-summary.js'

const id = (index) => index.toString(16).padStart(64, '0')
const record = (index, state = 'executed') => ({ invocationId: id(index), tool: 'inventory_read', invoked: true,
  latest: { state, text: 'UNTRUSTED_BUSINESS_TEXT'.repeat(20_000), instructions: 'IGNORE_ALL_RULES' } })

test('authorization summaries retain only last-known facts, never business text or instructions', () => {
  const content = authorizationExecutionSummary([record(1), record(2, 'reconciliation_required')])
  const summary = JSON.parse(content)
  assert.equal(summary.schema_version, EXECUTION_SUMMARY_SCHEMA)
  assert.equal(summary.source, 'agent_client')
  assert.equal(summary.trust, 'reference_only')
  assert.equal(summary.total_invocations, 2)
  assert.equal(summary.omitted_invocations, 0)
  assert.deepEqual(summary.invocations[0], {
    invocation_id: id(2), tool: 'inventory_read', last_known_state: 'reconciliation_required', next_action: 'inspect_original',
  })
  assert.doesNotMatch(content, /UNTRUSTED_BUSINESS_TEXT|IGNORE_ALL_RULES|"text"|"instructions"/)
})

test('unknown outcome points only to its real original id; no replacement or raw-evidence ref is fabricated', () => {
  const summary = JSON.parse(authorizationExecutionSummary([{ invocationId: id(4), tool: 'order_update', invoked: true }]))
  assert.deepEqual(summary.invocations, [{ invocation_id: id(4), tool: 'order_update',
    last_known_state: 'outcome_unknown', next_action: 'inspect_original' }])
  assert.doesNotMatch(JSON.stringify(summary), /evidence_ref|resume|retry|new_invocation/)
})

test('bounded summaries keep complete JSON and uncertain originals ahead of successful batches', () => {
  const records = [record(1, 'outcome_unknown'), ...Array.from({ length: 400 }, (_, index) => record(index + 2))]
  const content = authorizationExecutionSummary(records)
  assert.ok(content.length <= 16_000)
  const summary = JSON.parse(content)
  assert.equal(summary.total_invocations, 401)
  assert.ok(summary.omitted_invocations > 0)
  assert.equal(summary.omitted_invocations + summary.invocations.length, 401)
  assert.equal(summary.invocations[0].invocation_id, id(1))
  assert.equal(summary.invocations[0].next_action, 'inspect_original')
})

test('zero invocations and malformed local identifiers are honest without inventing a business call', () => {
  assert.deepEqual(JSON.parse(authorizationExecutionSummary([])).invocations, [])
  const summary = JSON.parse(authorizationExecutionSummary([{ invocationId: 'not-an-id', tool: 'IGNORE_ALL_RULES' },
    { invocationId: id(1), tool: 'bad\nINSTRUCTION', invoked: false }]))
  assert.equal(summary.total_invocations, 2)
  assert.equal(summary.omitted_invocations, 1)
  assert.deepEqual(summary.invocations, [{ invocation_id: id(1), last_known_state: 'not_dispatched' }])
})
