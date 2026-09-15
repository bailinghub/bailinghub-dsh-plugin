# BailingHub for DeepSeek Harness

[简体中文](docs/README.zh-CN.md) | English

Ask your local DeepSeek Harness Agent to work with a business system connected to BailingHub:
find records, update allowed fields, and follow the system's existing approval rules.
BailingHub records which authorization was used and what each business action returned.

**Version 0.5.0 lets one conversation use authorizations from different systems on the same Hub.**
Authorize a shop and inventory system separately, select both for a new conversation and ask:

> Check tumbler stock. If any are available, change the corresponding shop product's price to 59
> and list it; otherwise leave it unlisted.

The Agent reads stock with the inventory authorization, then uses the shop authorization for the
permitted price and listing actions. Those capabilities must already exist, and the product mapping
must be confirmed. A stock read does not reserve or synchronize stock. Price changes, listing
results and approvals are tracked separately.

The 0.4.0 same-system flow remains available: select Store A and Store B to compare sales without
switching a global connection. New system descriptions explain each selected system's purpose
before tool search, and business-supplied names identify the approved organization, account or
other subject. See [what changed and how to upgrade](docs/RELEASE_NOTES_v0.5.0.md).

It also keeps the visible conversation together with links to its business actions. If uploading
that record fails, it can retry after reconnecting or restarting without repeating those actions.

This is an independent community integration, not a plugin developed, certified, endorsed, or
recommended by DeepSeek.

## Candidate: continue a conversation without discovering the same tool again

A user checks a shop product, then asks “what about its stock?” in the next message.
An opted-in host can keep recent complete tool declarations in that same living session.
The next business step prepares current context and a new run for the selected account,
then reuses a valid declaration without another capability-search request. A greeting
does not start business runs. Unknown writes still recover only their original invocation.

This is a **local candidate**, enabled by the host with `toolLifecycle: 'session'`;
the published version number alone does not identify its bytes. Existing hosts keep
their current behavior. See the [lifecycle and host integration contract](docs/SESSION_TOOL_REUSE.md)
before installing the exact candidate and enabling it.

## Install and start

You need Node.js `22.19.0+` or `24+`, pnpm, and a compatible DeepSeek Harness release. Your
administrator must first connect the business system to BailingHub. The matched release set is
**BailingHub Core 0.7.0 → BailingHub MCP/SDK 0.5.0 → this plugin 0.5.0**.

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-bailinghub@0.5.0
```

The plugin installs its exact `bailinghub-mcp-server@0.5.0` dependency automatically.
For an existing installation, read the [migration steps from 0.4.0 and earlier](docs/MIGRATION_VNEXT.md).

Follow the [getting started guide](docs/GETTING_STARTED.md) to enter your administrator's four
public connection values and authorize in the browser. Do not put a business password, Client
Token, signing secret, or model-provider key into this plugin's settings or chat.

## Choose the accounts for each conversation

Authorize each account separately through its original business authorization page and verify the
approved subject. A compatible business backend supplies its display name automatically, such as
“Brand flagship store” or “Main warehouse”. A missing name is shown as “Authorization name pending
sync”; the plugin does not guess it from a local alias.

Names are for display only. Duplicate names and renames do not merge or recreate credentials,
change an original Session, or rewrite history. Keep the local connection selector and fixed key
independent from both the current business name and the system description.

In a **new conversation, before the first message**, run:

```text
/bailinghub connections list
/bailinghub scope set <shop-connection-key> <inventory-connection-key>
/bailinghub scope
```

Replace the placeholders with the fixed keys from the list, not connection names. You can select
just one account, several accounts in one system, or several systems on the same Hub and audit
domain. Each selected target must have its own original Agent Session.
Wait for the command to confirm the selection, then send your request.

**New conversations start as ordinary chat until you select their business scope.** Logging in or
changing the default connection does not enable business tools. `/bailinghub scope none` explicitly
chooses ordinary chat. The first user message freezes the selection; start a new conversation to
change accounts or move from ordinary chat to business access.

Matching tools within one system are shared; same-named tools from different systems remain
separate. The Agent chooses the authorization for each call; it does not receive credentials. Every action still uses that account's own permissions and
approval rules. An approval-required action continues the original call after approval while that
conversation is still running.

If any selected authorization is revoked, replaced, or cannot be checked, business access pauses
for the whole conversation. The plugin never silently switches to another account. A temporary
connection failure can be retried with the same original selection after the network returns.
A confirmed revocation or identity change requires a new conversation with a valid selection.

## Follow the conversation and its actions

With Core 0.7.0 and SDK 0.5.0, BailingHub can show the visible user and assistant messages, turn
boundaries, and links to the original business runs as one conversation record. Each authorization
also keeps its own business-call record; the combined reply is not copied into every account's
memory.

```text
/bailinghub archive status
/bailinghub archive sync
```

`archive status` shows whether the visible record has uploaded. `archive sync` retries the saved
record without running the business actions again. This is separate from `/bailinghub sync`,
which retries a pending run completion in the currently running conversation.

| Status | What it means |
| --- | --- |
| `synced` | Saved events have been acknowledged by the Hub; this does not prove a business action succeeded |
| `pending` | Upload is unfinished; retry when the connection is available |
| `blocked` | Original authorization checks prevent upload; inspect `/bailinghub scope` |
| `unsupported` | The connected SDK or Hub does not support this archive contract |
| `storage_error` | A local write failed; some visible events may not yet be safely saved |
| `recovery_gap` | Available DSH history shows missing archive events; the record is incomplete |

Reopening a saved business conversation restores its original selected accounts only after every
original authorization is checked. If it was reopened offline, reconnect and run
`/bailinghub archive sync` or `/bailinghub scope` in that same conversation to retry the check.
This recovers scope and saved uploads, **not pending business invocations or approvals after a
process restart**. A saved draft that never started needs explicit selection again. An older
started conversation without a valid saved scope cannot adopt today's default account.

## What is shared and stored

All selected accounts' context and your visible user request share the same local Agent/model
conversation. The combined archive requires the full selected authorization set; an authorization
for only one member is not sufficient to read the mixed conversation. Use separate conversations
when those accounts' data must remain separate.

The plugin captures visible text from business turns enabled with this version, not all past
conversations, attachments, or hidden reasoning. It cannot remove arbitrary secrets pasted into
visible text. Missing local writes are reported as gaps when detectable; hosts without durable
history report unverified coverage.

The private local outbox contains **plaintext visible task text**, including events already
uploaded. It stays under the DSH home until the host/operator removes it; there is no automatic
retention cleanup. Removing it does not delete the Hub's record. Credentials remain in SDK-owned
secure storage. Review [Privacy](PRIVACY.md) and [Security](SECURITY.md) before enabling business
access.

## Commands and administration

| Command | Purpose |
| --- | --- |
| `/bailinghub doctor` | Check setup, SDK, authorization, and workspace without printing credentials |
| `/bailinghub login` | Authorize the selected connection in the browser |
| `/bailinghub status` | Inspect that connection's authorization |
| `/bailinghub connections list` | List connection labels, fixed keys, and authorization state |
| `/bailinghub connections add <name> <hub-url> <client-app-id> <workspace>` | Register a connection and select it for connection management; quote names containing spaces |
| `/bailinghub connections use <name-or-key>` | Choose which connection to manage or authorize; does not change a conversation's scope |
| `/bailinghub connections remove <name-or-key>` | Revoke its Agent Session before removing local credentials |
| `/bailinghub workspaces` | List workspaces allowed by the current authorization |
| `/bailinghub use <workspace>` | Select another already-authorized workspace for connection management |
| `/bailinghub logout` | Revoke and remove the selected Agent Session |

Connection management and scope selection are user commands, not model tools. Reauthorizing the
same trusted identity replaces its old connection and Agent Session. A different identity remains
independent. If login reports cleanup required, the new connection is already authorized: inspect
the listed old entry and retry its removal, rather than authorizing again. Details are in the
[host contract](docs/AGENT_CLIENT_CONTRACT.md#browser-identity-and-local-reconciliation).

## For integrators

DSH owns reasoning and tool orchestration. BailingHub Core owns trusted identity, governance,
approvals, invocation state, and audit. The SDK owns browser authorization, secure credentials,
and HTTP mapping. This plugin only adapts DSH sessions, prompts, commands, tools, and visible events;
it does not call your business API directly or govern unrelated DSH tools.

Existing business integrations continue exposing the same capabilities and authorizing each
identity separately. Custom DSH hosts must implement the [scope selection and restore APIs](docs/AGENT_CLIENT_CONTRACT.md#host-owned-session-scope-api)
and display confirmation before the first message. The native slash commands already use those
APIs. Tool envelopes, persistence, event schemas, and recovery limits are documented in the
[Agent Client contract](docs/AGENT_CLIENT_CONTRACT.md).
For the unreleased Local Agent attachment space (image-first), see [host artifact integration](docs/GENERATED_ARTIFACTS.md). Register approved conversation outputs, upload them once, and use ready URLs with existing business tools.

Use Native Tool Mode. DSH Code Mode is deliberately degraded because it cannot safely present the
current-turn dynamic schemas. See the [compatibility matrix](docs/COMPATIBILITY.md).

## Legacy 0.1.1 and feedback

Public `dsh-bailinghub@0.1.1` remains the separate static MCP compatibility path. It starts
`bailinghub-mcp-server@0.1.1`, uses one operator-provided route-scoped Client Token, and leaves
orchestration in BailingHub. The native plugin does not read or convert that credential. Keep the exact
legacy version when using that path and follow the [migration guide](docs/MIGRATION_VNEXT.md).

Report issues at [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues) with
versions and redacted errors. Do not include tokens, private URLs, personal data, or production
payloads. Compatibility tests and package downloads are not evidence of production adoption.


## Candidate: recover an original action after reopening

An unreleased candidate adds a local invocation journal for actions such as a product listing
awaiting approval or an inventory update whose response was lost. Reopen the same conversation
and explicitly recover the original call without creating a second business request. Custom
hosts must retain the new store alongside their existing Session scope. See the
[recovery contract, limits and host integration](docs/INVOCATION_RECOVERY.md).
