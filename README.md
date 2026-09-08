# BailingHub for DeepSeek Harness

[简体中文](docs/README.zh-CN.md) | English

Use your local DeepSeek Harness Agent to operate the admin side of an online store, SaaS product,
or other business system through BailingHub. Ask it to look up data, update records, or run other
actions available to the connected account. The existing business identity, permissions, and
approval rules still apply, and BailingHub keeps the authorization and action trail.

For example, depending on what the connected business system has exposed, you can ask the local
Agent to:

- find an order, customer, product, or employee record;
- update an allowed field or business status;
- run another permitted admin action;
- return the result while BailingHub records the corresponding tool steps.

Reasoning and tool orchestration stay in DSH. BailingHub supplies the authorized business context,
available capabilities, approval state, invocation recovery, and audit records required for the
local Agent to act safely.

This is an independent community integration. It is not developed, certified, endorsed, or
recommended by DeepSeek.

> **Current stable line:** `dsh-bailinghub@0.3.0` uses the native Agent Client flow documented
> below. Public `0.1.1` remains available only as the explicit static MCP compatibility path.
> The same-system authorization selection described below is an **unreleased source candidate**;
> installing public `0.3.0` does not enable it.

For the shortest end-user path, follow the [three-minute getting started guide](docs/GETTING_STARTED.md).

## How the 0.3 Agent Client fits together

```text
DeepSeek Harness local Agent
  -> dsh-bailinghub native Cordis adapter
  -> bailinghub-mcp-server/sdk
  -> BailingHub Agent Auth + Agent API
  -> operator-selected business integration and final authorization
```

The packages have separate responsibilities:

- **BailingHub Core** owns Agent Auth, trusted business identity, runtime context, knowledge and
  memory projection, capability governance, approvals, invocation state, and audit records.
- **`bailinghub-mcp-server/sdk`** owns browser login, PKCE, credential storage, refresh,
  Hub/client/workspace connection selection, and HTTP DTO mapping.
- **`dsh-bailinghub`** owns only DSH session, prompt, command, and dynamic-tool lifecycle
  integration. It does not store credentials or call a business API directly.

This Agent Client is not the BailingHub executor. The executor receives jobs from the Hub for
work that must run near a machine; the Agent Client keeps the interactive reasoning loop on the
user's local DSH Agent.

## Before installing

The deployer and business integrator must prepare these public identifiers in BailingHub:

1. A reachable HTTPS BailingHub deployment with the matching Agent Auth and Agent API contracts.
2. A public Agent Client application id (`clientAppId`).
3. At least one authorized workspace. In Agent Client v1, the workspace id is the BailingHub
   route id.
4. One stable, account- and tenant-neutral business authorization entry configured on the Hub
   Client App, plus a governed ACC/Tool Provider integration behind that route. The business page
   must handle sign-in, account switching, and tenant selection before it approves the request.

The end user does **not** enter a business API URL, business login credential, Tool Provider
signing secret, BailingHub Client Token, or model-provider key into this plugin.

## Install the 0.3 line

Prerequisites:

- Node.js `22.19.0+` or `24+`;
- `pnpm` and a DeepSeek Harness release listed in the compatibility matrix;
- the BailingHub preparation above.

Install the exact stable version into the DSH Web profile:

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-bailinghub@0.3.0
```

`dsh-bailinghub@0.3.0` installs its exact compatible `bailinghub-mcp-server@0.3.0` dependency
automatically. DSH users should not separately guess or install an SDK version.

## Configure one Hub connection

The native plugin has exactly four host configuration fields:

| Plugin field | Environment value | Meaning | Secret |
| --- | --- | --- | --- |
| `hubUrl` | `BAILINGHUB_HUB_URL` | Public HTTPS URL of the developer's own BailingHub | No |
| `clientAppId` | `BAILINGHUB_CLIENT_APP_ID` | Public Agent Client application id registered in that Hub | No |
| `workspace` | `BAILINGHUB_WORKSPACE` | Initial authorized workspace/route id | No |
| `connectionName` | `BAILINGHUB_CONNECTION_NAME` | User-selected local connection label | No |

Example placeholders:

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='order_assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

The same four fields may be supplied through the DSH plugin settings surface. Do not add tokens,
authorization URLs, business domains, or credentials to the Cordis patch. The Hub resolves the
Client App to its single business authorization entry. `connectionName` is only a user-controlled
local selector; it is not an account, tenant, or identity claim.

Inspect the composed profile before starting it:

```bash
dsh --profile web --dump-config
dsh web
```

## Authorize and use the local Agent

In DSH, run:

```text
/bailinghub login
/bailinghub doctor
/bailinghub status
/bailinghub workspaces
```

`login` opens the system browser at the single business authorization entry configured by the Hub
operator. That business page owns sign-in, account switching, and tenant selection, confirms the
resulting business identity and requested workspace, then returns to a random loopback callback
protected by `state` and PKCE S256. Access and refresh tokens remain in SDK-owned secure storage
and are never written to the plugin configuration or printed by the command.

Useful commands:

| Command | Purpose |
| --- | --- |
| `/bailinghub doctor` | Check host APIs, public configuration, SDK resolution, authorization, and workspace reachability without printing credentials |
| `/bailinghub connections list` | List local public connection metadata and authorization state without tokens |
| `/bailinghub connections add <name> <hub-url> <client-app-id> <workspace>` | Create and select another local connection instance for new sessions; the public binding may match an existing instance |
| `/bailinghub connections use <name-or-key>` | Select a registered connection for new sessions only |
| `/bailinghub connections remove <name-or-key>` | Remotely revoke its Agent Session, then remove its local credential and metadata |
| `/bailinghub login` | Authorize the configured Hub/client/workspace in the browser |
| `/bailinghub status` | Inspect the selected connection without printing credentials |
| `/bailinghub workspaces` | List workspaces allowed by the current business authorization |
| `/bailinghub use <workspace>` | Select another already-authorized workspace for new sessions |
| `/bailinghub sync` | Retry a pending visible completion record without repeating a tool call |
| `/bailinghub logout` | Revoke and remove the selected Agent Session |

The four plugin fields are the bootstrap connection. Additional connections can be registered with
`connections add`; the BailingHub console's Agent Client page can generate the same secret-free
command. On restart, the adapter reads the SDK registry before the first new Agent session or user
command and adopts its current connection's public metadata; a missing or unavailable registry
safely falls back to the four bootstrap fields. Quote a connection name when it contains spaces.
After `connections use`, run `/bailinghub login` if that binding is not authorized yet.

Connection management and default selection are user-only slash commands, not model tools. They
affect only Agent sessions created afterward. Public `0.3.0` pins each session to one connection;
the unreleased candidate captures the same-binding authorizations described below.
`/bailinghub use <workspace>` remains a different operation: it succeeds
only when the current Agent Session already authorizes that workspace.

After removing the selected connection, the adapter reads the SDK registry and adopts the remaining
current connection for new sessions, including connections without an alias. Removing the final
connection leaves the adapter explicitly unconfigured. A failed post-remove registry read never
turns a successful removal into an error; removing a non-current connection also preserves the
still-valid default when that refresh is unavailable.

For the same `Hub + clientAppId + workspace` public binding, browser authorization determines the
identity from the business page and its trusted `on_behalf_of` result. If that identity is already
authorized under another local connection name, the SDK replaces the older local connection and
revokes its old Agent Session. A different trusted identity remains an independent connection.
If login starts from a `connectionName` that already belongs to another identity, the SDK keeps
that original alias and Session, gives the newly authorized identity an available local alias such
as `default-2`, and selects the new alias for future sessions. Use `connections list` to see both
and `connections use <name-or-key>` to switch explicitly.
If login returns `cleanupRequired: true`, the newly selected connection is still authorized, but
one or more existing same-binding connections need explicit cleanup. Their identity may still be
unconfirmed when inspection was deferred. Do not authorize again; inspect
`connections list` and retry `/bailinghub connections remove <name-or-key>` for the reported old
entry.

For the first acceptance check, start a new DSH conversation and perform one read-only request,
then one permitted mutation. Confirm the same conversation, run, visible final answer, and tool
invocation trajectory appear in BailingHub. An approval-required capability must resume the
original invocation after approval; it must never create a replacement business call.

DSH Code Mode is deliberately degraded in this release because it cannot safely present the
current-turn dynamic schemas. Use native tool mode for governed business actions.

## Unreleased source candidate: one system, multiple authorizations

The candidate lets one conversation use multiple independently authorized identities for the
same `Hub + clientAppId + workspace`. For example, the Agent can call the same reporting tool
once with Store A's authorization and once with Store B's, then compare the results without a
manual connection switch. Different Hubs, client applications, and workspaces are outside this
increment; no business-side capability declaration change is required.
Business integrations continue authorizing each identity through the existing SDK flow. The first
consumer of this change is the DSH plugin source candidate.
Account labels come from existing local `connectionName` values, not from decoding tokens or a
new Core display-name field. Create clearly named connections and authorize the corresponding
identities separately on the original business page. Names such as `default` and `default-2` do
not tell the model which one is Store A or B; it must not guess that mapping.

A new conversation captures eligible connections from the SDK registry and gives the model a
directory of session-local `authorization_ref` values, local display names, and availability.
A name helps the user recognize a connection; it does not prove a store, tenant, or identity. Choose clear names
and confirm ambiguous targets. Adding an authorization or changing a name takes effect in a new
conversation. The directory captures connection bindings, not credentials or continuing access:
each call still needs a valid authorization and the business system's permission checks.
The multi-authorization path activates automatically when at least two eligible connections are
captured; otherwise the existing single-connection path remains in use.

Matching business-tool declarations are registered once. In a conversation with multiple
authorizations, the model supplies a host selector outside the unchanged business arguments:

```json
{
  "authorization_ref": "<reference from this conversation>",
  "arguments": { "date": "2026-09-08" }
}
```

The adapter resolves that reference to its captured SDK connection. It never asks the model to
supply a credential, raw connection key, route, or acting identity. A single-authorization
conversation retains the original business-argument shape. The total active business-tool budget
remains 12; the adapter does not merge conflicting descriptions, schemas, or governance for a
same-name tool.
Identical declarations do not grant identical permissions: availability is checked for the chosen
authorization.
Capability search may select one `authorization_ref`; omitting it searches all authorizations in
the conversation.

Each user turn starts a separate Core run for each captured authorization, so the model receives
the applicable instructions and context before choosing an action. Those sections and tool
results retain their authorization labels. The visible user input reaches each of those runs;
do not use one conversation for identities whose context must remain separate from the local
Agent. Recovery uses the original invocation's authorization and run, even after another action
uses a different authorization. An expired or revoked authorization does not trigger a fallback
to another connection. Before transport operations, the adapter checks the captured connection
key, workspace, and original Agent Session id. A replacement Agent Session requires a new
conversation. Invocation bindings support recovery across turns in the same live conversation;
they are not persisted for recovery after a process restart or in a new conversation.

The combined final answer stays in DSH. Each Core run receives a deterministic summary of only
its own governed calls, rather than the cross-authorization final answer. See the
[candidate contract](docs/AGENT_CLIENT_CONTRACT.md#unreleased-same-system-authorization-selection)
and [privacy boundary](PRIVACY.md#unreleased-same-system-authorization-selection).

## Security and privacy boundary

- The model cannot supply a Hub URL, workspace, raw connection key, business identity, credential,
  approval result, or capability revision through tool arguments. The unreleased candidate permits
  only a host-issued authorization reference from the conversation's directory.
- The SDK stores credentials in macOS Keychain. On Windows it protects credential files under
  LocalAppData with CurrentUser DPAPI; unavailable Windows PowerShell or DPAPI fails closed without
  a plaintext fallback. Linux and other POSIX systems require an explicit secure file-store opt-in.
- BailingHub revalidates identity, scope, approval, idempotency, and invocation state on every
  governed call. The downstream business system still performs final authorization.
- The adapter sends visible user input and governed tool arguments/results. Public `0.3.0` sends
  the visible final answer; the candidate uses separate call summaries when multiple authorizations
  share a conversation. It never uploads hidden reasoning chunks.
- This plugin governs only the BailingHub tools it registers. It does not intercept unrelated DSH
  tools or model-provider traffic.

Review [Security](SECURITY.md), [Privacy](PRIVACY.md), the
[Agent Client contract](docs/AGENT_CLIENT_CONTRACT.md), and
[compatibility](docs/COMPATIBILITY.md) before production use.

## Legacy public 0.1.x static mode

Public `dsh-bailinghub@0.1.1` remains an immutable configuration-only bundle. It uses the in-box
DSH MCP Client to start `bailinghub-mcp-server@0.1.1`, binds one operator-provisioned Client Token
to one fixed route, and leaves orchestration in BailingHub.

```bash
dsh plugin --profile web add dsh-bailinghub@0.1.1

export BAILINGHUB_BASE_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_TOKEN='replace-with-a-route-scoped-client-token'
export BAILINGHUB_ROUTE='order_assistant'
```

It exposes exactly these three tools:

```text
mcp__bailinghub__submit_governed_job
mcp__bailinghub__get_governed_job
mcp__bailinghub__wait_for_governed_job
```

The 0.3 Agent Client does not automatically consume or migrate the 0.1 Client Token. Keep versions
explicit and follow the [0.1-to-0.3 migration boundary](docs/MIGRATION_VNEXT.md) when testing or
rolling back.

## Compatibility and feedback

Version 0.3.0 is verified only against the versions listed in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). DeepSeek Harness remains a developer preview, so
every Harness release requires a new native lifecycle smoke test.

Report problems through [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues).
Never include tokens, private deployment URLs, personal information, or production business
payloads.
