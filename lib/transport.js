const DEFAULT_SDK_MODULE = 'bailinghub-mcp-server/sdk'

const REQUIRED_METHODS = [
  'connectionsList',
  'connectionsAdd',
  'connectionsUse',
  'connectionsRemove',
  'login',
  'status',
  'logout',
  'workspaces',
  'use',
  'startTurn',
  'searchCapabilities',
  'invoke',
  'resume',
  'completeRun',
]

function assertTransport(transport) {
  if (transport === null || typeof transport !== 'object') {
    throw new TypeError('BailingHub Agent Client transport must be an object')
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof transport[method] !== 'function') {
      throw new TypeError(`BailingHub Agent Client transport is missing ${method}()`)
    }
  }

  return transport
}

function resolveSdkFactory(module) {
  for (const candidate of [
    module.createAgentClientTransport,
    module.createAgentClient,
    module.default,
  ]) {
    if (typeof candidate === 'function') return candidate
  }

  throw new TypeError(
    `${DEFAULT_SDK_MODULE} must export createAgentClientTransport(), createAgentClient(), or a default factory`,
  )
}

/**
 * Lazily resolves the generic BailingHub Agent Client SDK. The SDK, rather than
 * this DSH adapter, owns browser authorization, token storage, refresh, and the
 * HTTP endpoint mapping. A missing SDK therefore degrades only the first use;
 * it never prevents Cordis from loading the plugin.
 */
export function createLazySdkTransport(config, options = {}) {
  const importModule = options.importModule ?? ((specifier) => import(specifier))
  const moduleName = options.moduleName ?? DEFAULT_SDK_MODULE
  let clientPromise

  const client = () => {
    clientPromise ??= Promise.resolve(importModule(moduleName)).then(async (sdkModule) => {
      const factory = resolveSdkFactory(sdkModule)
      return assertTransport(
        await factory({
          hubUrl: config.hubUrl,
          clientAppId: config.clientAppId,
          workspace: config.workspace,
          route: config.workspace,
          connectionName: config.connectionName,
        }),
      )
    })
    return clientPromise
  }

  return Object.fromEntries(
    REQUIRED_METHODS.map((method) => [
      method,
      async (...args) => (await client())[method](...args),
    ]),
  )
}

export function createTransportProvider(config, options = {}) {
  let transportPromise

  return async () => {
    transportPromise ??= Promise.resolve(
      options.transport ??
        options.transportFactory?.(config) ??
        createLazySdkTransport(config, options.sdk),
    ).then(assertTransport)

    return transportPromise
  }
}

export { DEFAULT_SDK_MODULE, REQUIRED_METHODS, assertTransport }
