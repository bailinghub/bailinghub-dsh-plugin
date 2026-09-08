import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin, createFileConversationArchiveStore, createFileSessionScopeStore, createMemoryConversationArchiveStore } from '../lib/index.js'
import { baseAssembly, callsFor, createMemorySessionScopeStore, createMockAgent, createMockHost, createMockTransport, settle, turnResponse, userMessage } from './helpers/mock-host.mjs'

const dshNodeModules = process.env.DSH_NODE_MODULES ?? resolve('node_modules')
const { Session } = await import(pathToFileURL(join(dshNodeModules, '@deepseek-ai/dsh-session/lib/index.js')).href)
const A = `conn_${'1'.repeat(32)}`
const B = `conn_${'2'.repeat(32)}`
const IDS = new Map([[A, '123e4567-e89b-42d3-a456-426614179001'], [B, '123e4567-e89b-42d3-a456-426614179002']])
const ARCHIVE_ID = '123e4567-e89b-42d3-a456-426614179003'
const config = { hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo', connectionName: 'Store A' }
const acknowledgement = (last_sequence) => ({ schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: ARCHIVE_ID, last_sequence })

function fixture(options = {}) {
  const host = createMockHost()
  const client = createMockAgent('archive-agent')
  client.agent.session = options.session ?? Session.create('archive-session')
  const session = client.agent.session
  const scopeStore = options.scopeStore ?? createMemorySessionScopeStore()
  const archiveStore = options.archiveStore ?? createMemoryConversationArchiveStore()
  let remoteSequence = 0
  const mock = createMockTransport({
    connectionsList: async () => ({ connections: [A, B].map((connectionKey, index) => ({ ...config, connectionKey, connectionName: index ? 'Store B' : 'Store A', state: 'authorized' })) }),
    status: async ({ connectionKey }) => ({ state: 'authorized', connectionKey, workspace: 'demo', sessionId: IDS.get(connectionKey) }),
    ...(options.oldSdk ? {} : { syncConversationArchive: async (envelope) => {
      remoteSequence = Math.max(remoteSequence, envelope.events.at(-1)?.sequence ?? 0)
      return acknowledgement(remoteSequence)
    } }),
    ...options.transport,
  })
  createAgentClientPlugin({ transport: mock.transport, scopeStore, archiveStore }).apply(host.ctx, config)
  const runtime = host.services.get('bailingHubAgentClient')
  host.emit('session/created', session)
  const emit = (type, data) => {
    const event = session.append(type, data, ['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : undefined)
    host.emit('session/event', session, event)
    return event
  }
  return { host, ...client, session, scopeStore, archiveStore, mock, runtime, emit }
}

async function begin(f, keys = [A, B], turn = 1) {
  if (turn === 1) await f.runtime.setSessionScope(f.session.id, { connectionKeys: keys })
  f.emit('turn/start', { turn })
  const message = userMessage(`u-${turn}`, 'Compare the authorized stores and update the requested employee.')
  f.emit('user/message', message)
  f.host.emit('agent/inbox/claimed', { agent: f.agent, message, turn })
  return f.host.waterfall('system-prompt/assemble', baseAssembly(), { agent: f.agent, signal: new AbortController().signal }, async () => baseAssembly())
}

function assistant(f, id, text, turn = 1) {
  f.emit('assistant/message', { turn, message: {
    id, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test-model' },
    content: [{ type: 'thinking', text: 'HIDDEN_REASONING_NEVER_ARCHIVE' }, { type: 'text', text }],
  } })
}

test('multi-authorization visible transcript links original runs and keeps combined reply out of per-member summaries', async (t) => {
  const f = fixture()
  t.after(() => f.host.dispose())
  await begin(f)
  assistant(f, 'plan', 'First compare Store A with Store B.')
  f.emit('assistant/chunk', { turn: 1, text: 'HIDDEN_CHUNK_NEVER_ARCHIVE' })
  const tool = f.local.get('employee_update')
  const reference = tool.parameters.properties.authorization_ref.enum[1]
  await tool.execute({ authorization_ref: reference, arguments: { employee_id: 'synthetic-employee' } }, {
    agent: f.agent, callId: 'archive-call', signal: new AbortController().signal,
  })
  assistant(f, 'result', 'Store A is unchanged. Store B employee was updated.')
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  const status = await f.runtime.syncSessionArchive(f.session.id)
  assert.equal(status.state, 'synced')
  assert.equal(status.coverage, 'available_host_history_checked')
  const record = await f.archiveStore.load(f.session.id)
  const events = record.events.map((item) => item.event)
  assert.deepEqual(events.map((event) => event.kind), ['turn_start', 'user_message', 'run_link', 'run_link', 'assistant_message', 'assistant_message', 'turn_end'])
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7])
  const starts = callsFor(f.mock.calls, 'startTurn')
  assert.ok(starts.every((call) => call.args[0].clientConversationId === record.context.clientConversationId))
  assert.ok(events.every((event) => event.client_turn_id === starts[0].args[0].clientTurnId))
  assert.deepEqual(events.filter((event) => event.kind === 'run_link').map((event) => event.member_session_id), [...IDS.values()])
  const completions = callsFor(f.mock.calls, 'completeRun')
  assert.equal(completions.length, 2)
  assert.ok(completions.every((call) => !call.args[1].content.includes('Store A is unchanged.')))
  const uploaded = JSON.stringify(callsFor(f.mock.calls, 'syncConversationArchive'))
  assert.equal(uploaded.includes('HIDDEN_REASONING'), false)
  assert.equal(uploaded.includes('HIDDEN_CHUNK'), false)
  assert.equal(uploaded.includes('not-exposed'), false)
})

test('empty scope makes no Hub or archive-store calls, while an old SDK keeps business tools and explicit unsupported status', async (t) => {
  let storageCalls = 0
  const unavailable = { load: async () => { storageCalls++; throw new Error('unexpected storage access') }, save: async () => { storageCalls++; throw new Error('unexpected storage access') } }
  const empty = fixture({ archiveStore: unavailable })
  t.after(() => empty.host.dispose())
  await begin(empty, [])
  assistant(empty, 'ordinary', 'Ordinary chat stays local.')
  empty.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await empty.runtime.syncSessionArchive(empty.session.id)).state, 'inactive')
  assert.equal(empty.mock.calls.length, 0)
  assert.equal(storageCalls, 0)
  const old = fixture({ archiveStore: unavailable, oldSdk: true })
  t.after(() => old.host.dispose())
  await begin(old, [A])
  assert.ok(old.local.has('employee_update'))
  assert.equal((await old.runtime.getSessionArchiveStatus(old.session.id)).state, 'unsupported')
  assert.equal(storageCalls, 0)
})

test('file-backed archive retries after restart without starting or replaying business calls', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-runtime-archive-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const f = fixture({
    archiveStore: createFileConversationArchiveStore({ directory }),
    transport: { syncConversationArchive: async () => { throw new Error('synthetic network failure') } },
  })
  await begin(f, [A])
  assistant(f, 'final', 'Done with the selected store.')
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'pending')
  const saved = await f.archiveStore.load(f.session.id)
  await f.host.dispose()
  const reopened = fixture({
    session: Session.create(f.session.id, f.session.events), scopeStore: f.scopeStore,
    archiveStore: createFileConversationArchiveStore({ directory }),
  })
  t.after(() => reopened.host.dispose())
  assert.equal((await reopened.runtime.syncSessionArchive(reopened.session.id)).state, 'synced')
  for (const method of ['startTurn', 'invoke', 'resume', 'completeRun']) assert.equal(callsFor(reopened.mock.calls, method).length, 0)
  assert.equal(callsFor(reopened.mock.calls, 'syncConversationArchive')[0].args[0].clientArchiveId, saved.clientArchiveId)
  assert.deepEqual(callsFor(reopened.mock.calls, 'syncConversationArchive')[0].args[0].events, saved.events.map((item) => item.event))
})

test('missing persisted visible text and turn_end are reported as recovery_gap after reopening real DSH history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-archive-gap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const disk = createFileConversationArchiveStore({ directory })
  let failSave = false
  const f = fixture({ archiveStore: { load: disk.load, save: (...args) => failSave ? Promise.reject(new Error('disk full')) : disk.save(...args) } })
  await begin(f, [A])
  await f.runtime.syncSessionArchive(f.session.id)
  failSave = true
  assistant(f, 'missing', 'This durable DSH answer could not enter the outbox.')
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  await f.host.dispose()
  let online = false
  const reopened = fixture({
    session: Session.create(f.session.id, f.session.events), scopeStore: f.scopeStore, archiveStore: disk,
    transport: { status: async ({ connectionKey }) => {
      if (!online) throw networkFailure()
      return { state: 'authorized', connectionKey, workspace: 'demo', sessionId: IDS.get(connectionKey) }
    } },
  })
  t.after(() => reopened.host.dispose())
  assert.equal((await reopened.runtime.getSessionArchiveStatus(reopened.session.id)).state, 'blocked')
  online = true
  assert.equal((await reopened.runtime.restoreSessionScope(reopened.session.id)).mode, 'business')
  const status = await reopened.runtime.getSessionArchiveStatus(reopened.session.id)
  assert.equal(status.state, 'recovery_gap')
  assert.equal(status.coverage, 'incomplete')
  assert.equal(status.missingVisibleEvents, 2)
  assert.equal(callsFor(reopened.mock.calls, 'startTurn').length, 0)
  online = false
  const temporarilyOffline = await reopened.runtime.getSessionArchiveStatus(reopened.session.id)
  assert.equal(temporarilyOffline.state, 'recovery_gap', 'a known durable history gap must remain visible during an offline scope check')
  assert.equal(temporarilyOffline.missingVisibleEvents, 2)
  online = true
  assert.equal((await reopened.runtime.syncSessionArchive(reopened.session.id)).state, 'recovery_gap')
})

test('a cancelled visible turn accepts its original late run link without losing the end event', async (t) => {
  let release
  let dispatched
  const response = new Promise((resolve) => { release = resolve })
  const ready = new Promise((resolve) => { dispatched = resolve })
  const f = fixture({ transport: { startTurn: async () => { dispatched(); return response } } })
  t.after(() => f.host.dispose())
  const starting = begin(f, [A])
  await ready
  f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle()
  await f.runtime.conversationOutbox.drain(f.session.id)
  assert.equal((await f.archiveStore.load(f.session.id)).events.at(-1).event.kind, 'turn_end')
  release(turnResponse())
  const assembly = await starting
  const status = await f.runtime.syncSessionArchive(f.session.id)
  assert.equal(status.state, 'synced')
  const events = (await f.archiveStore.load(f.session.id)).events.map((item) => item.event)
  assert.deepEqual(events.map((event) => event.kind), ['turn_start', 'user_message', 'turn_end', 'run_link'])
  assert.equal(events.at(-1).client_turn_id, events[0].client_turn_id)
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 1)
  assert.equal(f.local.has('employee_update'), false)
  assert.equal(assembly.tools.some((tool) => tool.name === 'employee_update'), false)
  assert.equal(f.runtime.statesBySessionId.get(f.session.id).runs.get(1).status, 'ended')
})

test('a late cancelled multi-authorization response cannot replace the next active turn or dispatch its remaining member', async (t) => {
  let release
  let dispatched
  let starts = 0
  const response = new Promise((resolve) => { release = resolve })
  const ready = new Promise((resolve) => { dispatched = resolve })
  const f = fixture({ transport: { startTurn: async () => {
    starts += 1
    if (starts === 1) { dispatched(); return response }
    return turnResponse({ runId: `123e4567-e89b-42d3-a456-42661417400${starts}` })
  } } })
  t.after(() => f.host.dispose())
  const first = begin(f, [A, B])
  await ready
  f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await begin(f, [A, B], 2)
  assert.ok(f.local.has('employee_update'))
  release(turnResponse())
  await first
  const state = f.runtime.statesBySessionId.get(f.session.id)
  assert.equal(state.runs.get(1).status, 'ended')
  assert.equal(state.currentRun.turn, 2)
  assert.equal(state.currentRun.status, 'active')
  assert.ok(f.local.has('employee_update'))
  assert.equal(starts, 3)
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'synced')
  const events = (await f.archiveStore.load(f.session.id)).events.map((item) => item.event)
  assert.equal(events.at(-1).kind, 'run_link')
  assert.equal(events.at(-1).client_turn_id, events[0].client_turn_id)
})

test('a second claimed user message and intermediate answers remain separate visible events in the same turn', async (t) => {
  const f = fixture()
  t.after(() => f.host.dispose())
  await begin(f, [A])
  assistant(f, 'plan', 'Preparing the comparison.')
  const second = userMessage('u-followup', 'Only change the employee note.')
  f.emit('user/message', second)
  f.host.emit('agent/inbox/claimed', { agent: f.agent, message: second, turn: 1 })
  assistant(f, 'final', 'Only the requested note changed.')
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  const status = await f.runtime.syncSessionArchive(f.session.id)
  assert.equal(status.state, 'synced')
  assert.equal(status.coverage, 'available_host_history_checked')
  const events = (await f.archiveStore.load(f.session.id)).events.map((item) => item.event)
  assert.equal(events.filter((item) => item.kind === 'user_message').length, 2)
  assert.equal(events.filter((item) => item.kind === 'assistant_message').length, 2)
  assert.equal(callsFor(f.mock.calls, 'startTurn').length, 1)
})

test('candidate activation never claims previously unarchived conversation history as complete', async (t) => {
  const original = fixture({ oldSdk: true })
  await begin(original, [A])
  assistant(original, 'old-final', 'An answer from before archive support.')
  original.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await original.host.dispose()
  const reopened = fixture({ session: Session.create(original.session.id, original.session.events), scopeStore: original.scopeStore })
  t.after(() => reopened.host.dispose())
  const status = await reopened.runtime.getSessionArchiveStatus(reopened.session.id)
  assert.equal(status.state, 'recovery_gap')
  assert.equal(status.missingVisibleEvents, 4)
  assert.equal(callsFor(reopened.mock.calls, 'syncConversationArchive').length, 0)
  assert.equal(callsFor(reopened.mock.calls, 'startTurn').length, 0)
})

function networkFailure() {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('Synthetic loopback connection refused'), { code: 'ECONNREFUSED' }) })
}

async function completedDurableFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-archive-offline-reopen-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const scopeDirectory = join(directory, 'scopes')
  const archiveDirectory = join(directory, 'archives')
  const first = fixture({
    scopeStore: createFileSessionScopeStore({ directory: scopeDirectory }),
    archiveStore: createFileConversationArchiveStore({ directory: archiveDirectory }),
    transport: { syncConversationArchive: async () => { throw networkFailure() } },
  })
  // The test retains both JavaScript runtimes in one process. Track the seed's
  // automatic archive tasks so reopening cannot leave an old writer alive,
  // unlike a real process restart. This does not delay or alter business calls.
  const seedArchiveTasks = new Set()
  const synchronize = first.runtime.syncSessionArchive.bind(first.runtime)
  first.runtime.syncSessionArchive = (...args) => {
    const task = synchronize(...args)
    seedArchiveTasks.add(task)
    void task.then(() => seedArchiveTasks.delete(task), () => seedArchiveTasks.delete(task))
    return task
  }
  await begin(first, [A, B])
  const tool = first.local.get('employee_update')
  for (const [index, authorization_ref] of tool.parameters.properties.authorization_ref.enum.entries()) {
    await tool.execute({ authorization_ref, arguments: { employee_id: `synthetic-employee-${index}` } }, {
      agent: first.agent, callId: `offline-seed-call-${index}`, signal: new AbortController().signal,
    })
  }
  assistant(first, 'offline-seed-final', 'Both authorized employee updates have completed.')
  first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  assert.equal((await first.runtime.syncSessionArchive(first.session.id)).state, 'pending')
  assert.equal(callsFor(first.mock.calls, 'startTurn').length, 2)
  assert.equal(callsFor(first.mock.calls, 'invoke').length, 2)
  assert.equal(callsFor(first.mock.calls, 'completeRun').length, 2)
  await first.host.dispose()
  await first.runtime.conversationOutbox.drain(first.session.id)
  while (seedArchiveTasks.size) await Promise.allSettled([...seedArchiveTasks])
  await first.runtime.conversationOutbox.drain(first.session.id)
  const scope = await first.scopeStore.load(first.session.id)
  const archive = await first.archiveStore.load(first.session.id)
  assert.equal(scope.locked, true)
  assert.deepEqual(scope.authorizations.map((item) => item.connectionKey), [A, B])
  assert.equal(archive.acknowledged, 0)
  assert.equal(archive.events.at(-1).event.kind, 'turn_end')
  return { sessionId: first.session.id, history: first.session.events, scopeDirectory, archiveDirectory, scope, archive }
}

function reconnectingFixture(seed) {
  const network = { online: false, revoked: new Set(), loseAcknowledgement: false }
  const remoteEvents = new Map()
  const uploads = []
  const scopeWrites = []
  const archiveWrites = []
  const diskScope = createFileSessionScopeStore({ directory: seed.scopeDirectory })
  const diskArchive = createFileConversationArchiveStore({ directory: seed.archiveDirectory })
  const f = fixture({
    session: Session.create(seed.sessionId, seed.history),
    scopeStore: {
      load: diskScope.load,
      save: async (...args) => { scopeWrites.push(structuredClone(args)); return diskScope.save(...args) },
    },
    archiveStore: {
      load: diskArchive.load,
      save: async (...args) => { archiveWrites.push(structuredClone(args)); return diskArchive.save(...args) },
    },
    transport: {
      status: async ({ connectionKey }) => {
        assert.ok(IDS.has(connectionKey), 'recovery must inspect only an original selected connection')
        if (!network.online) throw networkFailure()
        return {
          state: network.revoked.has(connectionKey) ? 'logged_out' : 'authorized',
          connectionKey, workspace: 'demo', sessionId: IDS.get(connectionKey),
        }
      },
      syncConversationArchive: async (envelope, options) => {
        if (!network.online) throw networkFailure()
        uploads.push(structuredClone({ envelope, options }))
        assert.equal(envelope.clientArchiveId, seed.archive.clientArchiveId)
        assert.equal(envelope.clientConversationId, seed.archive.context.clientConversationId)
        assert.deepEqual(options.members, seed.archive.context.members)
        for (const item of envelope.events) {
          const existing = remoteEvents.get(item.sequence)
          if (existing) assert.deepEqual(item, existing, 'an ambiguous retry must keep its exact event id and payload')
          else remoteEvents.set(item.sequence, structuredClone(item))
        }
        if (network.loseAcknowledgement) {
          network.loseAcknowledgement = false
          throw networkFailure()
        }
        return acknowledgement(Math.max(...remoteEvents.keys(), 0))
      },
    },
  })
  return { ...f, network, remoteEvents, uploads, scopeWrites, archiveWrites }
}

function assertNoRecoveredBusinessCalls(f) {
  for (const method of ['startTurn', 'invoke', 'resume', 'completeRun']) {
    assert.equal(callsFor(f.mock.calls, method).length, 0, `archive recovery must not replay ${method}`)
  }
}

test('offline reopening can restore the original file-backed scope and archive after reconnecting in the same runtime', async (t) => {
  const seed = await completedDurableFixture(t)
  const reopened = reconnectingFixture(seed)
  t.after(() => reopened.host.dispose())
  const runtime = reopened.runtime
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await runtime.restoreSessionScope(seed.sessionId)).mode, 'blocked')
    assert.equal((await runtime.getSessionScope(seed.sessionId)).mode, 'blocked')
    assert.equal((await runtime.getSessionArchiveStatus(seed.sessionId)).state, 'blocked')
    assert.equal((await runtime.syncSessionArchive(seed.sessionId)).state, 'blocked')
    assert.deepEqual(await reopened.scopeStore.load(seed.sessionId), seed.scope)
    assert.deepEqual(await reopened.archiveStore.load(seed.sessionId), seed.archive)
    assertNoRecoveredBusinessCalls(reopened)
  }
  assert.equal(reopened.uploads.length, 0)
  assert.deepEqual(reopened.scopeWrites, [])
  assert.deepEqual(reopened.archiveWrites, [])

  reopened.network.online = true
  const restored = await runtime.restoreSessionScope(seed.sessionId)
  assert.equal(restored.mode, 'business', 'a transient offline inspection must not permanently poison the original locked scope')
  assert.equal(reopened.runtime, runtime)
  assert.equal(restored.locked, true)
  assert.deepEqual(restored.authorizations.map((item) => item.connectionKey), [A, B])
  assert.equal((await runtime.getSessionArchiveStatus(seed.sessionId)).state, 'pending')
  const synchronized = await runtime.syncSessionArchive(seed.sessionId)
  assert.equal(synchronized.state, 'synced')
  assert.equal(synchronized.coverage, 'available_host_history_checked')
  assert.equal(synchronized.acknowledgedSequence, seed.archive.events.length)
  assert.deepEqual(await reopened.scopeStore.load(seed.sessionId), seed.scope)
  const saved = await reopened.archiveStore.load(seed.sessionId)
  assert.equal(saved.clientArchiveId, seed.archive.clientArchiveId)
  assert.deepEqual(saved.context, seed.archive.context)
  assert.deepEqual(saved.events, seed.archive.events)
  assert.equal(saved.acknowledged, saved.events.length)
  assert.equal(saved.revision, seed.archive.revision + 1)
  assert.equal(reopened.archiveWrites.length, 1)
  assert.equal(reopened.archiveWrites[0][2], seed.archive.revision)
  assert.equal(reopened.archiveWrites[0][1].revision, seed.archive.revision + 1)
  assertNoRecoveredBusinessCalls(reopened)
})

test('offline archive recovery remains blocked if either original authorization is revoked during reconnect', async (t) => {
  for (const revoked of [A, B]) await t.test(revoked === A ? 'Store A revoked' : 'Store B revoked', async (t) => {
    const seed = await completedDurableFixture(t)
    const reopened = reconnectingFixture(seed)
    t.after(() => reopened.host.dispose())
    assert.equal((await reopened.runtime.restoreSessionScope(seed.sessionId)).mode, 'blocked')
    const offlineInspections = callsFor(reopened.mock.calls, 'status').length
    reopened.network.online = true
    reopened.network.revoked.add(revoked)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal((await reopened.runtime.restoreSessionScope(seed.sessionId)).mode, 'blocked')
      assert.equal((await reopened.runtime.syncSessionArchive(seed.sessionId)).state, 'blocked')
    }
    assert.ok(callsFor(reopened.mock.calls, 'status').slice(offlineInspections).some((call) => call.args[0].connectionKey === revoked),
      'reconnection must actually inspect the original revoked authorization, not stay blocked because of stale offline state')
    assert.equal(reopened.uploads.length, 0)
    assert.deepEqual(await reopened.scopeStore.load(seed.sessionId), seed.scope)
    assert.deepEqual(await reopened.archiveStore.load(seed.sessionId), seed.archive)
    assert.deepEqual(reopened.scopeWrites, [])
    assert.deepEqual(reopened.archiveWrites, [])
    assertNoRecoveredBusinessCalls(reopened)
  })
})

test('reconnecting archive recovery retries a lost ACK with original events and no duplicate business execution', async (t) => {
  const seed = await completedDurableFixture(t)
  const reopened = reconnectingFixture(seed)
  t.after(() => reopened.host.dispose())
  assert.equal((await reopened.runtime.restoreSessionScope(seed.sessionId)).mode, 'blocked')
  reopened.network.online = true
  assert.equal((await reopened.runtime.restoreSessionScope(seed.sessionId)).mode, 'business')
  reopened.network.loseAcknowledgement = true
  const uncertain = await reopened.runtime.syncSessionArchive(seed.sessionId)
  assert.equal(uncertain.state, 'pending')
  const pending = await reopened.archiveStore.load(seed.sessionId)
  assert.equal(pending.acknowledged, seed.archive.acknowledged)
  assert.deepEqual(pending.events, seed.archive.events)
  assert.equal(pending.clientArchiveId, seed.archive.clientArchiveId)
  assert.equal(reopened.remoteEvents.size, seed.archive.events.length)
  const recovered = await reopened.runtime.syncSessionArchive(seed.sessionId)
  assert.equal(recovered.state, 'synced')
  assert.equal(reopened.uploads.length, 2)
  assert.deepEqual(reopened.uploads[1], reopened.uploads[0])
  assert.equal(reopened.remoteEvents.size, seed.archive.events.length)
  const saved = await reopened.archiveStore.load(seed.sessionId)
  assert.deepEqual(saved.events, seed.archive.events)
  assert.deepEqual(saved.context, seed.archive.context)
  assert.equal(saved.acknowledged, seed.archive.events.length)
  assert.equal(saved.revision, seed.archive.revision + 2)
  assert.deepEqual(reopened.archiveWrites.map(([, record, expected]) => [expected, record.revision]), [
    [seed.archive.revision, seed.archive.revision + 1],
    [seed.archive.revision + 1, seed.archive.revision + 2],
  ])
  assert.deepEqual(await reopened.scopeStore.load(seed.sessionId), seed.scope)
  assertNoRecoveredBusinessCalls(reopened)
})

test('archive sync alone can recheck an offline restored scope and upload its original durable events after reconnection', async (t) => {
  const seed = await completedDurableFixture(t)
  const reopened = reconnectingFixture(seed)
  t.after(() => reopened.host.dispose())
  assert.equal((await reopened.runtime.getSessionArchiveStatus(seed.sessionId)).state, 'blocked')
  assert.equal((await reopened.runtime.syncSessionArchive(seed.sessionId)).state, 'blocked')
  assert.deepEqual(await reopened.scopeStore.load(seed.sessionId), seed.scope)
  reopened.network.online = true
  // No replacement selection or explicit restore call is allowed here: the
  // existing public archive API must retry inspection of its same locked scope.
  assert.equal((await reopened.runtime.syncSessionArchive(seed.sessionId)).state, 'synced')
  assert.equal((await reopened.runtime.getSessionScope(seed.sessionId)).mode, 'business')
  assert.deepEqual(reopened.uploads[0].envelope.events, seed.archive.events.map((item) => item.event))
  assert.deepEqual(await reopened.scopeStore.load(seed.sessionId), seed.scope)
  assert.deepEqual(reopened.scopeWrites, [])
  assertNoRecoveredBusinessCalls(reopened)
})

test('offline scope validation cannot hide existing unsaved archive events or their local storage error', async (t) => {
  const store = createMemoryConversationArchiveStore()
  let failSave = false
  let online = true
  const f = fixture({
    archiveStore: { load: store.load, save: (...args) => failSave ? Promise.reject(new Error('Synthetic disk full')) : store.save(...args) },
    transport: { status: async ({ connectionKey }) => {
      if (!online) throw networkFailure()
      return { state: 'authorized', connectionKey, workspace: 'demo', sessionId: IDS.get(connectionKey) }
    } },
  })
  t.after(() => f.host.dispose())
  await begin(f, [A])
  await f.runtime.syncSessionArchive(f.session.id)
  failSave = true
  assistant(f, 'unsaved-local-answer', 'This visible answer has not been saved locally.')
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  await f.runtime.conversationOutbox.drain(f.session.id)
  const local = f.runtime.conversationOutbox.status(f.session.id)
  assert.equal(local.state, 'storage_error')
  assert.equal(local.unsavedEvents, 2)
  online = false
  for (const inspect of ['getSessionArchiveStatus', 'syncSessionArchive']) {
    const unavailable = await f.runtime[inspect](f.session.id)
    assert.ok(['storage_error', 'recovery_gap'].includes(unavailable.state), `${inspect} must preserve the existing local archive failure`)
    if (unavailable.state === 'recovery_gap') assert.equal(unavailable.syncState, 'storage_error')
    assert.equal(unavailable.unsavedEvents, 2)
  }
})

test('a network-only archive preparation failure is not reported as a local storage error', async (t) => {
  let preparationOnline = true
  const f = fixture({ transport: {
    supportsConversationArchive: async () => {
      if (!preparationOnline) throw networkFailure()
      return true
    },
  } })
  t.after(() => f.host.dispose())
  await begin(f, [A])
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'synced')
  const saved = await f.archiveStore.load(f.session.id)
  preparationOnline = false
  for (const inspect of ['getSessionArchiveStatus', 'syncSessionArchive']) {
    const offline = await f.runtime[inspect](f.session.id)
    assert.notEqual(offline.state, 'storage_error', 'a failed network/capability check does not prove a local write failure')
    assert.deepEqual(await f.archiveStore.load(f.session.id), saved)
  }
  preparationOnline = true
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'synced')
})

test('archive status stays blocked when an original authorization is revoked during asynchronous capability discovery', async (t) => {
  let pauseDiscovery = false
  let revoked = false
  let releaseDiscovery
  let discoveryStarted
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve })
  const started = new Promise((resolve) => { discoveryStarted = resolve })
  const f = fixture({ transport: {
    status: async ({ connectionKey }) => ({
      state: revoked ? 'logged_out' : 'authorized', connectionKey, workspace: 'demo', sessionId: IDS.get(connectionKey),
    }),
    supportsConversationArchive: async () => {
      if (pauseDiscovery) { discoveryStarted(); await discovery }
      return true
    },
  } })
  t.after(() => { releaseDiscovery(); return f.host.dispose() })
  await begin(f, [A])
  assert.equal((await f.runtime.syncSessionArchive(f.session.id)).state, 'synced')
  const saved = await f.archiveStore.load(f.session.id)
  const uploadedBefore = callsFor(f.mock.calls, 'syncConversationArchive').length
  pauseDiscovery = true
  const inspecting = f.runtime.getSessionArchiveStatus(f.session.id)
  await started
  revoked = true
  assert.equal((await f.runtime.restoreSessionScope(f.session.id)).mode, 'blocked')
  releaseDiscovery()
  const status = await inspecting
  assert.equal(status.state, 'blocked', 'a completed capability probe must not supersede confirmed revocation')
  assert.equal((await f.runtime.getSessionScope(f.session.id)).mode, 'blocked')
  assert.equal(callsFor(f.mock.calls, 'syncConversationArchive').length, uploadedBefore)
  assert.deepEqual(await f.archiveStore.load(f.session.id), saved)
})
