import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  baseAssembly,
  callsFor,
  createMemorySessionScopeStore,
  createMockAgent,
  createMockHost,
  createMockTransport,
  userMessage,
} from './helpers/mock-host.mjs'

const dshNodeModules = process.env.DSH_NODE_MODULES ?? resolve('node_modules')
const { Session } = await import(pathToFileURL(join(dshNodeModules, '@deepseek-ai/dsh-session/lib/index.js')).href)
const KEY_A = `conn_${'1'.repeat(32)}`
const KEY_B = `conn_${'2'.repeat(32)}`
const config = {
  hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client',
  workspace: 'demo', connectionName: 'Store A',
}

function metadataDraft(id) {
  return Session.create(id, [
    { seq: 0, time: 1, type: 'session/title', data: { title: 'Unsent draft' } },
    { seq: 1, time: 2, type: 'plan/mode', data: { enabled: true } },
  ])
}

function fixtureFor(session, scopeStore = createMemorySessionScopeStore()) {
  const host = createMockHost()
  const client = createMockAgent(`agent-${session.id}`)
  client.agent.session = session
  const sessions = new Map([
    [KEY_A, '123e4567-e89b-42d3-a456-426614179001'],
    [KEY_B, '123e4567-e89b-42d3-a456-426614179002'],
  ])
  const mock = createMockTransport({
    connectionsList: async () => ({
      currentConnectionKey: KEY_A,
      connections: [KEY_A, KEY_B].map((connectionKey, index) => ({
        ...config, connectionKey, connectionName: index ? 'Store B' : 'Store A',
        state: 'authorized', current: index === 0,
      })),
    }),
    status: async ({ connectionKey }) => {
      assert.ok(sessions.has(connectionKey), 'status must inspect a selected registry identity')
      return {
        state: 'authorized', connectionKey, workspace: config.workspace,
        sessionId: sessions.get(connectionKey),
      }
    },
  })
  createAgentClientPlugin({ transport: mock.transport, scopeStore }).apply(host.ctx, config)
  const runtime = host.services.get('bailingHubAgentClient')
  host.emit('session/created', session)
  return { ...client, host, mock, runtime, session, scopeStore }
}

async function appendAndAssemble(fixture, turn) {
  const { session, host, agent } = fixture
  const message = userMessage(`live-user-${turn}`, 'Query the explicitly selected store.')
  const start = session.append('turn/start', { turn })
  host.emit('session/event', session, start)
  const user = session.append('user/message', message, { surfaceOp: 'append' })
  host.emit('session/event', session, user)
  host.emit('agent/inbox/claimed', { agent, message, turn })
  return host.waterfall('system-prompt/assemble', baseAssembly(),
    { agent, signal: new AbortController().signal }, async () => baseAssembly())
}

test('real DSH metadata seed remains a confirmable draft and its first live user turn starts the chosen authorization', async (t) => {
  const fixture = fixtureFor(metadataDraft('real-metadata-draft'))
  t.after(() => fixture.host.dispose())
  assert.equal(fixture.session.firstLiveSeq, 2)
  assert.deepEqual(fixture.session.events.map((event) => event.type), [
    'session/title', 'plan/mode', 'session/end-seed',
  ])

  const restored = await fixture.runtime.restoreSessionScope(fixture.session.id)
  assert.equal(restored.mode, 'blocked')
  assert.equal(restored.locked, false)
  assert.equal(fixture.mock.calls.length, 0)
  const selected = await fixture.runtime.setSessionScope(fixture.session.id, { connectionKeys: [KEY_A] })
  assert.equal(selected.mode, 'business')
  assert.equal(selected.locked, false)

  const assembly = await appendAndAssemble(fixture, 1)
  const started = callsFor(fixture.mock.calls, 'startTurn')
  assert.equal(started.length, 1)
  assert.equal(started[0].args[1].connectionKey, KEY_A)
  assert.ok(assembly.tools.some((tool) => tool.name === 'employee_update'))
  assert.equal(fixture.local.get('employee_update').parameters.properties.authorization_ref, undefined)
  assert.equal((await fixture.scopeStore.load(fixture.session.id)).locked, true)
  assert.ok(fixture.session.events.filter((event) => event.type === 'turn/start' || event.type === 'user/message')
    .every((event) => event.seq >= fixture.session.firstLiveSeq))
})

test('real DSH reopened metadata draft requires confirmation of an unlocked saved selection before its first user turn', async (t) => {
  const scopeStore = createMemorySessionScopeStore()
  const first = fixtureFor(metadataDraft('real-reopened-draft'), scopeStore)
  await first.runtime.setSessionScope(first.session.id, { connectionKeys: [KEY_A] })
  assert.equal((await scopeStore.load(first.session.id)).locked, false)
  await first.host.dispose()

  const reopenedSession = Session.create(first.session.id, first.session.events)
  const reopened = fixtureFor(reopenedSession, scopeStore)
  t.after(() => reopened.host.dispose())
  assert.ok(reopenedSession.firstLiveSeq > 0)
  const restored = await reopened.runtime.restoreSessionScope(reopenedSession.id)
  assert.equal(restored.mode, 'blocked')
  assert.equal(restored.locked, false)
  assert.equal(reopened.mock.calls.length, 0)

  await reopened.runtime.setSessionScope(reopenedSession.id, { connectionKeys: [KEY_B] })
  await appendAndAssemble(reopened, 1)
  const started = callsFor(reopened.mock.calls, 'startTurn')
  assert.equal(started.length, 1)
  assert.equal(started[0].args[1].connectionKey, KEY_B)
  assert.equal((await scopeStore.load(reopenedSession.id)).authorizations[0].connectionKey, KEY_B)
  assert.equal((await scopeStore.load(reopenedSession.id)).locked, true)
})

test('real DSH reopened started history without a saved scope cannot acquire authorizations or send another user turn', async (t) => {
  const previous = metadataDraft('real-started-missing-scope')
  previous.append('turn/start', { turn: 1 })
  previous.append('user/message', userMessage('previous-user', 'A prior conversation request.'), { surfaceOp: 'append' })
  previous.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const reopenedSession = Session.create(previous.id, previous.events)
  const fixture = fixtureFor(reopenedSession)
  t.after(() => fixture.host.dispose())
  assert.ok(reopenedSession.events.some((event) =>
    event.seq < reopenedSession.firstLiveSeq && event.type === 'user/message'))

  const restored = await fixture.runtime.restoreSessionScope(reopenedSession.id)
  assert.equal(restored.mode, 'blocked')
  assert.equal(restored.locked, true)
  await assert.rejects(() => fixture.runtime.setSessionScope(reopenedSession.id, { connectionKeys: [KEY_A] }),
    { code: 'SESSION_SCOPE_LOCKED' })
  const assembly = await appendAndAssemble(fixture, 2)
  assert.equal(fixture.mock.calls.length, 0)
  assert.equal(assembly.tools.some((tool) => tool.name === 'employee_update'), false)
  assert.match(assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
    /session scope unavailable/)
})
