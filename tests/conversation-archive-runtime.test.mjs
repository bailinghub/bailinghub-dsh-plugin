import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin, createFileConversationArchiveStore, createMemoryConversationArchiveStore } from '../lib/index.js'
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
  const reopened = fixture({ session: Session.create(f.session.id, f.session.events), scopeStore: f.scopeStore, archiveStore: disk })
  t.after(() => reopened.host.dispose())
  const status = await reopened.runtime.getSessionArchiveStatus(reopened.session.id)
  assert.equal(status.state, 'recovery_gap')
  assert.equal(status.coverage, 'incomplete')
  assert.equal(status.missingVisibleEvents, 2)
  assert.equal(callsFor(reopened.mock.calls, 'startTurn').length, 0)
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
