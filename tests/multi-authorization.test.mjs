import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClientPlugin } from '../lib/index.js'
import {
  baseAssembly,
  callsFor,
  createMockAgent,
  createMockHost,
  createMemorySessionScopeStore,
  selectSessionScope,
  MOCK_CONNECTION_KEY,
  createMockTransport,
  turnResponse,
  userMessage,
} from './helpers/mock-host.mjs'

const config = {
  hubUrl: 'https://hub.example.com',
  clientAppId: 'dsh_client',
  workspace: 'demo',
  connectionName: 'Store A',
}
const KEY_A = `conn_${'1'.repeat(32)}`
const KEY_B = `conn_${'2'.repeat(32)}`
const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)

function connectionKeyFor(metadata) {
  assert.equal(typeof metadata?.connectionKey, 'string')
  assert.equal(Object.hasOwn(metadata, 'connectionName'), false)
  return metadata.connectionKey
}

function connection(connectionKey, connectionName, overrides = {}) {
  return {
    connectionKey,
    connectionName,
    hubUrl: config.hubUrl,
    clientAppId: config.clientAppId,
    workspace: config.workspace,
    current: connectionKey === KEY_A,
    state: 'authorized',
    ...overrides,
  }
}

function readTool() {
  return {
    name: 'tenant_info',
    description: 'Read the selected store summary.',
    input_schema: {
      type: 'object',
      properties: { detail: { type: 'boolean' } },
      additionalProperties: false,
    },
    scope: 'tenant.info.read',
    risk: 'low',
    approval_required: false,
    readonly: true,
    idempotent: true,
  }
}

function writeTool(idType = 'string') {
  return {
    name: 'employee_update',
    description: 'Update a permitted employee field in the selected store.',
    input_schema: {
      type: 'object',
      properties: { employee_id: { type: idType }, note: { type: 'string' } },
      required: ['employee_id', 'note'],
      additionalProperties: false,
    },
    scope: 'tenant.employee.write',
    risk: 'medium',
    approval_required: true,
    readonly: false,
    idempotent: false,
  }
}

function resultFor(input, state = 'executed', overrides = {}) {
  return {
    schema_version: 'bailing.agent-tool-invocation.v1',
    invocation_id: input.invocationId,
    route: config.workspace,
    tool: input.tool ?? 'employee_update',
    state,
    ok: state === 'executed',
    auto_retry_allowed: false,
    text: state === 'executed' ? 'Operation completed.' : 'Waiting for business approval.',
    ...overrides,
  }
}

async function assemble(host, agent, turn, text = 'Read both stores and update only the requested one.', connectionKeys = [KEY_A, KEY_B]) {
  if (turn === 1) await selectSessionScope(host, agent, connectionKeys)
  host.emit('agent/inbox/claimed', {
    agent,
    turn,
    message: userMessage(`multi-message-${agent.id}-${turn}`, text),
  })
  return host.waterfall(
    'system-prompt/assemble',
    baseAssembly(),
    { agent, signal: new AbortController().signal },
    async () => baseAssembly(),
  )
}

function execution(agent, callId) {
  return { agent, callId, signal: new AbortController().signal }
}

async function waitFor(check) {
  const deadline = Date.now() + 1_500
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for target-scoped completion')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function finishTurn(fixture, turn, text = 'COMBINED_REPLY_WITH_BOTH_STORE_RESULTS') {
  fixture.host.emit('session/event', fixture.agent.session, {
    type: 'assistant/message',
    data: {
      turn,
      message: {
        id: `multi-assistant-${turn}`,
        role: 'assistant',
        source: { provider: 'test', model: 'mock-model' },
        content: [{ type: 'text', text }],
      },
    },
  })
  fixture.host.emit('session/event', fixture.agent.session, {
    type: 'turn/end',
    data: { turn, reason: { kind: 'completed' } },
  })
}

function createFixture(options = {}) {
  const entries = options.connections ?? [
    connection(KEY_A, 'Store A'),
    connection(KEY_B, 'Store B'),
  ]
  let currentKey = KEY_A
  let nextRun = 0
  const runBindings = new Map()
  const invocationBindings = new Map()
  const sessionIds = new Map([
    [KEY_A, '123e4567-e89b-42d3-a456-426614179001'],
    [KEY_B, '123e4567-e89b-42d3-a456-426614179002'],
  ])
  const authorizationStates = new Map([[KEY_A, 'authorized'], [KEY_B, 'authorized']])
  const host = createMockHost()
  const client = createMockAgent(options.agentId ?? 'multi-store')
  const targetFor = (metadata) => {
    // Multi-authorization calls must be pinned to a registry key, never a mutable alias.
    const key = connectionKeyFor(metadata)
    assert.ok([KEY_A, KEY_B].includes(key), `expected a frozen connection key, received ${key}`)
    assert.equal(metadata.workspace, config.workspace)
    return key
  }
  const defaultTools = () => [readTool(), writeTool()]
  const mock = createMockTransport({
    connectionsList: async () => ({
      currentConnectionKey: currentKey,
      connections: structuredClone(entries).map((entry) => ({
        ...entry,
        current: entry.connectionKey === currentKey,
      })),
    }),
    connectionsUse: async (selector) => {
      const selected = entries.find((entry) =>
        entry.connectionKey === selector || entry.connectionName === selector,
      )
      assert.ok(selected)
      currentKey = selected.connectionKey
      return { state: 'selected', connection: { ...selected, current: true } }
    },
    status: async (metadata) => {
      const key = connectionKeyFor(metadata)
      assert.ok([KEY_A, KEY_B].includes(key), 'authorization checks must use a frozen connection key')
      await options.beforeStatus?.(key, metadata)
      return {
        state: authorizationStates.get(key),
        sessionId: sessionIds.get(key),
        workspace: config.workspace,
        connectionKey: key,
        subjectDisplay: { name: key === KEY_A ? 'Store A' : 'Store B' },
        subjectDisplayStatus: 'provided', subjectDisplaySource: 'verified',
      }
    },
    startTurn: async (input, metadata) => {
      const key = targetFor(metadata)
      await options.beforeStartTurn?.(key, input, metadata)
      nextRun += 1
      const runId = `123e4567-e89b-42d3-a456-${String(426614174000 + nextRun).padStart(12, '0')}`
      const response = turnResponse({
        runId,
        profileRevision: (key === KEY_A ? 'c' : 'd').repeat(64),
        capabilityRevision: key === KEY_A ? REVISION_A : REVISION_B,
        tools: (options.toolsFor ?? defaultTools)(key),
      })
      response.context = {
        ...response.context,
        instructions: key === KEY_A ? 'STORE_A_ONLY_INSTRUCTIONS' : 'STORE_B_ONLY_INSTRUCTIONS',
        memory: [{ fact: key === KEY_A ? 'STORE_A_MEMORY' : 'STORE_B_MEMORY' }],
        knowledge: [{ title: 'Reference', excerpt: key === KEY_A ? 'STORE_A_KNOWLEDGE' : 'STORE_B_KNOWLEDGE' }],
      }
      runBindings.set(runId, { key, input: structuredClone(input), response })
      return response
    },
    invoke: async (input, metadata) => {
      const key = targetFor(metadata)
      const run = runBindings.get(input.agentRunId)
      assert.ok(run, 'invocation must use a run created for this target')
      assert.equal(run.key, key)
      assert.equal(input.capabilityRevision, run.response.capability_revision)
      invocationBindings.set(input.invocationId, { key, input: structuredClone(input) })
      return options.invoke
        ? options.invoke(input, metadata, key)
        : resultFor(input, 'executed', { text: key === KEY_A ? 'STORE_A_RESULT' : 'STORE_B_RESULT' })
    },
    searchCapabilities: async (input, metadata) => {
      const key = targetFor(metadata)
      const run = runBindings.get(input.runId)
      assert.equal(run?.key, key)
      const revision = (key === KEY_A ? 'e' : 'f').repeat(64)
      run.response.capability_revision = revision
      return {
        schema: 'bailing.agent-capability-search.v1',
        capability_revision: revision,
        tools: (options.toolsFor ?? defaultTools)(key),
      }
    },
    resume: async (invocationId, input, metadata) => {
      const key = targetFor(metadata)
      const binding = invocationBindings.get(invocationId)
      assert.ok(binding, 'resume must never guess a target for an unknown invocation')
      assert.equal(binding.key, key)
      return options.resume
        ? options.resume(invocationId, input, metadata, key)
        : resultFor(binding.input, 'executed', { text: key === KEY_A ? 'STORE_A_RESULT' : 'STORE_B_RESULT' })
    },
    completeRun: async (runId, payload, metadata) => {
      const key = targetFor(metadata)
      assert.equal(runBindings.get(runId)?.key, key)
      return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: payload.status }
    },
  })
  createAgentClientPlugin({ scopeStore: createMemorySessionScopeStore(),
    transport: mock.transport,
    recovery: {
      pollIntervalMilliseconds: 1,
      maxWaitMilliseconds: 10_000,
      maxAttempts: 2,
      sleep: async () => {},
    },
  }).apply(host.ctx, config)
  return { ...client, host, mock, entries, runBindings, invocationBindings, sessionIds, authorizationStates }
}

async function discoverRefs(fixture, prefix = 'discover') {
  const definition = fixture.local.get('tenant_info')
  assert.ok(definition, 'shared typed read tool must be registered')
  const refs = definition.parameters.properties.authorization_ref?.enum
  assert.ok(Array.isArray(refs), 'typed tool must enumerate its authorized targets')
  assert.equal(refs.length, 2)
  assert.equal(new Set(refs).size, refs.length)
  const byKey = new Map()
  for (const [index, ref] of refs.entries()) {
    assert.match(ref, /^auth_[a-f0-9]+$/)
    const wrapped = await definition.execute(
      { authorization_ref: ref, arguments: { detail: true } },
      execution(fixture.agent, `${prefix}-${index}`),
    )
    const call = callsFor(fixture.mock.calls, 'invoke').at(-1)
    const key = connectionKeyFor(call.args[1])
    assert.equal(wrapped.authorization_ref, ref)
    assert.equal(wrapped.authorization_label, key === KEY_A ? 'Store A' : 'Store B')
    assert.equal(wrapped.result.state, 'executed')
    byKey.set(key, ref)
  }
  assert.deepEqual([...byKey.keys()].sort(), [KEY_A, KEY_B])
  return { a: byKey.get(KEY_A), b: byKey.get(KEY_B) }
}

test('selects only explicit same-binding authorizations and exposes no registry secrets', async () => {
  const fixture = createFixture({ connections: [
    connection(KEY_A, 'Store A', {
      access_token: 'SECRET_ACCESS_A',
      refresh_token: 'SECRET_REFRESH_A',
      password: 'SECRET_PASSWORD_A',
      internalNotes: 'SECRET_REGISTRY_NOTE_A',
      principal: { on_behalf_of: 'PRIVATE_SUBJECT_A' },
    }),
    connection(KEY_B, 'Store B'),
    connection(`conn_${'3'.repeat(32)}`, 'Other Hub', { hubUrl: 'https://other.example.com' }),
    connection(`conn_${'4'.repeat(32)}`, 'Other Client', { clientAppId: 'other_client' }),
    connection(`conn_${'5'.repeat(32)}`, 'Other Route', { workspace: 'other_route' }),
    connection(`conn_${'6'.repeat(32)}`, 'Logged Out', { state: 'logged_out' }),
    connection(`conn_${'7'.repeat(32)}`, 'Expired', { state: 'expired' }),
  ] })
  const assembly = await assemble(fixture.host, fixture.agent, 1)
  await discoverRefs(fixture)
  const visible = JSON.stringify(assembly)
  assert.match(visible, /Store A/)
  assert.match(visible, /Store B/)
  assert.doesNotMatch(visible, /SECRET_|PRIVATE_SUBJECT_A|Other Hub|Other Client|Other Route|Logged Out|Expired/)
  assert.equal(assembly.tools.filter((tool) => tool.name === 'tenant_info').length, 1)
  assert.equal(assembly.tools.filter((tool) => tool.name === 'employee_update').length, 1)
  assert.equal(callsFor(fixture.mock.calls, 'connectionsUse').length, 0)
  assert.deepEqual(
    new Set(callsFor(fixture.mock.calls, 'startTurn').map((call) => connectionKeyFor(call.args[1]))),
    new Set([KEY_A, KEY_B]),
  )
})

test('target memory and knowledge stay in explicitly attributed separate context entries', async () => {
  const fixture = createFixture()
  const assembly = await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  for (const [letter, ref] of [['A', refs.a], ['B', refs.b]]) {
    const ownMarker = new RegExp(`STORE_${letter}_(?:MEMORY|KNOWLEDGE)`)
    const otherMarker = new RegExp(`STORE_${letter === 'A' ? 'B' : 'A'}_(?:MEMORY|KNOWLEDGE)`)
    const entries = assembly.contexts.filter((entry) => ownMarker.test(JSON.stringify(entry)))
    assert.ok(entries.length >= 1, `missing Store ${letter} context`)
    for (const entry of entries) {
      const value = JSON.stringify(entry)
      assert.doesNotMatch(value, otherMarker)
      assert.ok(value.includes(ref), `Store ${letter} context lacks its authorization reference`)
    }
  }
})

test('shared typed tools select separate runs and revisions and unwrap only business arguments', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const write = fixture.local.get('employee_update')
  assert.deepEqual(write.parameters.properties.arguments, writeTool().input_schema)
  assert.equal(write.parameters.additionalProperties, false)
  assert.deepEqual(new Set(write.parameters.required), new Set(['authorization_ref', 'arguments']))
  const arguments_ = { employee_id: '42', note: 'Store A note only' }
  const wrapped = await write.execute(
    { authorization_ref: refs.a, arguments: arguments_ },
    execution(fixture.agent, 'write-a'),
  )
  const writeCall = callsFor(fixture.mock.calls, 'invoke').at(-1)
  assert.equal(connectionKeyFor(writeCall.args[1]), KEY_A)
  assert.equal(writeCall.args[0].capabilityRevision, REVISION_A)
  assert.deepEqual(writeCall.args[0].arguments, arguments_)
  assert.equal(wrapped.authorization_ref, refs.a)
  assert.equal(wrapped.result.text, 'STORE_A_RESULT')
  assert.equal(callsFor(fixture.mock.calls, 'invoke').filter((call) => call.args[0].tool === 'employee_update').length, 1)
})

test('rejects unknown authorization refs and changing the authorization of an existing call id', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const write = fixture.local.get('employee_update')
  const args = { employee_id: '42', note: 'Authorized write' }
  const before = callsFor(fixture.mock.calls, 'invoke').length
  await assert.rejects(() => write.execute(
    { authorization_ref: 'auth_unknown', arguments: args },
    execution(fixture.agent, 'unknown-ref'),
  ))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before)
  const exec = execution(fixture.agent, 'same-call')
  const first = await write.execute({ authorization_ref: refs.a, arguments: args }, exec)
  assert.deepEqual(await write.execute({ authorization_ref: refs.a, arguments: args }, exec), first)
  await assert.rejects(() => write.execute({ authorization_ref: refs.b, arguments: args }, exec))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before + 1)
})

test('a pending A write permits B reads and resumes on A across turns without another write', async () => {
  let approved = false
  const fixture = createFixture({
    invoke: async (input, _metadata, key) => resultFor(
      input,
      input.tool === 'employee_update' && key === KEY_A ? 'awaiting_approval' : 'executed',
      { text: key === KEY_A ? 'STORE_A_RESULT' : 'STORE_B_RESULT' },
    ),
    resume: async (id, _input, _metadata, key) => {
      assert.equal(key, KEY_A)
      return resultFor({ invocationId: id }, approved ? 'executed' : 'awaiting_approval', {
        text: approved ? 'STORE_A_APPROVED_RESULT' : 'Store A approval pending',
      })
    },
  })
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const pending = await fixture.local.get('employee_update').execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Await approval' } },
    execution(fixture.agent, 'pending-a-write'),
  )
  assert.equal(pending.result.state, 'awaiting_approval')
  const invocationId = pending.result.invocation_id
  const originalRun = fixture.invocationBindings.get(invocationId).input.agentRunId
  const b = await fixture.local.get('tenant_info').execute(
    { authorization_ref: refs.b, arguments: {} },
    execution(fixture.agent, 'b-while-a-pending'),
  )
  assert.equal(b.result.text, 'STORE_B_RESULT')
  finishTurn(fixture, 1, 'Store B read finished; Store A still requires approval.')
  await waitFor(() => callsFor(fixture.mock.calls, 'completeRun').length >= 2)
  await assemble(fixture.host, fixture.agent, 2, 'Resume the earlier Store A change.')
  approved = true
  const resumed = await fixture.local.get('resume_governed_tool_invocation').execute(
    { invocation_id: invocationId },
    execution(fixture.agent, 'resume-old-a'),
  )
  assert.equal(resumed.authorization_ref, refs.a)
  assert.equal(resumed.result.state, 'executed')
  assert.equal(resumed.result.invocation_id, invocationId)
  assert.equal(fixture.invocationBindings.get(invocationId).input.agentRunId, originalRun)
  assert.ok(callsFor(fixture.mock.calls, 'resume').every((call) =>
    call.args[0] === invocationId && connectionKeyFor(call.args[2]) === KEY_A,
  ))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').filter((call) => call.args[0].tool === 'employee_update').length, 1)
})

test('resume rejects an invocation unknown to this conversation without probing any target', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const resume = fixture.local.get('resume_governed_tool_invocation')
  assert.ok(resume)
  await assert.rejects(() => resume.execute(
    { invocation_id: 'f'.repeat(64) },
    execution(fixture.agent, 'unknown-invocation'),
  ))
  assert.equal(callsFor(fixture.mock.calls, 'resume').length, 0)
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, 0)
})

test('global current selection and alias reuse cannot retarget a captured authorization ref', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const changed = await fixture.host.commands.get('bailinghub').handler({ rawInput: 'connections use "Store B"' })
  assert.equal(changed.kind, 'success')
  fixture.entries.find((entry) => entry.connectionKey === KEY_A).connectionName = 'Renamed Store A'
  fixture.entries.find((entry) => entry.connectionKey === KEY_B).connectionName = 'Store A'
  await fixture.local.get('employee_update').execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Still belongs to A' } },
    execution(fixture.agent, 'write-after-global-switch'),
  )
  assert.equal(connectionKeyFor(callsFor(fixture.mock.calls, 'invoke').at(-1).args[1]), KEY_A)
})

test('a changed Agent Session behind the same key is rejected instead of reusing the old authorization ref', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const before = callsFor(fixture.mock.calls, 'invoke').length
  fixture.sessionIds.set(KEY_A, '123e4567-e89b-42d3-a456-426614179099')
  await assert.rejects(() => fixture.local.get('employee_update').execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Old identity must not carry over' } },
    execution(fixture.agent, 'changed-session'),
  ))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before)
})

test('revoking A invalidates the full selected scope without silently reducing it to B', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const before = callsFor(fixture.mock.calls, 'invoke').length
  fixture.authorizationStates.set(KEY_A, 'logged_out')
  await assert.rejects(() => fixture.local.get('employee_update').execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Revoked target' } },
    execution(fixture.agent, 'revoked-session'),
  ))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before)
  await assert.rejects(() => fixture.local.get('tenant_info').execute(
    { authorization_ref: refs.b, arguments: {} },
    execution(fixture.agent, 'blocked-b-in-invalid-scope'),
  ), /SESSION_SCOPE_UNAVAILABLE/)
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before)
})

test('capability search updates only the selected target revision and can explicitly search all targets', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  await fixture.local.get('search_business_capabilities').execute(
    { query: 'employee update', authorization_ref: refs.a },
    execution(fixture.agent, 'search-a'),
  )
  const searches = callsFor(fixture.mock.calls, 'searchCapabilities')
  assert.equal(searches.length, 1)
  assert.equal(connectionKeyFor(searches[0].args[1]), KEY_A)
  await fixture.local.get('employee_update').execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Use A search revision' } },
    execution(fixture.agent, 'write-after-a-search'),
  )
  assert.equal(callsFor(fixture.mock.calls, 'invoke').at(-1).args[0].capabilityRevision, 'e'.repeat(64))
  await fixture.local.get('tenant_info').execute(
    { authorization_ref: refs.b, arguments: {} },
    execution(fixture.agent, 'b-retains-revision'),
  )
  assert.equal(callsFor(fixture.mock.calls, 'invoke').at(-1).args[0].capabilityRevision, REVISION_B)
  await fixture.local.get('search_business_capabilities').execute(
    { query: 'store information', limit: 2 },
    execution(fixture.agent, 'search-all'),
  )
  assert.deepEqual(
    new Set(callsFor(fixture.mock.calls, 'searchCapabilities').slice(1).map((call) => connectionKeyFor(call.args[1]))),
    new Set([KEY_A, KEY_B]),
  )
})

test('a capability available only to A cannot be invoked with B authorization', async () => {
  const fixture = createFixture({ toolsFor: (key) => key === KEY_A ? [readTool(), writeTool()] : [readTool()] })
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const write = fixture.local.get('employee_update')
  assert.ok(write)
  assert.deepEqual(write.parameters.properties.authorization_ref.enum, [refs.a])
  const before = callsFor(fixture.mock.calls, 'invoke').length
  await assert.rejects(() => write.execute(
    { authorization_ref: refs.b, arguments: { employee_id: '42', note: 'Not allowed for B' } },
    execution(fixture.agent, 'b-disallowed-write'),
  ))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before)
  await write.execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Allowed for A' } },
    execution(fixture.agent, 'a-allowed-write'),
  )
  assert.equal(connectionKeyFor(callsFor(fixture.mock.calls, 'invoke').at(-1).args[1]), KEY_A)
})

test('same-name incompatible schemas never become an unrestricted shared business tool', async () => {
  const fixture = createFixture({ toolsFor: (key) => [readTool(), writeTool(key === KEY_A ? 'string' : 'integer')] })
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const write = fixture.local.get('employee_update')
  const before = callsFor(fixture.mock.calls, 'invoke').length
  if (write) {
    const allowed = write.parameters.properties.authorization_ref.enum
    assert.ok(!(allowed.includes(refs.a) && allowed.includes(refs.b)), 'incompatible input schemas must not share one envelope schema')
    const excluded = allowed.includes(refs.a) ? refs.b : refs.a
    await assert.rejects(() => write.execute(
      { authorization_ref: excluded, arguments: { employee_id: '42', note: 'Wrong target schema' } },
      execution(fixture.agent, 'incompatible-schema'),
    ))
  }
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, before)
})

test('completion records contain only their own authorization results, never the cross-store reply', async () => {
  const fixture = createFixture()
  await assemble(fixture.host, fixture.agent, 1)
  await discoverRefs(fixture)
  finishTurn(fixture, 1)
  await waitFor(() => callsFor(fixture.mock.calls, 'completeRun').length === 2)
  const completions = callsFor(fixture.mock.calls, 'completeRun')
  for (const call of completions) {
    const key = connectionKeyFor(call.args[2])
    const payload = JSON.stringify(call.args[1])
    assert.match(payload, key === KEY_A ? /STORE_A_RESULT/ : /STORE_B_RESULT/)
    assert.doesNotMatch(payload, key === KEY_A ? /STORE_B_RESULT/ : /STORE_A_RESULT/)
    assert.doesNotMatch(payload, /COMBINED_REPLY_WITH_BOTH_STORE_RESULTS/)
    assert.equal(fixture.runBindings.get(call.args[0]).key, key)
  }
})

test('one authorized connection keeps the existing direct tool schema and result shape', async () => {
  const host = createMockHost()
  const mock = createMockTransport()
  const client = createMockAgent('single-authorization-compatibility')
  createAgentClientPlugin({ scopeStore: createMemorySessionScopeStore(), transport: mock.transport }).apply(host.ctx, { ...config, connectionName: 'personal' })
  await assemble(host, client.agent, 1, 'Update the permitted employee field.', [KEY_A])
  const definition = client.local.get('employee_update')
  assert.ok(definition)
  assert.equal(definition.parameters.properties.authorization_ref, undefined)
  const result = await definition.execute(
    { employee_id: '42' },
    execution(client.agent, 'single-write'),
  )
  assert.equal(result.state, 'executed')
  assert.equal(result.authorization_ref, undefined)
  assert.deepEqual(callsFor(mock.calls, 'invoke')[0].args[0].arguments, { employee_id: '42' })
})

for (const recovery of ['same-call replay', 'explicit resume']) {
  test(`${recovery} retains a pending A invocation after search removes A from the shared tool`, async () => {
    let includeAWrite = true
    let approved = false
    const fixture = createFixture({
      toolsFor: (key) => [readTool(), ...(key === KEY_A && !includeAWrite ? [] : [writeTool()])],
      invoke: async (input, _metadata, key) => resultFor(
        input, input.tool === 'employee_update' ? 'awaiting_approval' : 'executed',
        { text: key === KEY_A ? 'STORE_A_RESULT' : 'STORE_B_RESULT' },
      ),
      resume: async (invocationId, _input, _metadata, key) => {
        assert.equal(key, KEY_A)
        return resultFor({ invocationId }, approved ? 'executed' : 'awaiting_approval')
      },
    })
    await assemble(fixture.host, fixture.agent, 1)
    const refs = await discoverRefs(fixture)
    const input = { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'Original A write' } }
    const exec = execution(fixture.agent, 'durable-a-write')
    const pending = await fixture.local.get('employee_update').execute(input, exec)
    const invocationId = pending.result.invocation_id
    const original = structuredClone(fixture.invocationBindings.get(invocationId))
    assert.equal(pending.result.state, 'awaiting_approval')

    includeAWrite = false
    await fixture.local.get('search_business_capabilities').execute(
      { query: 'Read store', authorization_ref: refs.a }, execution(fixture.agent, 'search-removes-a-write'),
    )
    const currentWrite = fixture.local.get('employee_update')
    assert.deepEqual(currentWrite.parameters.properties.authorization_ref.enum, [refs.b])
    await assert.rejects(() => currentWrite.execute(input, execution(fixture.agent, 'new-a-write-is-disallowed')))

    approved = true
    const result = recovery === 'same-call replay'
      ? await currentWrite.execute(input, exec)
      : await fixture.local.get('resume_governed_tool_invocation').execute(
        { invocation_id: invocationId }, execution(fixture.agent, 'recover-original-a'),
      )
    assert.equal(result.authorization_ref, refs.a)
    assert.equal(result.result.invocation_id, invocationId)
    assert.equal(result.result.state, 'executed')
    assert.deepEqual(fixture.invocationBindings.get(invocationId), original)
    assert.equal(original.input.capabilityRevision, REVISION_A)
    assert.ok(callsFor(fixture.mock.calls, 'resume').every((call) =>
      call.args[0] === invocationId && connectionKeyFor(call.args[2]) === KEY_A,
    ))
    assert.equal(callsFor(fixture.mock.calls, 'invoke').filter((call) => call.args[0].tool === 'employee_update').length, 1)
  })
}

test('authorization status failures redact raw credential errors before they reach a model', async () => {
  let failA = false
  const fixture = createFixture({
    beforeStatus: async (key) => {
      if (key !== KEY_A || !failA) return
      const error = new Error('Authorization: Bearer TOKEN_A_SECRET; refresh_token=REFRESH_A_SECRET')
      error.access_token = 'TOKEN_A_SECRET'
      error.details = { refresh_token: 'REFRESH_A_SECRET' }
      throw error
    },
  })
  await assemble(fixture.host, fixture.agent, 1)
  const refs = await discoverRefs(fixture)
  const invokeCount = callsFor(fixture.mock.calls, 'invoke').length
  failA = true
  await assert.rejects(() => fixture.local.get('employee_update').execute(
    { authorization_ref: refs.a, arguments: { employee_id: '42', note: 'No dispatch on status failure' } },
    execution(fixture.agent, 'status-failure'),
  ), (error) => {
    assert.doesNotMatch(`${String(error)}\n${JSON.stringify(error)}`, /TOKEN_A_SECRET|REFRESH_A_SECRET/)
    return true
  })
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, invokeCount)
  await assert.rejects(() => fixture.local.get('tenant_info').execute(
    { authorization_ref: refs.b, arguments: {} }, execution(fixture.agent, 'b-after-a-status-failure'),
  ), /SESSION_SCOPE_UNAVAILABLE/)
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, invokeCount)
})

test('same-name tools with different governance are excluded from shared declarations', async (t) => {
  for (const [field, changed] of [
    ['scope', 'tenant.employee.admin'], ['risk', 'high'], ['approval_required', false],
    ['readonly', true], ['idempotent', true],
  ]) {
    await t.test(field, async () => {
      const fixture = createFixture({
        toolsFor: (key) => [readTool(), { ...writeTool(), ...(key === KEY_B ? { [field]: changed } : {}) }],
      })
      const assembly = await assemble(fixture.host, fixture.agent, 1)
      assert.equal(fixture.local.has('employee_update'), false)
      assert.equal(assembly.tools.some((tool) => tool.name === 'employee_update'), false)
      assert.ok(fixture.local.has('tenant_info'))
      assert.match(assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
        /Conflicting tool declarations.*employee_update/)
      assert.equal(callsFor(fixture.mock.calls, 'invoke').length, 0)
    })
  }
})

test('the twelve-tool business budget is global across both authorization catalogs', async () => {
  const fixture = createFixture({
    toolsFor: (key) => Array.from({ length: 12 }, (_, index) => ({
      ...readTool(), name: `business_read_${index + (key === KEY_A ? 0 : 6)}`,
    })),
  })
  const assembly = await assemble(fixture.host, fixture.agent, 1)
  const businessTools = () => [...fixture.local.values()].filter((tool) => tool.name.startsWith('business_read_'))
  assert.equal(businessTools().length, 12)
  assert.equal(assembly.tools.filter((tool) => tool.name.startsWith('business_read_')).length, 12)
  assert.equal(new Set(businessTools().map((tool) => tool.name)).size, 12)
  const shared = fixture.local.get('business_read_6')
  assert.equal(shared.parameters.properties.authorization_ref.enum.length, 2)
  assert.match(assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
    /Additional tools omitted by the shared budget: 6/)

  const searchResult = await fixture.local.get('search_business_capabilities').execute(
    { query: 'Other store reads', limit: 12, authorization_ref: shared.parameters.properties.authorization_ref.enum[1] },
    execution(fixture.agent, 'search-with-global-budget'),
  )
  assert.equal(businessTools().length, 12)
  assert.equal(searchResult.active_tools.length, 12)
  assert.equal(searchResult.omitted_tool_count, 6)
})

test('Code Mode degradation still completes both authorization runs at turn end', async () => {
  const fixture = createFixture()
  fixture.agent.toolMode = 'code'
  const assembly = await assemble(fixture.host, fixture.agent, 1)
  assert.equal(fixture.local.size, 0)
  assert.equal(assembly.tools.some((tool) => tool.name === 'employee_update'), false)
  assert.match(assembly.sections.find((section) => section.name === 'bailinghub:agent-client-profile').text,
    /Code Mode is not supported/)
  assert.equal(callsFor(fixture.mock.calls, 'startTurn').length, 2)
  finishTurn(fixture, 1)
  await waitFor(() => callsFor(fixture.mock.calls, 'completeRun').length === 2)
  assert.deepEqual(new Set(callsFor(fixture.mock.calls, 'completeRun').map((call) => connectionKeyFor(call.args[2]))),
    new Set([KEY_A, KEY_B]))
  assert.equal(callsFor(fixture.mock.calls, 'invoke').length, 0)
  for (const call of callsFor(fixture.mock.calls, 'completeRun')) {
    assert.doesNotMatch(JSON.stringify(call.args[1]), /COMBINED_REPLY_WITH_BOTH_STORE_RESULTS/)
  }
})

test('one authorization start failure leaves the other callable and independently completable', async () => {
  const fixture = createFixture({
    beforeStartTurn: async (key) => {
      if (key === KEY_A) throw new Error('Store A is temporarily unavailable')
    },
  })
  const assembly = await assemble(fixture.host, fixture.agent, 1)
  const read = fixture.local.get('tenant_info')
  assert.ok(read)
  assert.equal(read.parameters.properties.authorization_ref.enum.length, 1)
  const result = await read.execute(
    { authorization_ref: read.parameters.properties.authorization_ref.enum[0], arguments: {} },
    execution(fixture.agent, 'b-after-a-start-failure'),
  )
  assert.equal(result.result.text, 'STORE_B_RESULT')
  assert.equal(connectionKeyFor(callsFor(fixture.mock.calls, 'invoke').at(-1).args[1]), KEY_B)
  assert.doesNotMatch(JSON.stringify(assembly.contexts), /STORE_A_MEMORY|STORE_A_KNOWLEDGE/)
  assert.equal(callsFor(fixture.mock.calls, 'startTurn').length, 2)
  assert.equal(fixture.runBindings.size, 1)
  finishTurn(fixture, 1)
  await waitFor(() => callsFor(fixture.mock.calls, 'completeRun').length === 1)
  assert.equal(connectionKeyFor(callsFor(fixture.mock.calls, 'completeRun')[0].args[2]), KEY_B)
})
