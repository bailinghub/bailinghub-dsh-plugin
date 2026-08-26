import Schema from '@deepseek-ai/schemastery'

import { BailingHubAgentClientRuntime } from './runtime.js'
import { createTransportProvider } from './transport.js'

export const name = 'dsh-bailinghub'
export const inject = ['systemPrompt', 'tools', 'commands']

export const Config = Schema.object({
  hubUrl: Schema.string()
    .default('')
    .description('BailingHub public HTTPS URL. Loopback HTTP is allowed for local development only.'),
  clientAppId: Schema.string()
    .default('')
    .description('Public Agent Client application id issued by BailingHub.'),
  workspace: Schema.string()
    .default('')
    .description('Initial BailingHub workspace/route. The Hub resolves business endpoints and authorization.'),
  connectionName: Schema.string()
    .default('default')
    .description('Local SDK connection alias. Credentials remain in SDK-owned secure storage.'),
})

export function createAgentClientPlugin(options = {}) {
  return {
    name,
    inject,
    Config,
    apply(ctx, config) {
      const getTransport = createTransportProvider(config, options)
      const runtime = new BailingHubAgentClientRuntime(ctx, config, getTransport).install()
      ctx.provide('bailingHubAgentClient', runtime)
    },
  }
}

export function apply(ctx, config) {
  return createAgentClientPlugin().apply(ctx, config)
}

export { BailingHubAgentClientRuntime } from './runtime.js'
export {
  DEFAULT_SDK_MODULE,
  REQUIRED_METHODS,
  assertTransport,
  createLazySdkTransport,
  createTransportProvider,
} from './transport.js'
