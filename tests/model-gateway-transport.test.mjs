import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createUsageModelTransport } from '../lib/usage-model-transport.js'
import { createMemorySessionUsageStore, createFileSessionUsageStore } from '../lib/session-usage-store.js'
import { usageLlmChunks } from '../lib/usage-llm-stream.js'
const { Session } = await import(pathToFileURL(join(process.env.DSH_NODE_MODULES ?? resolve('node_modules'), '@deepseek-ai/dsh-session/lib/index.js')).href)
const binding = { hubUrl: 'https://hub.example.com', userId: 'user', accountId: 'account', serviceId: 'base' }
const caps = { schema: 'bailing.usage.v1', supported: true, streaming: true, orchestration: 'host', model_gateway: { schema: 'bailing.model-gateway.v1', supported: true, streaming: true, orchestration: 'host', billing_unit: 'USD', turn_required: false, provider_response: 'bailing.provider-response.v1', settlement: 'asynchronous' } }
const request = { userMessageId: 'message', modelRequestId: 'step', messages: [{ role: 'user', content: 'Synthetic private input' }] }
const session = (id = 'token-session') => { const s = Session.create(id, []); s.append('user/message', { id: 'message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic private input' }] }, { surfaceOp: 'append' }); return s }
const result = wire => ({ schema: 'bailing.model-operation.v1', operation_id: wire.operation_id, account_id: 'account', user_id: 'user', service_id: wire.service_id,
  conversation_id: wire.conversation_id, turn_id: wire.turn_id, state: 'completed', result_state: 'complete', billing_state: 'pending', dispatch: 'completed', next_action: 'none', revision: 1, billed_usd: null, overage_usd: null,
  response: { choices: [{ message: { role: 'assistant', content: 'Synthetic done', tool_calls: [] }, finish_reason: 'stop' }] } })
function fixture(options = {}) {
  const calls = [], originals = new Map(), store = options.store ?? createMemorySessionUsageStore()
  const client = { binding, capabilities: async () => caps,
    modelSummary: async () => ({ grant: { id: 'grant' }, availableUsd: 100000, presentation: { schema: 'bailing.usage-presentation.v1', kind: 'credits', state: 'active', remaining: 100, total: 100, displayValue: '100' } }),
    modelModels: async () => ({ items: ['base', 'second'].map(id => ({ service_id: id, label: `Synthetic ${id}`, model: `model-${id}` })) }),
    modelComplete: async wire => { calls.push(['modelComplete', wire]); const receipt = result(wire); originals.set(wire.operation_id, receipt); return receipt },
    modelStream: async function* (wire) { calls.push(['modelStream', wire]); yield { type: 'delta', delta: { content: 'Synthetic ' } }; const receipt = result(wire); originals.set(wire.operation_id, receipt); yield { type: 'operation', operation: receipt } },
    inspectModelRequest: async (id, opts) => { calls.push(['inspect', id, opts]); return originals.get(id) },
    cancelModelRequest: async (id, opts) => { calls.push(['cancel', id, opts]); return { ...originals.get(id), state: 'cancelled', result_state: 'cancelled' } },
  }
  const host = createUsageModelTransport({ client, store, ensureSessionPersisted: async () => true, ...options })
  return { host, client, store, calls, originals }
}
async function until(check) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw Error('Synthetic wait timeout'); await new Promise(r => setImmediate(r)) } }

test('same user input supports 305 model operations without Hub turn creation and per-request sidecars remain bounded', async () => {
  const f = fixture(), s = session()
  for (let i = 0; i < 305; i++) {
    const receipt = await f.host.complete(s, { ...request, modelRequestId: `step-${i}` })
    assert.equal(receipt.host_turn_active, true); assert.equal(receipt.billing_state, 'pending')
  }
  assert.equal(f.calls.length, 305); assert.ok(f.calls.every(([name]) => name === 'modelComplete'))
  assert.equal(s.events.filter(e => e.type === 'bailinghub/model-request').length, 305)
  assert.equal((await f.host.status(s)).pendingOperations.length, 0)
  await f.host.endTurn(s, 'message')
  assert.equal(f.calls.length, 305, 'endTurn is a local lifecycle fence, never a Hub billing turn')
  assert.equal((await f.host.recoverOperation(s, f.calls[0][1].operation_id)).host_turn_active, false)
})

test('4100 completed input groups remain supported without a session-wide request budget', async () => {
  const f = fixture(), s = session('long-history')
  for (let i = 0; i < 4100; i++) {
    const id = i ? `message-${i}` : 'message'
    if (i) s.append('user/message', { id, role: 'user', source: { kind: 'user' }, content: [] }, { surfaceOp: 'append' })
    await f.host.complete(s, { ...request, userMessageId: id, modelRequestId: `step-${i}` })
  }
  assert.equal(f.calls.length, 4100)
})

test('native stream finishes with pending usage; selected models and recovery retain original target', async () => {
  const f = fixture(), s = session('selected')
  assert.equal((await f.host.model({ serviceId: 'second' })).model, 'model-second')
  await assert.rejects(f.host.model({ serviceId: 'not-selected' }), { code: 'SERVICE_NOT_ENTITLED' })
  const chunks = []; for await (const part of usageLlmChunks(f.host.stream(s, { ...request, serviceId: 'second' }))) chunks.push(part)
  assert.equal(chunks.at(-1).type, 'finish'); assert.equal(f.calls[0][1].service_id, 'second')
  const operationId = f.calls[0][1].operation_id
  const original = await f.host.recoverOperation(s, operationId)
  assert.equal(original.service_id, 'second'); assert.equal(f.calls.at(-1)[2].serviceId, 'second')
  await assert.rejects(f.host.complete(s, { ...request, serviceId: 'base' }), { code: 'USAGE_IDEMPOTENCY_CONFLICT' })
})

test('ACK loss survives full host/store reopen without replay and sidecars never contain message content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'token-gateway-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const f = fixture({ store: createFileSessionUsageStore({ directory }) }), s = session('durable')
  const complete = f.client.modelComplete
  f.client.modelComplete = async wire => { await complete(wire); throw Error('offline') }
  await assert.rejects(f.host.complete(s, request), { code: 'USAGE_TRANSPORT_UNAVAILABLE' })
  const id = f.calls[0][1].operation_id
  for (const name of await readdir(directory)) assert.equal((await readFile(join(directory, name), 'utf8')).includes('Synthetic private'), false)
  const reopened = createUsageModelTransport({ client: f.client, mode: 'model_gateway', store: createFileSessionUsageStore({ directory }), ensureSessionPersisted: async () => true })
  const recovered = await reopened.complete(s, request)
  assert.equal(recovered.operation_id, id); assert.equal(recovered.recovered_original, true)
  assert.equal(f.calls.filter(([name]) => name === 'modelComplete').length, 1)
  await reopened.endTurn(s, 'message')
  const again = createUsageModelTransport({ client: f.client, mode: 'model_gateway', store: createFileSessionUsageStore({ directory }), ensureSessionPersisted: async () => true })
  assert.equal((await again.recoverOperation(s, id)).host_turn_active, false)
})

test('cancel reaches original request while provider waits; late tools cannot enter local loop', async () => {
  const f = fixture(), s = session('cancel'); let release, wire
  f.client.modelStream = async function* (input) { wire = input; f.originals.set(input.operation_id, result(input)); yield { type: 'delta', delta: { content: 'Synthetic ' } }; await new Promise(r => { release = r }); yield { type: 'operation', operation: result(input) } }
  const iterator = f.host.stream(s, request); await iterator.next(); const pending = iterator.next(); await until(() => release)
  await f.host.cancelTurn(s, 'message'); assert.equal(f.calls[0][0], 'cancel'); assert.equal(f.calls[0][1], wire.operation_id)
  release(); const last = (await pending).value.operation
  assert.equal(last.host_turn_active, false); assert.equal(last.delivery_state, 'cancelled_late_result')
  assert.equal((await iterator.next()).done, true)
})

test('primary storage errors, missing metadata and identity changes block without replacement dispatch', async () => {
  const f = fixture(), s = session('error'); await f.host.complete(s, request)
  const id = f.calls[0][1].operation_id
  const wrong = createUsageModelTransport({ client: { ...f.client, binding: { ...binding, accountId: 'other' } }, store: f.store, mode: 'model_gateway', ensureSessionPersisted: async () => true })
  await assert.rejects(wrong.recoverOperation(s, id), { code: 'USAGE_RECOVERY_GAP' })
  const missing = createUsageModelTransport({ client: f.client, store: createMemorySessionUsageStore(), mode: 'model_gateway', ensureSessionPersisted: async () => true })
  await assert.rejects(missing.complete(s, request), { code: 'USAGE_RECOVERY_GAP' })
  f.host.getPrimaryStatus = () => ({ unsavedEvents: 1 })
  await assert.rejects(f.host.complete(s, request), { code: 'USAGE_STORAGE_ERROR' })
  assert.equal(f.calls.length, 1)
})

test('final local save failure stays storage_error even with a known model result', async () => {
  const store = createMemorySessionUsageStore(); let saves = 0
  const f = fixture({ store: { load: store.load, save: (...args) => { if (++saves === 2) throw Error('synthetic disk full'); return store.save(...args) } } })
  await assert.rejects(f.host.complete(session('disk'), request), error => error.code === 'USAGE_STORAGE_ERROR' && error.feedback.dispatch === 'unknown' && !!error.operationId)
})

test('missing Token capability or SDK methods is unsupported before dispatch', async () => {
  const f = fixture(); f.client.capabilities = async () => ({ schema: 'bailing.usage.v1', supported: true })
  await assert.rejects(f.host.complete(session('unsupported-core'), request), { code: 'USAGE_UNSUPPORTED' }); assert.equal(f.calls.length, 0)
  const missing = fixture(); delete missing.client.modelComplete
  await assert.rejects(missing.host.complete(session('unsupported-sdk'), request), { code: 'USAGE_UNSUPPORTED' })
  for (const mode of ['auto', 'legacy', 'unknown']) assert.throws(() => fixture({ mode }), { code: 'USAGE_INPUT_INVALID' })
})

test('new requests cannot change the original Session account binding', async () => {
  const f = fixture(), s = session('binding'); await f.host.complete(s, request)
  const moved = createUsageModelTransport({ client: { ...f.client, binding: { ...binding, accountId: 'other' } }, mode: 'model_gateway', store: f.store, ensureSessionPersisted: async () => true })
  await assert.rejects(moved.complete(s, { ...request, modelRequestId: 'other-step' }), { code: 'USAGE_BINDING_MISMATCH' })
  assert.equal(f.calls.length, 1)
})

test('expired original output stays historical and cannot become a pending replay loop', async () => {
  const f = fixture(), s = session('expired'); const first = await f.host.complete(s, request)
  const original = f.originals.get(first.operation_id); f.originals.set(first.operation_id, { ...original, response: undefined, response_expired: true })
  const recovered = await f.host.recoverOperation(s, first.operation_id)
  assert.equal(recovered.host_turn_active, false); assert.equal(recovered.delivery_state, 'unresolved_original'); assert.equal(recovered.next_action, 'contact_operator')
})

test('reopening keeps Token-only dispatch without a current grant or mode selector', async () => {
  const f = fixture(), s = session('reopen'); await f.host.complete(s, request)
  f.client.modelSummary = async () => ({ grant: null })
  const reopened = createUsageModelTransport({ client: f.client, store: f.store, ensureSessionPersisted: async () => true })
  await reopened.complete(s, { ...request, modelRequestId: 'new-step' })
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(([name]) => name === 'modelComplete'))
})

test('auxiliary request uses a durable local request group and cannot restart after its close fence', async () => {
  const f = fixture(), s = Session.create('helper', [])
  const first = await f.host.completeRequest(s, { modelRequestId: 'title-step', requestKind: 'auxiliary', messages: request.messages })
  assert.ok(first.request_group_id); assert.equal(s.events.filter(e => e.type === 'user/message').length, 0)
  await f.host.endTurn(s, first.request_group_id)
  assert.equal((await f.host.recoverOperation(s, first.operation_id)).host_turn_active, false)
  await assert.rejects(f.host.completeRequest(s, { modelRequestId: 'title-step-2', requestGroupId: first.request_group_id, requestKind: 'auxiliary', messages: request.messages }), { code: 'USAGE_TURN_ENDED' })
  assert.equal(f.calls.filter(([name]) => name === 'modelComplete').length, 1)
})

test('unsaved events and invalid user provenance cannot reach capability or model HTTP', async () => {
  for (const status of [{ unsavedEvents: 1 }, { state: 'storage_error' }, { state: 'recovery_gap' }]) {
    const f = fixture({ getPrimaryStatus: () => status }); let probes = 0
    f.client.capabilities = async () => { probes++; return caps }
    await assert.rejects(f.host.complete(session('primary'), request), { code: status.state === 'recovery_gap' ? 'USAGE_RECOVERY_GAP' : 'USAGE_STORAGE_ERROR' })
    assert.equal(probes, 0); assert.equal(f.calls.length, 0)
  }
  const f = fixture(), s = Session.create('plugin', [])
  s.append('user/message', { id: 'message', role: 'user', source: { kind: 'plugin', plugin: 'synthetic' }, content: [] }, { surfaceOp: 'append' })
  await assert.rejects(f.host.complete(s, request), { code: 'USAGE_USER_MESSAGE_REQUIRED' }); assert.equal(f.calls.length, 0)
})

test('real next input fences old results; plugin context retains original input eligibility', async () => {
  const f = fixture(), s = session('lifecycle'); const first = await f.host.complete(s, request)
  s.append('user/message', { id: 'plugin', role: 'user', source: { kind: 'plugin', plugin: 'synthetic' }, content: [] }, { surfaceOp: 'append' })
  assert.equal((await f.host.recoverOperation(s, first.operation_id)).host_turn_active, true)
  s.append('user/message', { id: 'next', role: 'user', source: { kind: 'user' }, content: [] }, { surfaceOp: 'append' })
  assert.equal((await f.host.recoverOperation(s, first.operation_id)).host_turn_active, false)
  await assert.rejects(f.host.complete(s, { ...request, modelRequestId: 'new-old-step' }), { code: 'USAGE_TURN_ENDED' })
  assert.equal(f.calls.filter(([name]) => name === 'modelComplete').length, 1)
})

test('cancel before intent persistence prevents provider dispatch and survives reopening', async () => {
  let saving, release
  const f = fixture({ ensureSessionPersisted: async () => { if (!saving) { saving = true; await new Promise(r => { release = r }) } return true } }), s = session('early-cancel')
  const running = f.host.complete(s, request); await until(() => release)
  await f.host.cancelTurn(s, 'message'); release()
  await assert.rejects(running, { code: 'USAGE_CANCELLED' })
  const reopened = createUsageModelTransport({ client: f.client, store: f.store, ensureSessionPersisted: async () => true })
  await assert.rejects(reopened.complete(s, request), { code: 'USAGE_TURN_ENDED' })
  assert.equal(f.calls.length, 0)
})

test('unknown host request fields cannot silently select a default model or another payer', async () => {
  const f = fixture(), s = session('input-fields')
  for (const extra of [{ service_id: 'second' }, { accountId: 'other' }, { billingGroupId: 'other' }]) {
    await assert.rejects(f.host.complete(s, { ...request, ...extra }), { code: 'USAGE_INPUT_INVALID' })
  }
  await assert.rejects(f.host.prepareRequest(s, { modelRequestId: 'helper', unexpected: 'value' }), { code: 'USAGE_INPUT_INVALID' })
  assert.equal(f.calls.length, 0)
})


test('real Session status carries authoritative credits and percentage snapshots without removing metering', async () => {
  const f = fixture(), s = session('presentation')
  const before = structuredClone(s.events)
  for (const presentation of [
    { schema: 'bailing.usage-presentation.v1', kind: 'credits', state: 'active', remaining: 1.159, total: 100, displayValue: '1.15' },
    { schema: 'bailing.usage-presentation.v1', kind: 'percentage', state: 'active', remaining: 0.5, total: 100, displayValue: '<1' },
    { schema: 'bailing.usage-presentation.v1', kind: 'percentage', state: 'expired', remaining: null, total: 100, displayValue: null },
    { schema: 'bailing.usage-presentation.v1', kind: 'none', state: 'unavailable', remaining: null, total: null, displayValue: null },
  ]) {
    const summary = { presentation, availableUsd: 1159, consumedUsd: 98841, pendingRequests: 1, resetAt: 9999, expiresAt: 19999 }
    f.client.modelSummary = async () => summary
    const status = await f.host.status(s)
    assert.deepEqual(status.summary, summary); assert.notEqual(status.summary, summary)
    assert.equal(status.summary.availableUsd, 1159); assert.equal(status.summary.pendingRequests, 1)
    assert.equal(status.state, 'ready'); assert.deepEqual(s.events, before); assert.equal(f.calls.length, 0)
  }
})

test('missing or unknown customer presentation never becomes raw Token UI or blocks completed model output', async () => {
  const f = fixture(), s = session('old-presentation')
  for (const presentation of [undefined, { schema: 'unknown' }, { schema: 'bailing.usage-presentation.v1', kind: 'credits', state: 'active', remaining: 1, total: 1, displayValue: '1000 Tokens' }]) {
    f.client.modelSummary = async () => ({ availableUsd: 1000, presentation })
    await assert.rejects(f.host.status(s), { code: 'USAGE_RESPONSE_INVALID', state: 'blocked' })
  }
  const output = await f.host.complete(s, request)
  assert.equal(output.billing_state, 'pending'); assert.equal(output.host_turn_active, true)
  assert.equal(f.calls.length, 1)
  f.host.getPrimaryStatus = () => ({ unsavedEvents: 1 })
  await assert.rejects(f.host.status(s), { code: 'USAGE_STORAGE_ERROR' })
})


test('a storage failure arriving during summary refresh retains priority over a protocol error', async () => {
  const f = fixture(), s = session('presentation-storage-race')
  f.client.modelSummary = async () => {
    f.host.getPrimaryStatus = () => ({ state: 'storage_error' })
    throw Object.assign(new Error('Synthetic invalid projection'), { code: 'USAGE_RESPONSE_INVALID' })
  }
  await assert.rejects(f.host.status(s), { code: 'USAGE_STORAGE_ERROR' })
})


test('model descriptor refresh exposes labels and cache hits cannot indefinitely postpone plan refresh', async () => {
  const f = fixture(), originalNow = Date.now
  let now = 1000, calls = 0, items = [{ service_id: 'base', label: 'Original model', model: 'model-base' }]
  Date.now = () => now
  try {
    f.client.modelModels = async () => { calls++; return { items } }
    assert.equal((await f.host.model({ serviceId: 'base' })).label, 'Original model')
    now += 59000
    assert.equal((await f.host.model({ serviceId: 'base' })).label, 'Original model'); assert.equal(calls, 1)
    items = [{ service_id: 'base', label: 'Updated label', model: 'model-base' }]; now += 1001
    assert.equal((await f.host.model({ serviceId: 'base' })).label, 'Updated label'); assert.equal(calls, 2)
    items = [{ service_id: 'second', label: 'Another model', model: 'model-second' }]
    await assert.rejects(f.host.model({ serviceId: 'base', refresh: true }), error => error.code === 'SERVICE_NOT_ENTITLED' && error.feedback.next_action === 'select_model')
    assert.equal((await f.host.model({ serviceId: 'second', refresh: true })).label, 'Another model')
    assert.equal(f.calls.length, 0)
  } finally { Date.now = originalNow }
})

test('new model requests may switch explicit services while original receipts and request hashes remain fixed', async () => {
  const f = fixture(), s = session('live-plan-selection')
  const a = await f.host.complete(s, { ...request, serviceId: 'base' })
  const b = await f.host.complete(s, { ...request, modelRequestId: 'second-step', serviceId: 'second' })
  assert.equal(a.service_id, 'base'); assert.equal(b.service_id, 'second')
  f.client.modelModels = async () => ({ items: [{ service_id: 'second', label: 'Second', model: 'model-second' }] })
  await assert.rejects(f.host.model({ serviceId: 'base', refresh: true }), { code: 'SERVICE_NOT_ENTITLED' })
  const recovered = await f.host.recoverOperation(s, a.operation_id)
  assert.equal(recovered.service_id, 'base'); assert.equal(f.calls.at(-1)[2].serviceId, 'base')
  assert.equal(f.calls.filter(([name]) => name === 'modelComplete').length, 2)
  await assert.rejects(f.host.complete(s, { ...request, serviceId: 'second' }), { code: 'USAGE_IDEMPOTENCY_CONFLICT' })
})

test('a normal empty catalog has no selectable descriptor and never dispatches a fallback model', async () => {
  const f = fixture(); f.client.modelModels = async () => ({ plan_id: 'plan', plan_revision: 2, selection: 'plan', default_service_id: null, items: [] })
  assert.deepEqual((await f.client.modelModels()).items, [])
  await assert.rejects(f.host.model({ refresh: true }), error => error.code === 'SERVICE_NOT_ENTITLED' && error.feedback.next_action === 'select_model')
  assert.equal(f.calls.length, 0)
})


test('model rates, fractional accounting and original rate snapshots pass through without local billing', async () => {
  const f = fixture(), s = session('weighted-rates')
  const catalogRate = { multiplier: 1.234567 }
  const descriptor = { service_id: 'base', label: 'Weighted model', model: 'synthetic', billing_rate: catalogRate, future_metadata: { synthetic: true } }
  f.client.modelModels = async () => ({ items: [descriptor] })
  assert.deepEqual(await f.host.model({ serviceId: 'base', refresh: true }), descriptor)
  const billingRate = { planId: 'plan', planRevision: 2, multiplier: 1.234567 }
  const original = f.client.modelComplete
  f.client.modelComplete = async wire => {
    const receipt = { ...await original(wire), billing_state: 'settled', billed_usd: 8.172835, overage_usd: 0.000001,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }, billing_rate: billingRate }
    f.originals.set(wire.operation_id, receipt); return receipt
  }
  const first = await f.host.complete(s, request)
  assert.equal(first.billed_usd, 8.172835); assert.equal(first.usage.totalTokens, 25); assert.deepEqual(first.billing_rate, billingRate)
  f.client.modelModels = async () => ({ items: [{ ...descriptor, billing_rate: { multiplier: 4 } }] })
  await f.host.model({ serviceId: 'base', refresh: true })
  const recovered = await f.host.recoverOperation(s, first.operation_id)
  assert.deepEqual(recovered.billing_rate, billingRate); assert.equal(recovered.billed_usd, 8.172835)
  assert.equal(f.calls.filter(([name]) => name === 'modelComplete').length, 1)
  f.client.modelSummary = async () => ({ availableUsd: 999.123456, consumedUsd: 0.876544, currentPeriodConsumedUsd: 0.876544,
    overageUsd: 0.000001, pendingRequests: 0, plan: { id: 'plan', multiplier: 4 },
    presentation: { schema: 'bailing.usage-presentation.v1', kind: 'credits', state: 'active', remaining: 0.999123456, total: 1, displayValue: '0.99' } })
  const snapshot = await f.host.status(s)
  assert.equal(snapshot.summary.availableUsd, 999.123456); assert.equal(snapshot.summary.presentation.displayValue, '0.99')
  assert.equal(snapshot.summary.plan.multiplier, 4)
})

test('native stream usage remains actual provider counts, never weighted allowance debit', async () => {
  const f = fixture(), s = session('weighted-stream'), original = f.client.modelStream
  f.client.modelStream = async function* (wire) {
    for await (const event of original(wire)) {
      if (event.type !== 'operation') { yield event; continue }
      const receipt = { ...event.operation, billing_state: 'settled', billed_usd: 8.172835, overage_usd: 0,
        billing_rate: { planId: 'plan', planRevision: 2, multiplier: 1.234567 },
        response: { ...event.operation.response, usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } }
      f.originals.set(wire.operation_id, receipt); yield { ...event, operation: receipt }
    }
  }
  const chunks = []
  for await (const chunk of usageLlmChunks(f.host.stream(s, request))) chunks.push(chunk)
  const usage = chunks.find(chunk => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 20); assert.equal(usage.outputTokens, 5)
  assert.equal(f.calls.filter(([name]) => name === 'modelStream').length, 1)
})

test('native envelope crosses the real Session transport and remains recoverable while billing is pending', async () => {
  const f = fixture(), s = session('native-envelope')
  const header = { schema: 'bailing.provider-response.v1', format: 'sse', status: 200, content_type: 'text/event-stream' }
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic native' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  let dispatches = 0
  f.client.modelStream = async function* (wire) {
    dispatches++
    yield { type: 'provider', provider: { ...header, data: body } }
    const receipt = { ...result(wire), response: { ...header, body } }
    f.originals.set(wire.operation_id, receipt)
    yield { type: 'operation', operation: receipt }
  }
  const chunks = []; for await (const chunk of usageLlmChunks(f.host.stream(s, request))) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Synthetic native')
  const [id] = f.originals.keys(); const recovered = await f.host.recoverOperation(s, id)
  assert.equal(recovered.response.body, body); assert.equal(recovered.billing_state, 'pending'); assert.equal(dispatches, 1)
})

test('new transport negotiates native provider forwarding before model dispatch', async () => {
  const f = fixture()
  f.client.capabilities = async () => ({ ...caps, model_gateway: { ...caps.model_gateway, provider_response: undefined } })
  await assert.rejects(f.host.complete(session('old-provider-envelope'), request), { code: 'USAGE_UNSUPPORTED' })
  assert.equal(f.calls.length, 0)
})

test('model tools persist original identity and recover a lost generation ACK without any second generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailing-usd-tools-'))
  try {
    const f = fixture({store: createFileSessionUsageStore({directory})}), s = session('image-session')
    let generations = 0, catalogs = 0
    f.client.modelTools = async () => { catalogs++; return {items:[{service_id:'image',callable:true}]} }
    f.client.runModelTool = async wire => {
      generations++
      f.originals.set(wire.operation_id, {...result(wire), usage:null, raw_usage:{output_image_count:1}, response:{schema:'bailing.model-tool-result.v1',outputs:[{type:'image',url:'https://assets.example.com/synthetic.png'}]}})
      throw Error('lost ACK')
    }
    const input = {userMessageId:'message',modelRequestId:'image-call',serviceId:'image',arguments:{prompt:'Synthetic image'}}
    await assert.rejects(f.host.runModelTool(s,input), error => error.feedback.dispatch === 'unknown' && error.feedback.next_action === 'inspect_original')
    const reopened = fixture({client:f.client,store:createFileSessionUsageStore({directory})}).host
    const receipt = await reopened.runModelTool(s,input)
    assert.equal(receipt.recovered_original,true); assert.equal(receipt.response.outputs.length,1)
    assert.equal(generations,1); assert.equal(catalogs,1)
    await assert.rejects(reopened.runModelTool(s,{...input,arguments:{prompt:'Changed'}}),{code:'USAGE_IDEMPOTENCY_CONFLICT'})
    assert.equal(generations,1)
    for (const name of await readdir(directory)) assert.ok(!(await readFile(join(directory,name),'utf8')).includes('Synthetic image'))
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test('tool catalog does not generate and unselected or unavailable model tools never dispatch', async () => {
  const f = fixture(), s=session('tool-catalog'); let count=0
  f.client.modelTools=async()=>({items:[{service_id:'image',callable:false}]})
  f.client.runModelTool=async()=>{count++;throw Error('should not run')}
  assert.equal((await f.host.modelTools()).items.length,1); assert.equal(count,0)
  await assert.rejects(f.host.runModelTool(s,{userMessageId:'message',modelRequestId:'image',serviceId:'image',arguments:{}}),{code:'USAGE_MODEL_TOOL_UNAVAILABLE'})
  await assert.rejects(f.host.runModelTool(s,{userMessageId:'message',modelRequestId:'other',serviceId:'other',arguments:{}}),{code:'SERVICE_NOT_ENTITLED'})
  assert.equal(count,0)
})

test('cancelling a generation fences late output; original read remains possible without generation replay', async () => {
  const f=fixture(),s=session('late-image'); let release,wire,count=0
  f.client.modelTools=async()=>({items:[{service_id:'image',callable:true}]})
  f.client.runModelTool=async value=>{count++;wire=value;f.originals.set(wire.operation_id,result(wire));await new Promise(r=>{release=r});return result(wire)}
  const pending=f.host.runModelTool(s,{userMessageId:'message',modelRequestId:'image',serviceId:'image',arguments:{prompt:'synthetic'}})
  await until(()=>release)
  await f.host.cancelTurn(s,'message');release()
  const receipt=await pending
  assert.equal(receipt.host_turn_active,false);assert.equal(receipt.delivery_state,'cancelled_late_result')
  assert.equal((await f.host.recoverOperation(s,wire.operation_id)).host_turn_active,false);assert.equal(count,1)
})

test('asynchronous model tool admission yields pending then original read supplies result without another POST',async()=>{
  const f=fixture(),s=session('async-tool');let generations=0,wire
  f.client.modelTools=async()=>({items:[{service_id:'image',callable:true}]})
  f.client.runModelTool=async value=>{generations++;wire=value;return {...result(value),state:'admitted',result_state:'pending',dispatch:'not_dispatched',response:undefined,next_action:'inspect_original'}}
  const pending=await f.host.runModelTool(s,{userMessageId:'message',modelRequestId:'image',serviceId:'image',arguments:{prompt:'synthetic'}})
  assert.equal(pending.delivery_state,'pending_original');assert.equal(pending.host_turn_active,false)
  f.originals.set(wire.operation_id,{...result(wire),response:{schema:'bailing.model-tool-result.v1',outputs:[{type:'image',url:'https://assets.example.com/synthetic.png'}]}})
  const done=await f.host.recoverOperation(s,wire.operation_id)
  assert.equal(done.host_turn_active,true);assert.equal(done.response.outputs.length,1);assert.equal(generations,1)
})

test('terminal provider failure persists as rejected and restores original ID without blocking a new independent request',async()=>{
 const f=fixture(),s=session('provider-failed');
 f.client.modelComplete=async wire=>{f.calls.push(['modelComplete',wire]);const done={...result(wire),state:'failed',result_state:'failed',billing_state:'settled',response:undefined,dispatch:'rejected',next_action:'contact_operator',error:{code:'USAGE_PROVIDER_REJECTED',http_status:404,retryable:false,next_action:'contact_operator'}};f.originals.set(wire.operation_id,done);return done;};
 const first=await f.host.complete(s,request);assert.equal(first.delivery_state,'request_failed');assert.equal(first.host_turn_active,false);
 const reopened=createUsageModelTransport({client:f.client,store:f.store,ensureSessionPersisted:async()=>true});
 assert.equal((await reopened.complete(s,request)).operation_id,first.operation_id);assert.equal(f.calls.filter(x=>x[0]==='modelComplete').length,1);
 assert.equal((await reopened.status(s)).pendingOperations.length,0);
 await reopened.complete(s,{...request,modelRequestId:'independent'});assert.equal(f.calls.filter(x=>x[0]==='modelComplete').length,2);
});
test('unknown result is unresolved rather than generating; pending remains pending and neither is replayed',async()=>{
 for(const state of ['pending','unknown']){
  const f=fixture(),s=session('provider-'+state);f.client.modelComplete=async wire=>{f.calls.push(['modelComplete',wire]);const done={...result(wire),state:state==='pending'?'dispatch_committed':'unknown',result_state:state,response:undefined};f.originals.set(wire.operation_id,done);return done;};
  const first=await f.host.complete(s,request);assert.equal(first.delivery_state,state==='unknown'?'unresolved_original':'pending_original');
  await f.host.recoverOperation(s,first.operation_id);assert.equal(f.calls.filter(x=>x[0]==='modelComplete').length,1);
 }
});
