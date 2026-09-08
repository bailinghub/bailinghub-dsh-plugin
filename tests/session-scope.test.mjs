import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClientPlugin } from '../lib/index.js'
import { createMemorySessionScopeStore } from '../lib/session-scope-store.js'
import {
  activeTool, baseAssembly, callsFor, createMockAgent, createMockHost,
  createMockTransport, turnResponse, userMessage,
} from './helpers/mock-host.mjs'

const KEY_A = `conn_${'a'.repeat(32)}`
const KEY_B = `conn_${'b'.repeat(32)}`
const KEY_C = `conn_${'c'.repeat(32)}`
const BUSINESS_METHODS = new Set(['startTurn', 'searchCapabilities', 'invoke', 'resume', 'completeRun'])
const AUTHORIZATION_METHODS = new Set(['status', ...BUSINESS_METHODS])
const config = {
  hubUrl: 'https://default.example.com', clientAppId: 'default_client',
  workspace: 'default', connectionName: 'Store C',
}

function connection(key, label, overrides = {}) {
  return {
    connectionKey: key, connectionName: label,
    hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo',
    state: 'authorized', current: key === KEY_C, ...overrides,
  }
}

function backend() {
  return {
    entries: [connection(KEY_A, 'Store A'), connection(KEY_B, 'Store B'), connection(KEY_C, 'Store C', config)],
    sessions: new Map([
      [KEY_A, '123e4567-e89b-42d3-a456-426614179001'],
      [KEY_B, '123e4567-e89b-42d3-a456-426614179002'],
      [KEY_C, '123e4567-e89b-42d3-a456-426614179003'],
    ]),
    states: new Map([[KEY_A, 'authorized'], [KEY_B, 'authorized'], [KEY_C, 'authorized']]),
    runs: new Map(), invocations: new Map(), nextRun: 0, pending: false,
  }
}

function metadataFor(call) {
  if (call.method === 'status') return call.args[0]
  return call.args[call.method === 'resume' || call.method === 'completeRun' ? 2 : 1]
}

function scopedCalls(fixture) {
  return fixture.calls.filter((call) => AUTHORIZATION_METHODS.has(call.method))
}

function assertOnlyAuthorizations(fixture, allowed) {
  for (const call of scopedCalls(fixture)) {
    const metadata = metadataFor(call)
    assert.ok(allowed.includes(metadata?.connectionKey), `${call.method} used an unselected or implicit connection`)
    if (call.method !== 'status') assert.equal(metadata.workspace, 'demo')
  }
  assert.equal(fixture.calls.some((call) => call.method === 'connectionsUse'), false)
}

function noBusinessCalls(fixture) {
  assert.deepEqual(fixture.calls.filter((call) => BUSINESS_METHODS.has(call.method)), [])
}

function createFixture(options = {}) {
  const server = options.server ?? backend()
  const scopeStore = options.scopeStore ?? createMemorySessionScopeStore()
  const host = createMockHost()
  const client = createMockAgent(options.id ?? 'scope-conversation')
  const requireConnection = (metadata) => {
    const key = metadata?.connectionKey
    assert.ok([KEY_A, KEY_B, KEY_C].includes(key), 'the SDK must receive an explicit captured connectionKey')
    const entry = server.entries.find((item) => item.connectionKey === key)
    assert.ok(entry, 'the requested authorization must still exist')
    assert.equal(metadata.workspace, entry.workspace)
    return key
  }
  const invocationResult = (input, state = 'executed') => ({
    schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocationId,
    route: 'demo', tool: input.tool ?? 'employee_update', state, ok: state === 'executed',
    auto_retry_allowed: false, text: state === 'executed' ? 'Scope-selected result.' : 'Approval pending.',
  })
  const mock = createMockTransport({
    connectionsList: async () => ({ currentConnectionKey: KEY_C, connections: structuredClone(server.entries) }),
    status: async (metadata) => {
      const key = metadata?.connectionKey
      assert.ok([KEY_A, KEY_B, KEY_C].includes(key), 'status must inspect a specific authorization')
      await options.beforeStatus?.(key)
      const entry = server.entries.find((item) => item.connectionKey === key)
      if (!entry) throw new Error('The selected connection no longer exists')
      return {
        state: server.states.get(key), connectionKey: key, workspace: entry.workspace,
        sessionId: server.sessions.get(key), onBehalfOf: `test-subject-${key.slice(-1)}`,
      }
    },
    startTurn: async (input, metadata) => {
      const key = requireConnection(metadata)
      await options.beforeStartTurn?.(key, input)
      server.nextRun += 1
      const runId = `123e4567-e89b-42d3-a456-${String(426614174000 + server.nextRun).padStart(12, '0')}`
      const response = turnResponse({ runId, tools: [activeTool()] })
      response.context.memory = [{ fact: `MEMORY_${key.slice(-1).toUpperCase()}_ONLY` }]
      response.context.knowledge = [{ excerpt: `KNOWLEDGE_${key.slice(-1).toUpperCase()}_ONLY` }]
      server.runs.set(runId, { key, input: structuredClone(input), revision: response.capability_revision })
      return response
    },
    searchCapabilities: async (input, metadata) => {
      const key = requireConnection(metadata)
      assert.equal(server.runs.get(input.runId)?.key, key)
      return {
        schema: 'bailing.agent-capability-search.v1',
        capability_revision: server.runs.get(input.runId).revision, tools: [activeTool()],
      }
    },
    invoke: async (input, metadata) => {
      const key = requireConnection(metadata)
      assert.equal(server.runs.get(input.agentRunId)?.key, key)
      server.invocations.set(input.invocationId, { key, input: structuredClone(input) })
      return invocationResult(input, server.pending ? 'awaiting_approval' : 'executed')
    },
    resume: async (invocationId, _input, metadata) => {
      const key = requireConnection(metadata)
      const original = server.invocations.get(invocationId)
      assert.equal(original?.key, key)
      return invocationResult(original.input, server.pending ? 'awaiting_approval' : 'executed')
    },
    completeRun: async (runId, input, metadata) => {
      const key = requireConnection(metadata)
      assert.equal(server.runs.get(runId)?.key, key)
      return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status }
    },
  })
  createAgentClientPlugin({
    transport: mock.transport, scopeStore,
    recovery: { maxAttempts: 1, maxWaitMilliseconds: 1000, pollIntervalMilliseconds: 1, sleep: async () => {} },
  }).apply(host.ctx, config)
  const runtime = host.services.get('bailingHubAgentClient')
  return { ...client, host, runtime, scopeStore, server, calls: mock.calls, sessionId: String(client.agent.session.id) }
}

function claim(fixture, turn = 1) {
  fixture.host.emit('agent/inbox/claimed', {
    agent: fixture.agent, turn, message: userMessage(`scope-user-${turn}`, 'Use only the selected stores.'),
  })
}

async function assemble(fixture, turn = 1) {
  claim(fixture, turn)
  return fixture.host.waterfall('system-prompt/assemble', baseAssembly(),
    { agent: fixture.agent, signal: new AbortController().signal }, async () => baseAssembly())
}

function exec(fixture, callId) {
  return { agent: fixture.agent, callId, signal: new AbortController().signal }
}

function toolInput(tool, authorizationRef) {
  const arguments_ = { employee_id: '42' }
  return tool.parameters.properties.authorization_ref
    ? { authorization_ref: authorizationRef, arguments: arguments_ }
    : arguments_
}

function resultBody(result) {
  return result.result ?? result
}

async function finish(fixture, turn = 1, expected = 1) {
  fixture.host.emit('session/event', fixture.agent.session, {
    type: 'assistant/message', data: { turn, message: {
      id: `scope-answer-${turn}`, role: 'assistant', source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'Selected-store operations completed.' }],
    } },
  })
  fixture.host.emit('session/event', fixture.agent.session, {
    type: 'turn/end', data: { turn, reason: { kind: 'completed' } },
  })
  await waitFor(() => callsFor(fixture.calls, 'completeRun').length === expected)
}

async function waitFor(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the scope operation')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function assertScope(view, fixture, keys, state = 'ready', mode = keys.length ? 'business' : 'chat') {
  assert.equal(view.schema, 'bailing.agent-session-scope.v1')
  assert.equal(view.sessionId, fixture.sessionId)
  assert.equal(view.state, state)
  assert.equal(view.mode, mode)
  assert.deepEqual(view.authorizations.map((item) => item.connectionKey).sort(), [...keys].sort())
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('an unselected conversation remains ordinary chat without any SDK call', async () => {
  const fixture = createFixture()
  const view = await fixture.runtime.getSessionScope(fixture.sessionId)
  assertScope(view, fixture, [], 'unselected', 'chat')
  const assembly = await assemble(fixture)
  assert.equal(fixture.local.size, 0)
  assert.doesNotMatch(JSON.stringify(assembly), /MEMORY_[ABC]_ONLY|KNOWLEDGE_[ABC]_ONLY/)
  assert.deepEqual(fixture.calls, [])
})

test('an explicit empty scope is saved as chat and never calls the SDK', async () => {
  const fixture = createFixture()
  const view = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [], expectedRevision: null })
  assertScope(view, fixture, [])
  await assemble(fixture)
  const locked = await fixture.runtime.getSessionScope(fixture.sessionId)
  assertScope(locked, fixture, [])
  assert.equal(locked.locked, true)
  assert.deepEqual(fixture.calls, [])
})

test('a conversation that already began as ordinary chat cannot silently acquire a business scope', async () => {
  const fixture = createFixture()
  await assemble(fixture)
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] }))
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).locked, true)
  assert.deepEqual(fixture.calls, [])
})

test('a single selected A owns every lifecycle call despite an unrelated default C', async () => {
  const fixture = createFixture()
  const selected = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
  assertScope(selected, fixture, [KEY_A])
  const assembly = await assemble(fixture)
  assert.doesNotMatch(JSON.stringify(assembly), /MEMORY_[BC]_ONLY|KNOWLEDGE_[BC]_ONLY/)
  const reference = selected.authorizations[0].authorizationRef
  fixture.server.pending = true
  const tool = fixture.local.get('employee_update')
  assert.deepEqual(tool.parameters, activeTool().input_schema)
  assert.equal(tool.parameters.properties.authorization_ref, undefined)
  const pending = await tool.execute(toolInput(tool, reference), exec(fixture, 'scope-write-a'))
  assert.equal(pending.authorization_ref, undefined)
  assert.equal(pending.result, undefined)
  fixture.server.pending = false
  const resumed = await fixture.local.get('resume_governed_tool_invocation').execute(
    { invocation_id: resultBody(pending).invocation_id }, exec(fixture, 'scope-resume-a'),
  )
  assert.equal(resultBody(resumed).state, 'executed')
  await fixture.local.get('search_business_capabilities').execute({ query: 'employee' }, exec(fixture, 'scope-search-a'))
  await finish(fixture)
  for (const method of AUTHORIZATION_METHODS) assert.ok(callsFor(fixture.calls, method).length > 0, `missing ${method}`)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('A and B are the complete scope for context, search, calls, recovery and completion', async () => {
  const fixture = createFixture()
  const selected = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A, KEY_B] })
  assertScope(selected, fixture, [KEY_A, KEY_B])
  const assembly = await assemble(fixture)
  assert.doesNotMatch(JSON.stringify(assembly), /MEMORY_C_ONLY|KNOWLEDGE_C_ONLY/)
  for (const authorization of selected.authorizations) {
    const tool = fixture.local.get('employee_update')
    assert.ok(tool.parameters.properties.authorization_ref)
    fixture.server.pending = true
    const pending = await tool.execute(toolInput(tool, authorization.authorizationRef), exec(fixture, authorization.connectionKey))
    fixture.server.pending = false
    await fixture.local.get('resume_governed_tool_invocation').execute(
      { invocation_id: resultBody(pending).invocation_id }, exec(fixture, `resume-${authorization.connectionKey}`),
    )
  }
  await fixture.local.get('search_business_capabilities').execute({ query: 'employee' }, exec(fixture, 'scope-search-both'))
  await finish(fixture, 1, 2)
  for (const method of AUTHORIZATION_METHODS) {
    assert.deepEqual(new Set(callsFor(fixture.calls, method).map((call) => metadataFor(call).connectionKey)), new Set([KEY_A, KEY_B]))
  }
  assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
})

test('the first user claim freezes selection before prompt assembly starts', async () => {
  const fixture = createFixture()
  const selected = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
  claim(fixture)
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [KEY_B], expectedRevision: selected.revision,
  }))
  assert.equal(callsFor(fixture.calls, 'startTurn').length, 0)
  assertOnlyAuthorizations(fixture, [KEY_A])
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).locked, true)
})

test('a revoked selected B blocks the whole scope before any user input reaches A', async () => {
  const fixture = createFixture()
  await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A, KEY_B] })
  fixture.server.states.set(KEY_B, 'logged_out')
  const assembly = await assemble(fixture)
  assert.equal(fixture.local.size, 0)
  assert.doesNotMatch(JSON.stringify(assembly), /MEMORY_[ABC]_ONLY|KNOWLEDGE_[ABC]_ONLY/)
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).mode, 'blocked')
  noBusinessCalls(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
})

test('invalid selection never retains or falls back to the earlier successful scope', async () => {
  const fixture = createFixture()
  const initial = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [`conn_${'f'.repeat(32)}`], expectedRevision: initial.revision,
  }))
  const view = await fixture.runtime.getSessionScope(fixture.sessionId)
  assert.equal(view.state, 'needs_selection')
  assert.equal(view.mode, 'blocked')
  await assemble(fixture)
  noBusinessCalls(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('selected entries from different bindings are rejected before any startTurn', async () => {
  const fixture = createFixture()
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A, KEY_C] }))
  await assemble(fixture)
  noBusinessCalls(fixture)
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).mode, 'blocked')
})

test('a missing saved scope restores as needs_selection without inspecting defaults', async () => {
  const fixture = createFixture()
  const view = await fixture.runtime.restoreSessionScope(fixture.sessionId)
  assertScope(view, fixture, [], 'needs_selection', 'blocked')
  await assemble(fixture)
  assert.deepEqual(fixture.calls, [])
})

test('restoring a locked scope keeps exact authorizations and excludes newly added C', async () => {
  const first = createFixture({ id: 'restored-scope' })
  first.server.entries = first.server.entries.filter((entry) => entry.connectionKey !== KEY_C)
  const saved = await first.runtime.setSessionScope(first.sessionId, { connectionKeys: [KEY_A, KEY_B] })
  await assemble(first)
  await finish(first, 1, 2)
  await first.host.dispose()
  first.server.entries.push(connection(KEY_C, 'Store C'))
  const reopened = createFixture({ id: 'restored-scope', scopeStore: first.scopeStore, server: first.server })
  const restored = await reopened.runtime.restoreSessionScope(reopened.sessionId)
  assertScope(restored, reopened, [KEY_A, KEY_B])
  assert.equal(restored.locked, true)
  assert.deepEqual(restored.authorizations.map((item) => item.authorizationRef), saved.authorizations.map((item) => item.authorizationRef))
  await assemble(reopened, 2)
  await finish(reopened, 2, 2)
  assertOnlyAuthorizations(reopened, [KEY_A, KEY_B])
})

test('restoring a changed Session never silently replaces the original authorization', async () => {
  const first = createFixture({ id: 'changed-scope' })
  await first.runtime.setSessionScope(first.sessionId, { connectionKeys: [KEY_A] })
  await assemble(first)
  await finish(first)
  await first.host.dispose()
  first.server.sessions.set(KEY_A, '123e4567-e89b-42d3-a456-426614179099')
  const reopened = createFixture({ id: 'changed-scope', scopeStore: first.scopeStore, server: first.server })
  const restored = await reopened.runtime.restoreSessionScope(reopened.sessionId)
  assert.equal(restored.state, 'needs_selection')
  assert.equal(restored.mode, 'blocked')
  await assemble(reopened, 2)
  noBusinessCalls(reopened)
  assertOnlyAuthorizations(reopened, [KEY_A])
})

test('restoring scope alone cannot recreate or resume an old invocation from conversation text', async () => {
  const first = createFixture({ id: 'scope-without-invocation-state' })
  const scope = await first.runtime.setSessionScope(first.sessionId, { connectionKeys: [KEY_A] })
  await assemble(first)
  first.server.pending = true
  const tool = first.local.get('employee_update')
  const pending = await tool.execute(toolInput(tool, scope.authorizations[0].authorizationRef), exec(first, 'original-pending'))
  const invocationId = resultBody(pending).invocation_id
  await finish(first)
  await first.host.dispose()
  const reopened = createFixture({ id: 'scope-without-invocation-state', scopeStore: first.scopeStore, server: first.server })
  assert.equal((await reopened.runtime.restoreSessionScope(reopened.sessionId)).state, 'ready')
  await assemble(reopened, 2)
  await assert.rejects(reopened.local.get('resume_governed_tool_invocation').execute(
    { invocation_id: invocationId }, exec(reopened, 'unrestored-invocation'),
  ))
  assert.equal(callsFor(reopened.calls, 'resume').length, 0)
  assert.equal(callsFor(reopened.calls, 'invoke').length, 0)
  assertOnlyAuthorizations(reopened, [KEY_A])
})

test('the locked scope is durable and every selected Session is checked before the first startTurn', async () => {
  const scopeStore = createMemorySessionScopeStore()
  const verified = new Set()
  let verifyFirstTurn = false
  let fixture
  fixture = createFixture({
    scopeStore,
    beforeStatus: async (key) => { if (verifyFirstTurn) verified.add(key) },
    beforeStartTurn: async () => {
      assert.equal((await scopeStore.load(fixture.sessionId)).locked, true)
      assert.deepEqual(verified, new Set([KEY_A, KEY_B]))
    },
  })
  await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A, KEY_B] })
  verifyFirstTurn = true
  await assemble(fixture)
  assert.equal(callsFor(fixture.calls, 'startTurn').length, 2)
  assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
})

test('a scope save failure blocks business access rather than retaining the old A selection', async () => {
  const memory = createMemorySessionScopeStore()
  let failSave = false
  const scopeStore = {
    load: (sessionId) => memory.load(sessionId),
    save: async (...args) => {
      if (failSave) throw new Error('Storage unavailable')
      return memory.save(...args)
    },
  }
  const fixture = createFixture({ scopeStore })
  const initial = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
  failSave = true
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [KEY_B], expectedRevision: initial.revision,
  }))
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).state, 'needs_selection')
  await assemble(fixture)
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).mode, 'blocked')
  noBusinessCalls(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
})

test('a failed locked-scope save prevents startTurn even after selection was confirmed', async () => {
  const memory = createMemorySessionScopeStore()
  const fixture = createFixture({ scopeStore: {
    load: (sessionId) => memory.load(sessionId),
    save: async (sessionId, record, expectedRevision) => {
      if (record.locked) throw new Error('Cannot save the locked scope')
      return memory.save(sessionId, record, expectedRevision)
    },
  } })
  await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
  await assemble(fixture)
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).mode, 'blocked')
  noBusinessCalls(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('a first message received during an unfinished set cannot activate the later-saved scope', async () => {
  const memory = createMemorySessionScopeStore()
  const saving = deferred()
  const release = deferred()
  let pauseFirstSave = true
  const fixture = createFixture({ scopeStore: {
    load: (sessionId) => memory.load(sessionId),
    save: async (...args) => {
      if (pauseFirstSave) {
        pauseFirstSave = false
        saving.resolve()
        await release.promise
      }
      return memory.save(...args)
    },
  } })
  const setting = fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
    .then((value) => ({ value }), (error) => ({ error }))
  await saving.promise
  const assembly = assemble(fixture)
  await new Promise((resolve) => setImmediate(resolve))
  noBusinessCalls(fixture)
  release.resolve()
  await Promise.all([setting, assembly])
  const view = await fixture.runtime.getSessionScope(fixture.sessionId)
  assert.equal(view.state, 'needs_selection')
  assert.equal(view.mode, 'blocked')
  assert.equal(view.locked, true)
  noBusinessCalls(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('a stale expectedRevision is rejected and cannot silently restore a prior selection', async () => {
  const fixture = createFixture()
  const first = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A], expectedRevision: null })
  assert.equal(Number.isSafeInteger(first.revision), true)
  const second = await fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [KEY_B], expectedRevision: first.revision,
  })
  assertScope(second, fixture, [KEY_B])
  assert.equal(second.revision > first.revision, true)
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [KEY_A], expectedRevision: first.revision,
  }))
  await assemble(fixture)
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).mode, 'blocked')
  noBusinessCalls(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
})

test('a corrupt saved scope is blocked without consulting any authorization or default', async () => {
  const fixture = createFixture({ scopeStore: {
    load: async (sessionId) => ({
      schema: 'bailing.agent-session-scope.v1', sessionId, revision: 1, state: 'ready', locked: true,
      binding: { hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo' },
      authorizations: [{ connectionKey: KEY_A, sessionId: 'invalid-agent-session', label: 'Store A', workspace: 'demo' }],
    }),
    save: async () => { throw new Error('Corrupt store cannot be repaired automatically') },
  } })
  const restored = await fixture.runtime.restoreSessionScope(fixture.sessionId)
  assert.equal(restored.state, 'needs_selection')
  assert.equal(restored.mode, 'blocked')
  await assemble(fixture)
  assert.deepEqual(fixture.calls, [])
})

test('concurrent prompt assemblies share one scope lock and one selected startTurn', async () => {
  const fixture = createFixture()
  await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
  claim(fixture)
  const prompt = () => fixture.host.waterfall('system-prompt/assemble', baseAssembly(),
    { agent: fixture.agent, signal: new AbortController().signal }, async () => baseAssembly())
  const assemblies = await Promise.all([prompt(), prompt()])
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).state, 'ready')
  assert.equal(callsFor(fixture.calls, 'startTurn').length, 1)
  assert.equal(assemblies.every((assembly) => assembly.tools.some((tool) => tool.name === 'employee_update')), true)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('scope invalidation while status is in flight prevents the subsequent business dispatch', async () => {
  const inspecting = deferred()
  const release = deferred()
  let holdNextAStatus = false
  const fixture = createFixture({ beforeStatus: async (key) => {
    if (key === KEY_A && holdNextAStatus) {
      holdNextAStatus = false
      inspecting.resolve()
      await release.promise
    }
  } })
  const scope = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A, KEY_B] })
  await assemble(fixture)
  holdNextAStatus = true
  const tool = fixture.local.get('employee_update')
  const selectedA = scope.authorizations.find((item) => item.connectionKey === KEY_A)
  const calling = tool.execute(toolInput(tool, selectedA.authorizationRef), exec(fixture, 'scope-invalidated-during-status'))
    .then((value) => ({ value }), (error) => ({ error }))
  await inspecting.promise
  fixture.server.states.set(KEY_B, 'logged_out')
  assert.equal((await fixture.runtime.restoreSessionScope(fixture.sessionId)).mode, 'blocked')
  release.resolve()
  const outcome = await calling
  assert.ok(outcome.error, 'an invalidated scope must not dispatch after its earlier status check finishes')
  assert.equal(callsFor(fixture.calls, 'invoke').length, 0)
  assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
})

test('native scope get and none commands keep ordinary chat completely outside the SDK', async () => {
  const fixture = createFixture()
  const command = (rawInput) => fixture.host.commands.get('bailinghub').handler({ rawInput, agent: fixture.agent })
  const initial = await command('scope get')
  assert.equal(initial.kind, 'success')
  assertScope(JSON.parse(initial.text), fixture, [], 'unselected', 'chat')
  const cleared = await command('scope none')
  assert.equal(cleared.kind, 'success')
  assertScope(JSON.parse(cleared.text), fixture, [])
  await assemble(fixture)
  const current = await command('scope get')
  assert.equal(current.kind, 'success')
  assert.equal(JSON.parse(current.text).locked, true)
  assert.deepEqual(fixture.calls, [])
})

test('native scope selection freezes at the first claim without probing the rejected replacement', async () => {
  const fixture = createFixture()
  const command = (rawInput) => fixture.host.commands.get('bailinghub').handler({ rawInput, agent: fixture.agent })
  const selected = await command(`scope set ${KEY_A}`)
  assert.equal(selected.kind, 'success')
  assertScope(JSON.parse(selected.text), fixture, [KEY_A])
  claim(fixture)
  const before = fixture.calls.length
  const rejected = await command(`scope set ${KEY_B}`)
  assert.equal(rejected.kind, 'error')
  assert.equal(fixture.calls.length, before)
  const current = await command('scope get')
  assert.equal(current.kind, 'success')
  assertScope(JSON.parse(current.text), fixture, [KEY_A])
  assert.equal(JSON.parse(current.text).locked, true)
  await fixture.host.waterfall('system-prompt/assemble', baseAssembly(),
    { agent: fixture.agent, signal: new AbortController().signal }, async () => baseAssembly())
  await finish(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('native scope commands cannot add authorizations to existing host history before the first assembly', async () => {
  const fixture = createFixture({ id: 'existing-history-before-runtime-state' })
  fixture.agent.session.firstLiveSeq = 8
  const result = await fixture.host.commands.get('bailinghub').handler({
    rawInput: `scope set ${KEY_A}`, agent: fixture.agent,
  })
  assert.equal(result.kind, 'error')
  assert.deepEqual(fixture.calls, [])
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).locked, true)
})

test('setSessionScope snapshots the requested keys before the caller can mutate them', async () => {
  const fixture = createFixture()
  const request = { connectionKeys: [KEY_A], expectedRevision: null }
  const setting = fixture.runtime.setSessionScope(fixture.sessionId, request)
  request.connectionKeys[0] = KEY_B
  const selected = await setting
  assertScope(selected, fixture, [KEY_A])
  assert.equal(request.connectionKeys[0], KEY_B)
  await assemble(fixture)
  const tool = fixture.local.get('employee_update')
  await tool.execute(toolInput(tool, selected.authorizations[0].authorizationRef), exec(fixture, 'snapshotted-a'))
  await finish(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('a valid reselection before the first message recovers from an earlier invalid selection', async () => {
  const fixture = createFixture()
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [`conn_${'f'.repeat(32)}`], expectedRevision: null,
  }))
  const failed = await fixture.runtime.getSessionScope(fixture.sessionId)
  assertScope(failed, fixture, [], 'needs_selection', 'blocked')
  assert.equal(failed.locked, false)
  noBusinessCalls(fixture)

  const selected = await fixture.runtime.setSessionScope(fixture.sessionId, {
    connectionKeys: [KEY_A], expectedRevision: failed.revision,
  })
  assertScope(selected, fixture, [KEY_A])
  assert.equal(selected.locked, false)
  await assemble(fixture)
  const tool = fixture.local.get('employee_update')
  const result = await tool.execute(toolInput(tool, selected.authorizations[0].authorizationRef), exec(fixture, 'reselected-a'))
  assert.equal(resultBody(result).state, 'executed')
  await finish(fixture)
  assertOnlyAuthorizations(fixture, [KEY_A])
})

test('a real DSH user/message event freezes scope from event.data before any inbox claim', async () => {
  const fixture = createFixture({ id: 'user-message-before-claim' })
  fixture.agent.session.firstLiveSeq = 0
  fixture.host.emit('session/event', fixture.agent.session, {
    type: 'user/message', data: userMessage('first-event-message', 'The conversation has already begun.'),
  })
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] }))
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).locked, true)
  assert.deepEqual(fixture.calls, [])
})

test('observed user/message history freezes scope even when firstLiveSeq is zero', async () => {
  const fixture = createFixture({ id: 'observed-user-history' })
  fixture.agent.session.firstLiveSeq = 0
  fixture.agent.session.events = [{
    type: 'user/message', data: userMessage('stored-event-message', 'Existing user history.'),
  }]
  fixture.host.emit('session/created', fixture.agent.session)
  await assert.rejects(fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] }))
  assert.equal((await fixture.runtime.getSessionScope(fixture.sessionId)).locked, true)
  assert.deepEqual(fixture.calls, [])
})

for (const method of ['getSessionScope', 'restoreSessionScope']) {
  test(`a late failing ${method} for A cannot invalidate a newer successful B selection`, async () => {
    const inspecting = deferred()
    const release = deferred()
    let holdNextAStatus = false
    const fixture = createFixture({ beforeStatus: async (key) => {
      if (key === KEY_A && holdNextAStatus) {
        holdNextAStatus = false
        inspecting.resolve()
        await release.promise
        throw new Error('The old A Session check failed after B was selected')
      }
    } })
    const original = await fixture.runtime.setSessionScope(fixture.sessionId, { connectionKeys: [KEY_A] })
    holdNextAStatus = true
    const readingOldScope = fixture.runtime[method](fixture.sessionId)
    await inspecting.promise
    const replacement = await fixture.runtime.setSessionScope(fixture.sessionId, {
      connectionKeys: [KEY_B], expectedRevision: original.revision,
    })
    assertScope(replacement, fixture, [KEY_B])
    const beforeLateFailure = fixture.calls.length
    release.resolve()
    const lateResult = await readingOldScope
    assertScope(lateResult, fixture, [KEY_B])
    assert.equal(lateResult.revision, replacement.revision)
    assertScope(await fixture.runtime.getSessionScope(fixture.sessionId), fixture, [KEY_B])

    await assemble(fixture)
    const tool = fixture.local.get('employee_update')
    await tool.execute(toolInput(tool, replacement.authorizations[0].authorizationRef), exec(fixture, `b-after-late-${method}`))
    await finish(fixture)
    assertOnlyAuthorizations({ calls: fixture.calls.slice(beforeLateFailure) }, [KEY_B])
    assertOnlyAuthorizations(fixture, [KEY_A, KEY_B])
  })
}

test('disposing a created session releases its observed reference without a business runtime state', async () => {
  const fixture = createFixture({ id: 'observed-only-session' })
  fixture.host.emit('session/created', fixture.agent.session)
  assert.equal(fixture.runtime.observedSessions.get(fixture.sessionId), fixture.agent.session)
  assert.equal(fixture.runtime.statesBySessionId.has(fixture.sessionId), false)
  fixture.host.emit('session/disposed', fixture.agent.session)
  await waitFor(() => !fixture.runtime.observedSessions.has(fixture.sessionId))
  assert.equal(fixture.runtime.statesBySessionId.has(fixture.sessionId), false)
  assert.deepEqual(fixture.calls, [])
})
