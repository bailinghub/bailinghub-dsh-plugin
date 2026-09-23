// Explicit opt-in USD candidate acceptance. The Core fixture creates and drops
// only its own random loopback test database. No deployed service is used.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createUsageModelTransport } from '../lib/usage-model-transport.js'
import { createMemorySessionUsageStore } from '../lib/session-usage-store.js'
const fixturePath = process.env.BAILINGHUB_USAGE_CORE_FIXTURE
const sdkPath = process.env.BAILINGHUB_USAGE_SDK_MODULE
if (!fixturePath || !sdkPath) throw new Error('Exact Core fixture and SDK module paths are required; no deployed Hub is used.')
const { createUsageTestHarness } = await import(pathToFileURL(fixturePath).href)
const { getBillingRepository } = await import(new URL('./billing-repository.ts', pathToFileURL(fixturePath)))
const { BailingHubUsageClient } = await import(pathToFileURL(sdkPath).href)
const { Session } = await import(new URL('../node_modules/@deepseek-ai/dsh-session/lib/index.js', import.meta.url))
const request = { userMessageId: 'message-1', modelRequestId: 'model-1', messages: [{ role: 'user', content: 'Synthetic product query' }] }
function newSession(id) {
  const session = Session.create(id, [])
  session.append('user/message', { id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic product query' }] }, { surfaceOp: 'append' })
  return session
}
function usageClient(h, seed, options = {}) {
  return new BailingHubUsageClient({ hubUrl: h.baseUrl, userId: seed.actor.userId, accountId: seed.accountId,
    serviceId: h.service.id, accessTokenProvider: () => seed.token, ...options })
}
function host(client, store = createMemorySessionUsageStore()) {
  return createUsageModelTransport({ client, store, ensureSessionPersisted: async () => true })
}

async function settled(h, client, receipt) {
  await h.tokens.drainSettlements()
  return {...receipt, ...await client.inspectModelRequest(receipt.operation_id, {serviceId:receipt.service_id,conversationId:receipt.conversation_id,turnId:receipt.turn_id})}
}

test('actual Core / MySQL / provider / SDK / real Session: actual Tokens stay separate from USD fees', async t => {
  const h = await createUsageTestHarness(); t.after(() => h.close())
  const seed = await h.seedUser(), client = usageClient(h, seed), usage = host(client), session = newSession('synthetic-token')
  assert.equal((await client.capabilities()).streaming, true)
  const first = await settled(h, client, await usage.complete(session, request))
  assert.equal(first.result_state, 'complete'); assert.equal(first.usage.totalTokens, 25); assert.ok(first.billed_usd > 0)
  await usage.complete(session, { ...request, modelRequestId: 'model-2' }); await h.tokens.drainSettlements()
  const snapshot = await usage.status(session)
  assert.equal(snapshot.summary.consumedUsd, first.billed_usd * 2)
  assert.equal(snapshot.summary.presentation.kind, 'credits'); assert.ok(snapshot.summary.presentation.remaining < snapshot.summary.presentation.total)
  assert.equal(h.state.calls, 2)
  assert.equal((await usage.complete(session, request)).operation_id, first.operation_id); assert.equal(h.state.calls, 2)
  await usage.endTurn(session, 'message-1')
  assert.equal((await usage.recoverOperation(session, first.operation_id)).host_turn_active, false)
})

test('lost ACK and offline reopen recover the same request after network returns', async t => {
  const h = await createUsageTestHarness(); t.after(() => h.close())
  const seed = await h.seedUser(); let lose = true, offline = false
  const client = usageClient(h, seed, { fetchImpl: async (url, init) => {
    if (offline) throw Error('synthetic offline')
    const response = await fetch(url, init)
    if (lose && init.method === 'POST' && url.endsWith('/model/requests')) { lose = false; await response.text(); throw Error('synthetic lost ACK') }
    return response
  } })
  const store = createMemorySessionUsageStore(), session = newSession('synthetic-offline'), usage = host(client, store)
  await assert.rejects(usage.complete(session, request), { code: 'USAGE_TRANSPORT_UNAVAILABLE', dispatch: 'unknown' })
  const reopened = Session.create(session.id, session.events), restored = host(client, store)
  offline = true
  await assert.rejects(restored.complete(reopened, request), { code: 'USAGE_TRANSPORT_UNAVAILABLE' })
  offline = false
  const recovered = await settled(h, client, await restored.complete(reopened, request))
  assert.equal(recovered.result_state, 'complete'); assert.equal(recovered.recovered_original, true)
  assert.equal((await client.modelSummary()).consumedUsd, recovered.billed_usd); assert.equal(h.state.calls, 1)
})

test('a periodic USD allowance permits current reply overage then rejects new requests', async t => {
  const h = await createUsageTestHarness(); t.after(() => h.close())
  const seed = await h.seedUser({ grant: false }), tokens = getBillingRepository(h.repository)
  const plan = await tokens.putPlan({ id: 'synthetic-periodic', label: 'Synthetic weekly', expected_revision: 0, config: {
    mode: 'periodic', serviceIds: [h.service.id], priceUsd: 0.000001, multiplier: 1, periodUnit: 'week',
    duration: { unit: 'month', count: 1 },
  } })
  await tokens.grant(seed.accountId, { request_key: 'synthetic-grant', plan_id: plan.id, expected_revision: 0 })
  const client = usageClient(h, seed), usage = host(client), session = newSession('synthetic-periodic')
  const original = await settled(h, client, await usage.complete(session, request))
  assert.ok(original.billed_usd > 0.000001); assert.ok(original.overage_usd > 0)
  await assert.rejects(usage.complete(session, { ...request, modelRequestId: 'model-2' }), { code: 'QUOTA_WINDOW_EXHAUSTED' })
  assert.equal(h.state.calls, 1); assert.equal((await usage.recoverOperation(session, original.operation_id)).result_state, 'complete')
  const summary = (await usage.status(session)).summary; assert.equal(summary.availableUsd, 0); assert.ok(summary.resetAt)
  assert.deepEqual(summary.presentation, { schema: 'bailing.usage-presentation.v1', kind: 'percentage', state: 'depleted', remaining: 0, total: 100, displayValue: '0' })
})

test('usage pending does not invalidate a completed reply or block the next request', async t => {
  const h = await createUsageTestHarness(); t.after(() => h.close()); h.state.mode = 'missing_usage'
  const seed = await h.seedUser(), usage = host(usageClient(h, seed)), session = newSession('synthetic-pending')
  const first = await usage.complete(session, request)
  assert.equal(first.result_state, 'complete'); assert.equal(first.billing_state, 'pending'); assert.equal(first.host_turn_active, true)
  assert.equal((await usage.complete(session, { ...request, modelRequestId: 'model-2' })).host_turn_active, true)
  assert.equal(h.state.calls, 2)
})


test('same model_gateway identity reads live plan labels, switches new requests and retains original recovery', async t => {
  const h = await createUsageTestHarness(); t.after(() => h.close())
  const seed = await h.seedUser(), tokens = getBillingRepository(h.repository)
  const exchange = await h.request('/usage/v1/sessions/exchange', h.issuerToken, 'POST', { request_key: randomUUID(), tenant: 'synthetic', subject: seed.subject, service_id: h.service.id, model_access: 'token_gateway' })
  assert.equal(exchange.status, 200)
  const client = usageClient(h, { ...seed, token: exchange.body.credential, actor: exchange.body.session }), usage = host(client), session = newSession('synthetic-live-model-plan')
  const originalBinding = structuredClone(client.binding), initial = await client.modelSummary()
  const originalGrant = structuredClone(initial.grant)
  assert.equal(Object.hasOwn(originalGrant.config, 'serviceIds'), false)
  const second = await h.repository.putService({ id: 'synthetic-second', label: 'Synthetic second model', expectedRevision: 0, config: { ...h.service.config, model: 'synthetic-second-model' } })
  let revision = initial.plan.revision
  const selectModels = async serviceIds => {
    const plan = await tokens.putPlan({ id: initial.plan.id, label: initial.plan.label, expected_revision: revision, config: { ...originalGrant.config, serviceIds, multiplier: initial.plan.multiplier } })
    revision = plan.revision
  }
  await selectModels([h.service.id, second.id])
  const models = await client.modelModels()
  assert.deepEqual(models.items.map(item => [item.service_id, item.label]), [[h.service.id, h.service.label], [second.id, second.label]])
  assert.equal(h.state.calls, 0)
  const first = await settled(h, client, await usage.complete(session, { ...request, serviceId: h.service.id }))
  await selectModels([second.id])
  const changed = await client.modelModels()
  assert.equal(changed.default_service_id, second.id); assert.equal(changed.plan_revision, revision)
  await assert.rejects(usage.model({ serviceId: h.service.id, refresh: true }), error => error.code === 'SERVICE_NOT_ENTITLED' && error.feedback.next_action === 'select_model')
  await assert.rejects(usage.complete(session, { ...request, modelRequestId: 'removed-model-step', serviceId: h.service.id }), error => error.code === 'SERVICE_NOT_ENTITLED' && error.feedback.dispatch === 'not_dispatched' && error.feedback.next_action === 'select_model')
  assert.equal(h.state.calls, 1)
  assert.equal((await usage.model({ serviceId: second.id, refresh: true })).label, second.label)
  const next = await settled(h, client, await usage.complete(session, { ...request, modelRequestId: 'new-selected-step', serviceId: second.id }))
  assert.equal(next.service_id, second.id); assert.equal(h.state.calls, 2)
  const recovered = await usage.recoverOperation(session, first.operation_id)
  assert.equal(recovered.service_id, h.service.id); assert.equal(h.state.calls, 2)
  await selectModels([])
  const empty = await client.modelModels()
  assert.deepEqual(empty.items, []); assert.equal(empty.default_service_id, null); assert.equal(empty.selection, 'plan')
  const summary = (await usage.status(session)).summary
  assert.deepEqual(summary.grant, originalGrant); assert.deepEqual(summary.plan.serviceIds, [])
  assert.equal(summary.availableUsd, initial.availableUsd - first.billed_usd - next.billed_usd); assert.equal(summary.consumedUsd, first.billed_usd + next.billed_usd)
  assert.deepEqual(client.binding, originalBinding); assert.equal(summary.accountId, seed.accountId)
  assert.equal(h.state.calls, 2)
})
