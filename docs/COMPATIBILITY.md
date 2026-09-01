# Compatibility

## Native Agent Client 0.3.0

| Component | Verified version |
| --- | --- |
| DeepSeek Harness / Cordis lifecycle | `0.1.0-rc.7`; `0.1.1-rc.2` |
| Node.js | `22.19.0+` or `24+` |
| DSH tool presentation | Native Tool Mode |
| Generic Agent Client SDK | `bailinghub-mcp-server@0.3.0` via `./sdk` |
| BailingHub Core | `bailinghub@0.5.1`; Agent Auth v1 + Agent Client Runtime v1 |
| BailingHub turn context | `bailing.agent-turn-context.v1` |
| BailingHub capability search | `bailing.agent-capability-search.v1` |
| BailingHub governed invocation | `bailing.agent-tool-invocation.v1` |
| BailingHub run completion | `bailing.agent-run-completion.v1` |

Version 0.3.0 declares `bailinghub-mcp-server@0.3.0` as an exact ordinary dependency. A clean DSH
profile must work after installing only the plugin; ambient `node_modules`, peer/optional
dependencies, dist-tags, ranges, and local `file:` paths are outside the supported contract.
Compatibility with Core 0.5.1 includes the live Agent Auth/Runtime
contracts from that release.

DeepSeek Harness remains a developer preview. Every Harness version change requires a new smoke
against its real Cordis lifecycle, prompt waterfall, ToolRuntime, commands, durable session events,
and Web profile installation before this table can change.

`/bailinghub doctor` validates the required host API shape at runtime and reports the releases for
which that shape has been exercised. This is a diagnostic check, not a substitute for the live
browser authorization, read/write, approval/recovery, trajectory, and revocation gates below.

### Tool-mode and operating-system boundaries

- Native Tool Mode is required. DSH Code Mode is deliberately degraded because it cannot safely
  present the current-turn dynamic business schemas in 0.3.0.
- macOS Agent Session credentials use Keychain.
- Linux and other POSIX systems require the SDK's explicit secure file-store opt-in; the file must
  remain owned by the current user with mode `0600`.
- Windows Agent Session credentials use CurrentUser DPAPI. Native package installation, SDK
  resolution, and host lifecycle are Windows CI gates; each deployment must still accept its own
  live browser and business authorization flow.
- Non-loopback Hub connections require HTTPS. Loopback HTTP is for local development only.

### Host configuration contract

The plugin accepts only these four public routing fields:

```text
hubUrl
clientAppId
workspace
connectionName
```

In Agent Client v1, `workspace` is the BailingHub route id. Business endpoints, authorization page
URLs, Client Tokens, Tool Provider signing secrets, business credentials, and model-provider keys
are not DSH plugin configuration.

The public binding is the normalized Hub URL, client app id, and workspace tuple.
`connectionName` is a user-controlled local selector, not an identity claim. The Hub Client App
supplies one stable business authorization entry, and the business page
handles login, account switching, and tenant selection. After authorization, the SDK compares the
trusted `on_behalf_of` within the same public binding: the same identity replaces the older local
connection, while different identities remain independent. When a same-alias login returns a
different identity, the old alias and Session remain intact and the new identity receives a
non-conflicting alias that becomes current. A cleanup-required result keeps the new connection
authorized and must be resolved explicitly without another authorization attempt.

## Public legacy 0.1.x

| Component | Published version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| DSH MCP Client | in-box version shipped by `0.1.0-rc.7` |
| BailingHub MCP Server | exactly `0.1.1` |
| BailingHub Client API | `bailing.client-api.v1` |
| Node.js | `22.19.0+` |

Public `dsh-bailinghub@0.1.1` remains a configuration-only bundle. It starts the exact
`bailinghub-mcp-server@0.1.1` stdio command, exposes three fixed governed-job tools, and uses one
operator-configured Hub URL, route-scoped Client Token, and route. It does not establish an Agent
Session, receive a dynamic capability catalog, or move orchestration into local DSH.

The 0.3 line must not mutate the published 0.1 package or reinterpret its configuration. A new
BailingHub Core release is compatible only after a separate clean legacy profile proves that the
0.1.1 `/run` and `/jobs/{job_id}` flow still works.

## Release compatibility rule

Compatibility requires independent evidence for both paths:

1. Native 0.3: clean install of only the exact plugin package, browser authorization, workspace
   discovery, same-identity replacement, different-identity isolation, read, permitted mutation,
   approval/resume, visible completion, and Hub trajectory.
2. Legacy 0.1.1: clean static profile, fixed Client Token route, one submit, and same-job follow-up
   through the unchanged public Client API.

Passing one path does not establish compatibility for the other.
