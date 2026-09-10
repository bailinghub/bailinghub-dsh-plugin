import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createAgentClientPlugin, createMemoryConversationArchiveStore } from '../lib/index.js'
import { createMemorySessionScopeStore } from '../lib/session-scope-store.js'
import { projectSubjectDisplay, PENDING_AUTHORIZATION_NAME } from '../lib/subject-display.js'
import { baseAssembly, callsFor, createMockAgent, createMockHost, createMockTransport, settle, turnResponse, userMessage } from './helpers/mock-host.mjs'

const A = `conn_${'1'.repeat(32)}`
const B = `conn_${'2'.repeat(32)}`
const C = `conn_${'3'.repeat(32)}`
const D = `conn_${'4'.repeat(32)}`
const uuid = (n) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`
const config = { hubUrl: 'https://hub.example.com', clientAppId: 'service_app', workspace: 'service', connectionName: 'Unverified bootstrap alias' }
const supplied = (name) => ({ subjectDisplay: { name }, subjectDisplayStatus: 'provided', subjectDisplaySource: 'verified' })

function fixture(t, options = {}) {
  const host = createMockHost()
  const client = createMockAgent('subject-display')
  const session = options.session ?? Session.create('subject-display-session', [])
  client.agent.session = session
  const scopeStore = options.scopeStore ?? createMemorySessionScopeStore()
  const archiveStore = options.archiveStore ?? createMemoryConversationArchiveStore()
  const server = options.server ?? { online: true, entries: [A, B, C, D].map((connectionKey, index) => ({
    ...config, connectionKey, sessionId: uuid(index + 1), state: 'authorized',
    connectionName: `UNVERIFIED_ALIAS_${index}`, device_label: 'UNVERIFIED_DEVICE', principal: { name: 'UNVERIFIED_PRINCIPAL' },
    ...(connectionKey === D ? { clientAppId: 'inventory_app', workspace: 'inventory' } : {}),
    ...(options.oldSdk ? {} : supplied(index === 3 ? 'Distribution project' : `Service team ${index + 1}`)),
  })) }
  const selected = options.keys ?? [A, D]
  let runCount = 10
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: C, connections: structuredClone(server.entries) }),
    status: async ({ connectionKey }) => {
      assert.ok(selected.includes(connectionKey), 'unselected targets must not receive status requests')
      if (!server.online) throw new TypeError('Synthetic network unavailable')
      return structuredClone(server.entries.find((entry) => entry.connectionKey === connectionKey))
    },
    login: async () => structuredClone(server.entries[0]),
    getConversationArchiveCapabilities: async () => ({ schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' }),
    getSystemInfo: async ({ connectionKey, expectedBinding }) => {
      assert.ok(selected.includes(connectionKey))
      const member = server.entries.find((entry) => entry.connectionKey === connectionKey)
      assert.deepEqual(expectedBinding, { hubUrl: member.hubUrl, clientAppId: member.clientAppId, workspace: member.workspace, sessionId: member.sessionId })
      return { schema_version: 'bailing.agent-system-info.v1', binding: { client_app_id: member.clientAppId, workspace: member.workspace, session_id: member.sessionId },
        metadata_status: 'configured', revision: 'description-1',
        system: { name: member.workspace === 'service' ? 'Service operations' : 'Inventory operations', summary: 'Controlled product purpose.', domains: [], boundaries: [] },
        tool_status: 'not_loaded', availability: 'unknown' }
    },
    startTurn: async () => turnResponse({ runId: uuid(++runCount) }),
    syncConversationArchive: async (envelope) => {
      server.remoteSequence = Math.max(server.remoteSequence ?? 0, envelope.events.at(-1)?.sequence ?? 0)
      return { schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: uuid(90), last_sequence: server.remoteSequence }
    },
  })
  createAgentClientPlugin({ transport: mock.transport, scopeStore, archiveStore }).apply(host.ctx, config)
  host.emit('session/created', session)
  t.after(() => host.dispose())
  const runtime = host.services.get('bailingHubAgentClient')
  const emit = (type, data) => {
    const event = session.append(type, data, ['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : undefined)
    host.emit('session/event', session, event)
  }
  return { ...client, host, runtime, mock, selected, server, session, scopeStore, archiveStore, emit }
}

async function begin(f, turn = 1) {
  f.emit('turn/start', { turn })
  const message = userMessage(`u-${turn}`, 'SYNTHETIC_VISIBLE_REQUEST')
  f.emit('user/message', message)
  f.host.emit('agent/inbox/claimed', { agent: f.agent, message, turn })
  return f.host.waterfall('system-prompt/assemble', baseAssembly(), { agent: f.agent, signal: new AbortController().signal }, async () => baseAssembly())
}
function directory(assembly) {
  const text = assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text
  return JSON.parse(text.split('\n').find((line) => line.startsWith('Authorization directory: ')).slice('Authorization directory: '.length))
}
function select(f) { return f.runtime.setSessionScope(f.session.id, { connectionKeys: f.selected }) }
function end(f, turn = 1) { f.emit('turn/end', { turn, reason: { kind: 'completed' } }) }

test('subject display is trimmed, bounded descriptive data with no alias or product-name fallback', () => {
  assert.deepEqual(projectSubjectDisplay(supplied('  Project North  ')), supplied('Project North'))
  assert.equal(projectSubjectDisplay(supplied('界'.repeat(120))).subjectDisplayStatus, 'provided')
  assert.equal(projectSubjectDisplay(supplied('Team 🌟')).subjectDisplay.name, 'Team 🌟')
  for (const name of ['', '  ', 'x'.repeat(121), '\nProject', 'Project\t', 'A\u0085B', 'A\u2028B', 'A\u2029B', '\uD800', '\uDC00']) {
    assert.deepEqual(projectSubjectDisplay(supplied(name)), { subjectDisplay: null, subjectDisplayStatus: 'unavailable', subjectDisplaySource: 'verified' })
  }
  assert.deepEqual(projectSubjectDisplay({ connectionName: 'Alias', principal: { name: 'Principal' }, system: { name: 'Product' } }),
    { subjectDisplay: null, subjectDisplayStatus: 'unsupported', subjectDisplaySource: 'none' })
  assert.deepEqual(projectSubjectDisplay({ ...supplied('Team'), subjectDisplay: { name: 'Team', instructions: 'Never project this field' } }).subjectDisplay, { name: 'Team' })
})

for (const [name, keys, runs] of [['single authorization', [A], 1], ['same system', [A, B], 2], ['cross system', [A, D], 0]]) {
  test(`${name} identifies the business subject separately from system purpose before tool search`, async (t) => {
    const f = fixture(t, { keys }); const scope = await select(f)
    const assembly = await begin(f); const targets = directory(assembly)
    assert.deepEqual(targets.map((entry) => entry.authorization_ref), scope.authorizations.map((entry) => entry.authorizationRef))
    assert.deepEqual(targets.map((entry) => entry.subject_display.name), keys.map((key) => f.server.entries.find((entry) => entry.connectionKey === key).subjectDisplay.name))
    assert.ok(targets.every((entry) => entry.label === entry.subject_display.name && entry.subject_display_status === 'provided' && entry.subject_display_source === 'verified'))
    assert.ok(targets.every((entry) => entry.system_description.name.endsWith('operations') && entry.metadata_status === 'configured'))
    assert.doesNotMatch(JSON.stringify(assembly), /UNVERIFIED_ALIAS|UNVERIFIED_DEVICE|UNVERIFIED_PRINCIPAL|Service team 3|conn_[a-f0-9]{32}/)
    assert.equal(callsFor(f.mock.calls, 'startTurn').length, runs)
    assert.equal(callsFor(f.mock.calls, 'searchCapabilities').length, 0)
    assert.doesNotMatch(JSON.stringify(await f.scopeStore.load(f.session.id)), /subjectDisplay|subject_display/)
  })
}

for (const status of ['missing', 'unsupported', 'unavailable', 'oldSdk']) {
  test(`${status} shows a pending name without granting or blocking original business access`, async (t) => {
    const f = fixture(t, { keys: [A], oldSdk: status === 'oldSdk' })
    if (status !== 'oldSdk') Object.assign(f.server.entries[0], { subjectDisplay: null, subjectDisplayStatus: status })
    const scope = await select(f)
    assert.equal(scope.authorizations[0].label, PENDING_AUTHORIZATION_NAME)
    const target = directory(await begin(f))[0]
    assert.equal(target.label, PENDING_AUTHORIZATION_NAME)
    assert.equal(target.subject_display, null)
    assert.equal(target.subject_display_status, status === 'oldSdk' ? 'unsupported' : status)
    assert.equal(target.system_description.name, 'Service operations')
    assert.ok(f.local.has('employee_update'))
    assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'business')
  })
}

test('authorization lists and login keep connection selectors independent and identify cache-only names', async (t) => {
  const f = fixture(t, { keys: [A, B] })
  for (const entry of f.server.entries) Object.assign(entry, supplied('Duplicated department'), { subjectDisplaySource: 'cache', subjectDisplayCacheStatus: 'saved' })
  const list = await f.runtime.connectionsList()
  assert.equal(list.connections.length, 4)
  assert.equal(new Set(list.connections.map((entry) => entry.connectionKey)).size, 4)
  assert.equal(new Set(list.connections.map((entry) => entry.connectionName)).size, 4)
  assert.ok(list.connections.every((entry) => entry.displayLabel === 'Duplicated department' && entry.subjectDisplaySource === 'cache' && entry.subjectDisplayCacheStatus === 'saved'))
  Object.assign(f.server.entries[0], { subjectDisplaySource: 'verified', subjectDisplayCacheStatus: 'storage_error' })
  const login = await f.runtime.login()
  assert.equal(login.state, 'authorized')
  assert.equal(login.connectionName, 'UNVERIFIED_ALIAS_0')
  assert.equal(login.displayLabel, 'Duplicated department')
  assert.equal(login.subjectDisplayCacheStatus, 'storage_error', 'display cache failure stays auxiliary to successful authorization')
})

test('duplicate subject names and later renames preserve original keys, references and frozen scope revision', async (t) => {
  const f = fixture(t, { keys: [A, B] })
  f.server.entries.slice(0, 2).forEach((entry) => Object.assign(entry, supplied('Operations team')))
  const original = await select(f)
  const first = directory(await begin(f))
  assert.equal(new Set(first.map((entry) => entry.label)).size, 1)
  assert.equal(new Set(first.map((entry) => entry.authorization_ref)).size, 2)
  const snapshot = await f.scopeStore.load(f.session.id)
  end(f); await settle()
  Object.assign(f.server.entries[0], supplied('Renamed team'), { connectionName: 'New local alias' })
  const second = directory(await begin(f, 2))
  assert.equal(second[0].label, 'Renamed team')
  assert.equal(second[1].label, 'Operations team')
  assert.deepEqual(second.map((entry) => entry.authorization_ref), original.authorizations.map((entry) => entry.authorizationRef))
  assert.deepEqual(await f.scopeStore.load(f.session.id), snapshot)
  assert.deepEqual((await f.runtime.getSessionScope(f.session.id)).authorizations.map((entry) => entry.label), ['Operations team', 'Operations team'])
})

test('rename after completion and offline reopen retain the exact original scope, archive, events and ACK', async (t) => {
  const f = fixture(t)
  await select(f); await begin(f); end(f); await settle()
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'synced')
  const originalScope = await f.scopeStore.load(f.session.id)
  const originalArchive = await f.archiveStore.load(f.session.id)
  const originalHistory = structuredClone(f.session.events)
  Object.assign(f.server.entries[0], supplied('Renamed service team'))
  await f.host.dispose()
  f.server.online = false
  const reopened = fixture(t, { scopeStore: f.scopeStore, archiveStore: f.archiveStore, server: f.server, session: Session.create(f.session.id, originalHistory) })
  const reopenedHistory = structuredClone(reopened.session.events)
  assert.deepEqual(reopenedHistory.slice(0, originalHistory.length), originalHistory)
  for (let count = 0; count < 2; count++) {
    assert.equal((await reopened.runtime.restoreSessionScope(reopened.session.id)).mode, 'blocked')
    assert.equal((await reopened.runtime.syncSessionArchive(reopened.session.id)).state, 'blocked')
    assert.deepEqual(await f.scopeStore.load(f.session.id), originalScope)
    assert.deepEqual(await f.archiveStore.load(f.session.id), originalArchive)
  }
  f.server.online = true
  const restored = await reopened.runtime.restoreSessionScope(reopened.session.id)
  assert.equal(restored.mode, 'business')
  assert.equal(restored.authorizations[0].subjectDisplay.name, 'Renamed service team')
  assert.equal(restored.authorizations[0].label, originalScope.authorizations[0].label)
  assert.deepEqual(await f.archiveStore.load(f.session.id), originalArchive, 'display refresh alone cannot write archive state')
  assert.equal((await reopened.runtime.syncSessionArchive(reopened.session.id)).state, 'synced')
  assert.deepEqual(await f.scopeStore.load(f.session.id), originalScope)
  // The unchanged outbox protocol persists a new ACK with the next CAS revision.
  // Display refresh does not reset that revision or rewrite historical payloads.
  assert.deepEqual(await f.archiveStore.load(f.session.id), { ...originalArchive, revision: originalArchive.revision + 1 })
  assert.deepEqual(reopened.session.events, reopenedHistory, 'scope/display restore does not append Session events')
  for (const method of ['startTurn', 'invoke', 'resume', 'completeRun']) assert.equal(callsFor(reopened.mock.calls, method).length, 0)
})

test('old saved labels remain historical and never masquerade as business-provided names on restore', async (t) => {
  const f = fixture(t, { keys: [A], oldSdk: true }); await select(f); await begin(f); end(f); await settle()
  const snapshot = await f.scopeStore.load(f.session.id)
  await f.host.dispose()
  const legacy = { ...snapshot, revision: snapshot.revision + 1, authorizations: snapshot.authorizations.map((entry) => ({ ...entry, label: 'Historical local alias' })) }
  await f.scopeStore.save(f.session.id, legacy, snapshot.revision)
  const reopened = fixture(t, { keys: [A], oldSdk: true, server: f.server, scopeStore: f.scopeStore, session: Session.create(f.session.id, f.session.events) })
  const restored = await reopened.runtime.restoreSessionScope(reopened.session.id)
  assert.equal(restored.authorizations[0].label, 'Historical local alias')
  assert.equal(restored.authorizations[0].subjectDisplayStatus, 'unsupported')
  const target = directory(await begin(reopened, 2))[0]
  assert.equal(target.label, PENDING_AUTHORIZATION_NAME)
  assert.equal(target.subject_display, null)
  assert.deepEqual(await f.scopeStore.load(f.session.id), legacy)
})
