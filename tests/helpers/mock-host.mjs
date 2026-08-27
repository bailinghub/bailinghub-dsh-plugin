export function createMockHost() {
  const listeners = new Map()
  const commands = new Map()
  const services = new Map()
  const effects = []

  const ctx = {
    commands: {
      register(definition) {
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    on(name, listener) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => {
        const index = entries.indexOf(listener)
        if (index >= 0) entries.splice(index, 1)
      }
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
  }

  return {
    ctx,
    commands,
    services,
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    async waterfall(name, ...args) {
      const entries = listeners.get(name) ?? []
      const terminal = args.pop()
      const dispatch = async (index) => {
        const listener = entries[index]
        if (!listener) return terminal()
        return listener(...args, () => dispatch(index + 1))
      }
      return dispatch(0)
    },
    async dispose() {
      for (const disposer of effects.reverse()) await disposer?.()
    },
  }
}

export function createMockAgent(id, baseDefinitions = []) {
  const base = new Map(baseDefinitions.map((definition) => [definition.name, definition]))
  const local = new Map()
  const agent = {
    id,
    session: { id: `session-${id}` },
    ctx: {
      tools: {
        modeFor() {
          return agent.toolMode ?? 'native'
        },
        register(definition) {
          if (local.has(definition.name)) throw new Error(`duplicate local tool ${definition.name}`)
          local.set(definition.name, definition)
          return () => local.delete(definition.name)
        },
        get(name) {
          return local.get(name) ?? base.get(name)
        },
      },
    },
  }
  return { agent, local, base }
}

export function baseAssembly(overrides = {}) {
  return {
    sections: [{ name: 'harness:identity', order: -100, text: 'Harness' }],
    contexts: [],
    tools: [],
    variables: {},
    ...overrides,
  }
}

export function userMessage(id, text) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

export const PROFILE_REVISION = 'a'.repeat(64)
export const CAPABILITY_REVISION = 'b'.repeat(64)
export const SEARCH_CAPABILITY_REVISION = 'c'.repeat(64)

export function activeTool(name = 'employee_update') {
  return {
    name,
    description: `Invoke ${name}`,
    input_schema: {
      type: 'object',
      properties: { employee_id: { type: 'string' } },
      required: ['employee_id'],
      additionalProperties: false,
    },
    scope: 'tenant.employee.write',
    risk: 'medium',
    approval_required: true,
    readonly: false,
    idempotent: false,
  }
}

export function turnResponse(options = {}) {
  return {
    schema_version: 'bailing.agent-turn-context.v1',
    run_id: options.runId ?? '123e4567-e89b-42d3-a456-426614174000',
    profile_revision: options.profileRevision ?? PROFILE_REVISION,
    capability_revision: options.capabilityRevision ?? CAPABILITY_REVISION,
    context: {
      instructions: 'Answer as the authorized workspace assistant.',
      page_context: { page: 'employees' },
      renderers: ['bailing-form.v1'],
      memory: [{ fact: 'The user prefers concise confirmations.' }],
      memory_refs: [{ id: 'memory-1' }],
      knowledge: [{ title: 'Employee policy', excerpt: 'Reference content.' }],
      knowledge_refs: [{ id: 'kb-1' }],
      governance: { final_authorization: 'business-system' },
    },
    active_tools: options.tools ?? [activeTool()],
  }
}

export function createMockTransport(overrides = {}) {
  const calls = []
  let starts = 0
  const record = (method, implementation) => async (...args) => {
    calls.push({ method, args })
    return implementation(...args)
  }
  const transport = {
    connectionsList: record('connectionsList', async () => ({
      currentConnectionKey: 'conn_current',
      connections: [{ connectionName: 'personal', workspace: 'demo', current: true }],
    })),
    connectionsAdd: record('connectionsAdd', async (input) => ({
      state: 'registered',
      connection: {
        connectionName: input.connectionName,
        hubUrl: input.hubUrl,
        clientAppId: input.clientAppId,
        workspace: input.workspace,
        current: true,
        state: 'logged_out',
      },
    })),
    connectionsUse: record('connectionsUse', async (connectionName) => ({
      state: 'selected',
      connection: {
        connectionName,
        hubUrl: connectionName === 'second' ? 'https://two.example.com' : 'https://hub.example.com',
        clientAppId: connectionName === 'second' ? 'second_client' : 'dsh_client',
        workspace: connectionName === 'second' ? 'staff' : 'demo',
        current: true,
      },
    })),
    connectionsRemove: record('connectionsRemove', async (connectionName) => ({
      state: 'removed', connectionName, remoteRevoked: true,
    })),
    login: record('login', async () => ({ state: 'authorized' })),
    status: record('status', async () => ({
      state: 'authorized',
      workspace: 'demo',
      access_token: 'not-exposed',
    })),
    logout: record('logout', async () => ({ state: 'logged_out' })),
    workspaces: record('workspaces', async () => ({ workspaces: [{ route: 'demo', name: 'Demo' }] })),
    use: record('use', async (input) => ({ state: 'selected', workspace: input.workspace })),
    startTurn: record('startTurn', async () => {
      starts += 1
      return turnResponse({
        runId: `123e4567-e89b-42d3-a456-${String(426614174000 + starts).padStart(12, '0')}`,
      })
    }),
    searchCapabilities: record('searchCapabilities', async () => ({
      schema: 'bailing.agent-capability-search.v1',
      capability_revision: SEARCH_CAPABILITY_REVISION,
      tools: [activeTool('employee_read')],
    })),
    invoke: record('invoke', async (input) => ({
      schema_version: 'bailing.agent-tool-invocation.v1',
      invocation_id: input.invocationId,
      route: 'demo',
      tool: input.tool,
      state: 'executed',
      ok: true,
      auto_retry_allowed: false,
      text: 'Employee updated.',
    })),
    resume: record('resume', async (invocationId) => ({
      schema_version: 'bailing.agent-tool-invocation.v1',
      invocation_id: invocationId,
      route: 'demo',
      tool: 'employee_update',
      state: 'executed',
      ok: true,
      auto_retry_allowed: false,
      text: 'Recovered.',
    })),
    completeRun: record('completeRun', async (runId, input) => ({
      schema: 'bailing.agent-run-completion.v1',
      run_id: runId,
      status: input.status,
    })),
  }

  for (const [method, implementation] of Object.entries(overrides)) {
    transport[method] = record(method, implementation)
  }
  return { transport, calls }
}

export function callsFor(calls, method) {
  return calls.filter((call) => call.method === method)
}

export async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}
