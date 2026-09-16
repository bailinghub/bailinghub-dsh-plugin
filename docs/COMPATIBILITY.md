# Current 0.6.0 pairing

Use Core 0.8.0, SDK 0.6.0 and DSH 0.6.0 for attachments, original receipts and task controls. Existing unenrolled flows retain their earlier protocol minima. Task enrollment persists: older hosts cannot omit task binding. See [upgrade](UPGRADE_v0.6.0.en.md).

# Compatibility

## Capability feedback

The additive [capability feedback contract](CAPABILITY_FEEDBACK.md) requires the paired
Core 0.8.0 / SDK 0.6.0 / DSH 0.6.0 release set for complete counts and error detail. Older unenrolled combinations keep their existing business behavior with unknown optional metadata.


## Native Agent Client 0.6.0

| Component | Release pairing / requirement |
| --- | --- |
| DeepSeek Harness | `0.1.1-rc.2`; real Session and native Cordis lifecycle |
| Node.js | `^22.19.0` or `>=24.0.0` |
| DSH tool presentation | Native Tool Mode; Code Mode deliberately degraded |
| Generic Agent Client SDK | Exact `bailinghub-mcp-server@0.6.0` via `./sdk` |
| BailingHub Core | `bailinghub@0.8.0`, with outstanding migrations through 062 applied |
| Selected scope | Single account, same-system multiple accounts, or different Client Apps/workspaces on one Hub and audit domain |
| Original authorization | A distinct original Agent Session for every selected target |
| Persistence | Existing same-system v1 scope/outbox and cross-system v2 records |

Install `dsh-bailinghub@0.6.0`; its ordinary dependency installs the exact SDK automatically.
Core 0.6.1 and SDK/plugin 0.4.0 remain the historical same-system baseline, not an alternative
pairing for new cross-system features. See the [upgrade steps](MIGRATION_VNEXT.md) and
[release scenario](RELEASE_NOTES_v0.5.0.md).

### Authorization subject display

Core 0.7.0, SDK 0.5.0 and plugin 0.5.0 support business-supplied authorization names. New
names are optional: an old SDK reports `unsupported`, a missing business name reports `missing`,
and neither blocks the existing tools. A list may show cached display data without claiming it
is fresh identity evidence. Current names and cache-write status remain separate from scope,
credential, archive and business errors. Existing v1/v2 records need no conversion or new labels;
names never replace their original key, binding or Session. See the
[display contract](AGENT_CLIENT_CONTRACT.md#authorization-subject-display-050).

### Cross-system scope

Requires Core 0.7.0, SDK 0.5.0 and plugin 0.5.0. Core must advertise
`cross_binding_members: true` and `member_bindings: "session-client-route.v1"` through
`bailing.agent-conversation-audit-capabilities.v1`, with its additive target-member migration ready.
The SDK must implement `getConversationArchiveCapabilities` and the `expectedBinding` dispatch guard.
Cross-system selection refuses missing support before creating any business run. Existing
same-system scope and archive interfaces continue using their v1 behavior.

One Hub may contain different Client Apps and workspaces; every target must have a distinct
original Agent Session. Multiple routes sharing a single Agent Session and cross-Hub conversations
are outside this release. Hosts using custom stores must preserve scope/outbox v2 records with
their original bindings and CAS revisions; do not convert v2 into v1 or reconstruct missing state.
See [the cross-system guide](CROSS_SYSTEM_CONVERSATIONS.md) for usage and limits.

## Historical native Agent Client 0.4.0

| Component | Release pairing / requirement |
| --- | --- |
| DeepSeek Harness | `0.1.1-rc.2`; real Session, Cordis lifecycle, commands, prompt assembly, and ToolRuntime regression coverage |
| Node.js | `^22.19.0` or `>=24.0.0` |
| DSH tool presentation | Native Tool Mode; Code Mode deliberately degraded |
| Generic Agent Client SDK | Exact `bailinghub-mcp-server@0.4.0` via `./sdk` |
| BailingHub Core | Recommended `bailinghub@0.6.1`; Agent Auth v1, Agent Client Runtime v1, and conversation audit v1 |
| Visible archive acknowledgement | `bailing.agent-conversation-audit-ack.v1` |
| Selected authorization group | One Hub + Client App + workspace; no cross-system or cross-route scope |

Core `0.6.0` is the minimum API version for this contract. Use Core `0.6.1` for the
recommended release pairing; the patch does not change these business APIs.

For this historical pairing, install `dsh-bailinghub@0.4.0`; its ordinary dependency installs the exact SDK. A release
requires a registry-generated lockfile and a clean package/profile check. Local source and
synthetic HTTP verification are compatibility evidence, not evidence of an organization's
production use. The older 0.3 baseline is retained below for existing users, not as a claim that
0.3 includes 0.4 features.

New conversations need explicit scope selection before the first message. Custom hosts must await
and display selection, preserve the stable conversation id, and restore the original scope before
sending on reopen. Missing started-session snapshots stay blocked. Saved drafts require fresh
confirmation. Scope restoration and archive synchronization do not recover business invocations,
approvals, or task execution after a process restart. The
[invocation recovery journal](INVOCATION_RECOVERY.md) supplies a separate durable journal
for explicit recovery of original calls. Custom scope-store hosts must explicitly provide
`invocationStore`; existing calls remain available if they have not enabled that feature.

Temporary network failure during reopening is retryable on the same runtime under the complete
original scope. Confirmed revocation, replaced identity, or storage/CAS conflict stays blocked.
Archived event ids and payloads remain stable on retry; known local write errors and detectable
history gaps cannot be hidden by a connectivity failure.

The archive transport seam is optional for injected older SDKs. They report `unsupported` while
existing business methods remain usable. An older Core may leave durable events pending or
unsupported; that degradation does not establish full compatibility with this release. Empty scope
starts no business run or archive operation. No model can select a new credential or bypass the
full selected group.

Local scope and outbox files use private POSIX permissions and atomic/CAS persistence. The outbox
contains plaintext visible task text, persists after acknowledgement, and has no automatic
retention cleanup. See [Privacy](../PRIVACY.md) and the [host contract](AGENT_CLIENT_CONTRACT.md).

The CI matrix checks Ubuntu and Windows with Node.js 22.19.0 and 24. Live business/browser
acceptance still belongs to each deployment; the matrix is not a universal deployment claim.

## Historical native Agent Client 0.3.0

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

The native line must not mutate the published 0.1 package or reinterpret its configuration. A new
BailingHub Core release is compatible only after a separate clean legacy profile proves that the
0.1.1 `/run` and `/jobs/{job_id}` flow still works.

## Release compatibility rule

Compatibility requires independent evidence for both paths:

1. Native 0.5: clean install of only the exact plugin package, browser authorization, workspace
   discovery, same-identity replacement, different-identity isolation, read, permitted mutation,
   approval/resume, visible completion, and Hub trajectory. Additionally verify explicit single/multiple
   scope selection, full-set archive authorization, offline reopen/retry, revocation, and no business
   replay after a lost archive acknowledgement. Verify cross-system routing and same-named tools,
   unselected-target isolation, metadata before tool search, and duplicate/renamed subject displays.
   Metadata reads must create no business run; subject names must not change identity or scope.
2. Legacy 0.1.1: clean static profile, fixed Client Token route, one submit, and same-job follow-up
   through the unchanged public Client API.

Passing one path does not establish compatibility for the other.
