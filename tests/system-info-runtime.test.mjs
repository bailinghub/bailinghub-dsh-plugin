import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin } from '../lib/index.js'
import { createLazySdkTransport } from '../lib/transport.js'
import { createMemorySessionScopeStore } from '../lib/session-scope-store.js'
import { baseAssembly, callsFor, createMockAgent, createMockHost, createMockTransport, turnResponse, userMessage } from './helpers/mock-host.mjs'

const HUB = 'https://hub.example.com'
const A = `conn_${'1'.repeat(32)}`
const B = `conn_${'2'.repeat(32)}`
const C = `conn_${'3'.repeat(32)}`
const D = `conn_${'4'.repeat(32)}`
const uuid = (number) => `123e4567-e89b-42d3-a456-${String(number).padStart(12, '0')}`
const config = { hubUrl: HUB, clientAppId: 'service_app', workspace: 'service', connectionName: 'Local account' }
const capabilities = { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }

function fixture(t, options = {}) {
  const host = createMockHost()
  const client = createMockAgent('system-info')
  client.agent.session = Session.create(options.sessionId ?? 'system-info-session', [])
  const entries = [A, B, C, D].map((connectionKey, index) => ({
    ...config, connectionKey, connectionName: 'Same local label', state: 'authorized', sessionId: uuid(index + 1),
    ...(connectionKey === D ? { clientAppId: 'inventory_app', workspace: 'inventory' } : {}),
  }))
  const scopeStore = createMemorySessionScopeStore()
  const selected = options.keys ?? [A, D]
  let revision = 'a'.repeat(64)
  let runCount = 10
  const infoFor = (metadata) => {
    const member = entries.find((entry) => entry.connectionKey === metadata.connectionKey)
    assert.ok(selected.includes(member.connectionKey), 'an unselected system must receive zero description requests')
    assert.deepEqual(Object.keys(metadata).sort(), ['connectionKey', 'expectedBinding', 'signal', 'workspace'])
    assert.deepEqual(metadata.expectedBinding, { hubUrl: member.hubUrl, clientAppId: member.clientAppId, workspace: member.workspace, sessionId: member.sessionId })
    const inventory = member.connectionKey === D
    return {
      schema_version: 'bailing.agent-system-info.v1',
      binding: { client_app_id: member.clientAppId, session_id: member.sessionId, workspace: member.workspace },
      metadata_status: 'configured', revision,
      system: {
        name: inventory ? 'Inventory management' : 'Service scheduling',
        summary: inventory ? 'Track stock and replenishment.' : 'Coordinate appointments and service delivery.',
        domains: inventory ? ['Stock', 'Replenishment'] : ['Appointments'],
        boundaries: ['Actual actions depend on the selected authorization.'],
      },
      tool_status: 'not_loaded', availability: 'unknown',
    }
  }
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: C, connections: structuredClone(entries) }),
    status: async (metadata) => {
      assert.ok(selected.includes(metadata.connectionKey))
      const entry = entries.find((member) => member.connectionKey === metadata.connectionKey)
      return { state: entry.state, sessionId: entry.sessionId, workspace: entry.workspace, connectionKey: entry.connectionKey }
    },
    getConversationArchiveCapabilities: async () => capabilities,
    getSystemInfo: async (metadata) => {
      const result = infoFor(metadata)
      return options.getSystemInfo ? options.getSystemInfo(metadata, result, entries) : result
    },
    startTurn: async () => turnResponse({ runId: uuid(++runCount) }),
  })
  if (options.oldSdk) delete mock.transport.getSystemInfo
  createAgentClientPlugin({ transport: mock.transport, scopeStore }).apply(host.ctx, config)
  host.emit('session/created', client.agent.session)
  t.after(() => host.dispose())
  const runtime = host.services.get('bailingHubAgentClient')
  const f = { ...client, host, runtime, mock, entries, scopeStore, selected, session: client.agent.session,
    changeRevision(value) { revision = value },
  }
  return f
}

async function select(f) { return f.runtime.setSessionScope(f.session.id, { connectionKeys: f.selected }) }
function emit(f, type, data) {
  const event = f.session.append(type, data, type === 'user/message' ? { surfaceOp: 'append' } : undefined)
  f.host.emit('session/event', f.session, event)
}
function begin(f, turn = 1) {
  const message = userMessage(`system-info-${turn}`, 'SYNTHETIC_USER_TEXT_MUST_NOT_ENTER_METADATA_REQUEST')
  emit(f, 'turn/start', { turn }); emit(f, 'user/message', message)
  f.host.emit('agent/inbox/claimed', { agent: f.agent, turn, message })
  return f.host.waterfall('system-prompt/assemble', baseAssembly(), { agent: f.agent, signal: new AbortController().signal }, async () => baseAssembly())
}
function directory(assembly) {
  const profile = assembly.sections.find((entry) => entry.name === 'bailinghub:agent-client-profile').text
  return JSON.parse(profile.split('\n').find((line) => line.startsWith('Authorization directory: ')).slice('Authorization directory: '.length))
}
function end(f, turn = 1) { emit(f, 'turn/end', { turn, reason: { kind: 'cancelled' } }) }
async function until(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Synthetic test operation did not start')
}

for (const [name, keys, runs] of [['single', [A], 1], ['same-system A/B', [A, B], 2], ['cross-system A/D', [A, D], 0]]) {
  test(`${name} gets controlled system purpose before first capability search with unchanged run policy`, async (t) => {
    const f = fixture(t, { keys }); const scope = await select(f)
    const initialEvents = f.session.events.length
    const result = await begin(f)
    const targets = directory(result)
    assert.deepEqual(targets.map((item) => item.authorization_ref), scope.authorizations.map((item) => item.authorizationRef))
    assert.ok(targets.every((item) => item.metadata_status === 'configured' && item.system_description.summary))
    assert.ok(targets.every((item) => item.system_ref && item.authorization_scope.includes('server checks')))
    if (name === 'same-system A/B') assert.equal(targets[0].system_ref, targets[1].system_ref)
    if (name === 'cross-system A/D') {
      assert.notEqual(targets[0].system_ref, targets[1].system_ref)
      assert.ok(targets.every((item) => item.tool_status === 'not_loaded' && item.availability === 'unknown'))
      assert.match(JSON.stringify(result), /not_loaded means tools have not been loaded yet, not that the system has no capabilities/)
    }
    assert.equal(callsFor(f.mock.calls, 'startTurn').length, runs)
    assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 0)
    const info = callsFor(f.mock.calls, 'getSystemInfo')
    assert.deepEqual(info.map((call) => call.args[0].connectionKey), keys)
    if (runs) assert.ok(f.mock.calls.lastIndexOf(info.at(-1)) < f.mock.calls.findIndex((call) => call.method === 'startTurn'))
    assert.doesNotMatch(JSON.stringify(info), /SYNTHETIC_USER_TEXT/)
    assert.doesNotMatch(JSON.stringify(result), /conn_[a-f0-9]{32}|123e4567|hub\.example\.com/)
    if (keys.length === 1) assert.doesNotMatch(JSON.stringify(result), /Inventory management/)
    const snapshot = await f.scopeStore.load(f.session.id)
    assert.doesNotMatch(JSON.stringify(snapshot), /system_description|metadata_status|Service scheduling/)
    assert.equal(f.session.events.length, initialEvents + 2, 'description loading does not synthesize persistent Session events')
  })
}

for (const [name, override, expected] of [
  ['missing', (_metadata, value) => ({ ...value, metadata_status: 'missing', revision: null, system: null }), 'missing'],
  ['old Core', () => { throw Object.assign(new Error('unsupported'), { publicCode: 'system_info_unsupported', statusCode: 404 }) }, 'unsupported'],
  ['temporary outage', () => { throw Object.assign(new Error('timeout'), { statusCode: 503 }) }, 'unknown'],
  ['transport-owned timeout', () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }) }, 'unknown'],
  ['malformed metadata', (_metadata, value) => ({ ...value, system: { ...value.system, summary: 'x'.repeat(401) } }), 'unknown'],
  ['control characters', (_metadata, value) => ({ ...value, system: { ...value.system, name: 'Service\u0000Name' } }), 'unknown'],
  ['unclassified 404', () => { throw Object.assign(new Error('not found'), { statusCode: 404 }) }, 'unknown'],
  ['temporary error with mismatched route status', () => { throw Object.assign(new Error('temporarily unavailable'), { statusCode: 503, publicCode: 'route_unavailable' }) }, 'unknown'],
]) {
  test(`${name} description preserves selected capability search and does not mark unknown tools absent`, async (t) => {
    const f = fixture(t, { getSystemInfo: override }); await select(f)
    const result = await begin(f)
    assert.ok(directory(result).every((item) => item.metadata_status === expected && item.tool_status === 'not_loaded' && item.system_description === null))
    assert.ok(directory(result).every((item) => item.availability === 'unknown' && item.availability_reason === undefined))
    assert.ok(f.local.has('search_business_capabilities'))
    assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'business')
    assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  })
}

test('old SDK needs no system-info method and same-system tools remain available', async (t) => {
  const f = fixture(t, { keys: [A, B], oldSdk: true }); await select(f)
  assert.ok(directory(await begin(f)).every((item) => item.metadata_status === 'unsupported'))
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 2)
  assert.ok(f.local.has('search_business_capabilities'))
})

test('a disabled direct-tools gate preserves the product description without promising availability', async (t) => {
  const f = fixture(t, { getSystemInfo: (_metadata, value) => ({ ...value, availability: 'unavailable', unavailable_reason: 'agent_direct_disabled' }) })
  await select(f)
  assert.ok(directory(await begin(f)).every((item) => item.system_description && item.availability === 'unavailable' && item.tool_status === 'not_loaded'))
})

test('an explicit unavailable original route stays selected but has a distinct directory availability reason', async (t) => {
  let unavailable = true
  const f = fixture(t, { getSystemInfo: (metadata, value) => {
    if (unavailable && metadata.connectionKey === D) throw Object.assign(new Error('original route unavailable'), { statusCode: 404, publicCode: 'route_unavailable' })
    return value
  } })
  const selected = await select(f)
  const result = directory(await begin(f))
  const original = await f.scopeStore.load(f.session.id)
  assert.equal(result[0].availability, 'unknown')
  assert.equal(result[1].metadata_status, 'unknown')
  assert.equal(result[1].system_description, null)
  assert.equal(result[1].tool_status, 'not_loaded')
  assert.equal(result[1].availability, 'unavailable')
  assert.equal(result[1].availability_reason, 'route_unavailable')
  assert.equal(result[1].unavailable_reason, undefined, 'a directory error must not masquerade as a wire switch reason')
  assert.deepEqual(result.map((target) => target.authorization_ref), selected.authorizations.map((target) => target.authorizationRef))
  assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'business')
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
  end(f); unavailable = false
  const recovered = directory(await begin(f, 2))
  assert.equal(recovered[1].metadata_status, 'configured')
  assert.equal(recovered[1].availability, 'unknown')
  assert.equal(recovered[1].availability_reason, undefined)
  assert.deepEqual(await f.scopeStore.load(f.session.id), original)
})

test('route_unavailable is not accepted as a system-info wire switch reason', async (t) => {
  const f = fixture(t, { getSystemInfo: (_metadata, value) => ({ ...value, availability: 'unavailable', unavailable_reason: 'route_unavailable' }) })
  await select(f)
  assert.ok(directory(await begin(f)).every((item) => item.metadata_status === 'unknown' && item.availability === 'unknown' && item.availability_reason === undefined))
})

test('metadata revisions are bounded opaque values rather than inferred tool revisions', async (t) => {
  const f = fixture(t, { getSystemInfo: (_metadata, value) => ({ ...value, revision: 'description-revision-2' }) })
  await select(f)
  assert.ok(directory(await begin(f)).every((item) => item.metadata_revision === 'description-revision-2' && item.metadata_status === 'configured'))
})

for (const [name, failure] of [
  ['revoked authorization', () => { throw Object.assign(new Error('revoked'), { statusCode: 401 }) }],
  ['forbidden authorization', () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }) }],
  ['changed response binding', (_metadata, value) => ({ ...value, binding: { ...value.binding, session_id: uuid(99) } })],
]) {
  test(`${name} during description loading blocks the original whole group`, async (t) => {
    const f = fixture(t, { getSystemInfo: failure }); await select(f)
    const result = await begin(f)
    assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'blocked')
    assert.equal(result.tools.length, 0)
    assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
    assert.equal(callsFor(f.mock.calls, 'getSystemInfo').length, 1)
    assert.doesNotMatch(JSON.stringify(result), /Service scheduling|Inventory management/)
  })
}

test('revocation known during whole-scope validation prevents every description request', async (t) => {
  const f = fixture(t); await select(f)
  f.entries.find((entry) => entry.connectionKey === D).state = 'revoked'
  assert.equal((await begin(f)).tools.length, 0)
  assert.equal(callsFor(f.mock.calls, 'getSystemInfo').length, 0)
})

for (const selected of [false, true]) {
  test(`${selected ? 'explicit empty scope' : 'unselected conversation'} remains chat with zero description or business requests`, async (t) => {
    const f = fixture(t, { keys: [] })
    if (selected) await select(f)
    f.mock.calls.length = 0
    assert.equal((await begin(f)).tools.length, 0)
    assert.equal(f.mock.calls.filter((call) => call.method !== 'connectionsList').length, 0)
  })
}

test('cancelled metadata lookup cannot hold the turn open or overwrite a newer revision when it returns late', async (t) => {
  let late
  let first = true
  const f = fixture(t, { getSystemInfo: async (_metadata, value) => {
    if (first) { first = false; return new Promise((resolve, reject) => { late = { resolve: () => resolve(value), reject } }) }
    return value
  } })
  await select(f)
  const pending = begin(f)
  await until(() => late)
  end(f)
  assert.equal((await pending).tools.length, 0)
  assert.equal(callsFor(f.mock.calls, 'getSystemInfo')[0].args[0].signal.aborted, true)
  f.changeRevision('b'.repeat(64))
  const next = await begin(f, 2)
  assert.ok(directory(next).every((item) => item.metadata_revision === 'b'.repeat(64)))
  late.reject(Object.assign(new Error('late stale forbidden'), { statusCode: 403 }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'business')
  assert.ok(f.local.has('search_business_capabilities'))
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 0)
})

test('system metadata refresh does not change frozen scope revision or labels', async (t) => {
  const f = fixture(t); await select(f); await begin(f)
  const snapshot = await f.scopeStore.load(f.session.id)
  end(f)
  f.changeRevision('b'.repeat(64))
  f.entries[0].connectionName = 'A different user-editable label'
  assert.ok(directory(await begin(f, 2)).every((item) => item.metadata_revision === 'b'.repeat(64) &&
    item.label === 'Authorization name pending sync' && item.subject_display_status === 'unsupported'))
  assert.deepEqual(await f.scopeStore.load(f.session.id), snapshot)
})

test('lazy production transport forwards optional descriptions and clearly degrades an older SDK', async () => {
  const { transport, calls } = createMockTransport({ getSystemInfo: async (options) => ({ metadata_status: 'missing', options }) })
  const lazy = createLazySdkTransport(config, { importModule: async () => ({ createAgentClientTransport: () => transport }) })
  const options = { connectionKey: A, workspace: 'service', expectedBinding: { ...config, sessionId: uuid(1) }, signal: new AbortController().signal }
  assert.deepEqual(await lazy.getSystemInfo(options), { metadata_status: 'missing', options })
  assert.deepEqual(callsFor(calls, 'getSystemInfo')[0].args, [options])
  delete transport.getSystemInfo
  await assert.rejects(lazy.getSystemInfo(options), (error) => error.publicCode === 'system_info_unsupported')
  assert.equal(typeof lazy.startTurn, 'function')
})
