# Privacy

## Unreleased cross-system candidate

The candidate's cross-system mode is opt-in through an explicit selected target set on one Hub.
Before business execution, the original members and the Hub's capability support are verified.
The Agent initially receives only a directory of authorization references, local labels, opaque
system references and workspace names. A target starts its run only after an explicit capability
search or recovery selecting that target. The search query becomes that target's task input;
the full original user message is retained in the independent conversation archive instead of
automatically being sent to every target's run. Other selected targets may receive authorization
checks and archive membership confirmation, but no automatic business context request.

Query text is model-authored. Minimal disclosure is instructed, not an automatic redaction or
field-level data-flow policy: the local model can see all activated target context and the visible
conversation. Only use a shared conversation where that sharing is allowed. Cross-system object
relationships must come from verified mappings or explicit user confirmation, not matching names.
Original system/workspace bindings stay attached to tools, results and execution records.

Cross-system scope and outbox v2 persist each member's public Hub/app/workspace and original
Session with the same storage protections and plaintext archive boundary below. Same-system v1
records remain unchanged. The full transcript belongs to the independent Hub management audit;
holding one target's authorization does not grant full-transcript reading. This candidate does
not upload hidden reasoning or provide cross-process business-task recovery.

The following sections describe the released 0.4.0 same-system baseline.

This bundle adds no telemetry and stores no BailingHub credentials. Version 0.4.0
persists session-scope metadata and, when the SDK supports conversation archives, a separate
private outbox containing visible task text as described below.

Task text submitted through the installed tools is sent to the BailingHub deployment chosen
by the operator. DeepSeek Harness, the configured model provider, BailingHub, and the target
business system each have their own data-retention boundary. Review those deployments before
using personal, confidential, or regulated data.

Do not include tokens, private URLs, personal information, or production payloads in public
issues, screenshots, or compatibility reports.

## Native Agent Client 0.4.0

After explicit nonempty scope selection, the native 0.4.0 plugin sends each direct human user turn
to BailingHub Core and receives model-visible instructions, memory, reference-only knowledge, governance, and active tool schemas.
Business tool arguments and governed results cross the same boundary. At completion it sends a
hash-aliased message id, legal status, optional model/runtime labels, and numeric public usage. A single-authorization run receives the visible final answer;
multi-authorization runs receive only their own deterministic call summaries. It ignores
`assistant/chunk` and never uploads hidden reasoning.

Browser authorization, refresh, and credential storage remain SDK-owned; this adapter stores no
BailingHub credential. The SDK uses macOS Keychain, Windows CurrentUser DPAPI, or an explicitly
enabled isolated mode-0600 POSIX file store. Review DSH, model-provider, BailingHub, and
business-system retention boundaries before enabling the plugin.

The multi-connection registry contains public connection name, Hub URL, client app id, workspace,
timestamps, and current-selection state. It does not contain access tokens, refresh tokens, model
keys, business cookies, prompts, tool arguments, or business results.

## Same-system authorization selection

Version 0.4.0 includes only the authorization keys explicitly selected for a DSH
conversation, restricted to the same Hub/client/workspace binding. Unset or empty scope means
ordinary chat: no BailingHub run starts, no BailingHub business tool is registered, and the plugin
does not send that conversation's user input to a business system. Logging in or selecting a
registry default does not select a conversation scope. This does not change the data boundary of
DSH, the configured model provider, or unrelated host tools.

The host snapshots the selected connection bindings and exposes only session-local authorization
references, local display names, and availability as the selection directory. It does not expose
the raw registry, credentials, connection keys, or Session inspection responses to the model.
Local display names are user-controlled labels, not verified business identity claims.

After the full selection is validated, each user turn is sent to a separate Core run under each
selected authorization to obtain its instructions, governance, memory, and reference-only
knowledge. The local Agent and its model
provider therefore receive context from multiple authorized identities in the same conversation.
Authorization labels preserve attribution; they do not create isolation from the local model.
Use separate conversations when those identities' data must not share that boundary.
The host must await and display scope confirmation before sending the first message. That first
user message freezes the selection. A failed selection or any unavailable selected
authorization pauses all BailingHub business access for the conversation, without switching to a
default or silently retaining a subset.

Each business call uses only its selected authorization. Recovery retains the original
authorization and invocation. At completion, multi-authorization runs receive separate
deterministic summaries of their own governed calls, not the combined visible final answer or
another authorization's results. SDK 0.4.0 with Core 0.6.1 also receives the combined visible
conversation through the independent archive boundary below. Single-authorization conversations
retain the existing visible-answer completion flow.
Hidden reasoning is never uploaded by the adapter.

The host checks the captured connection key, workspace, and original Agent Session id before
transport operations without projecting those inspection fields into the model's directory.
Invocation bindings are local to the running conversation; a new conversation or process restart
does not recover unknown invocation ids from that map.

The default file adapter saves scope schema/version, DSH session id, revision, lock/state, public
Hub/client/workspace binding, and the selected connection keys, sanitized labels, workspace, and
original Agent Session ids. These identifiers stay host-side; the snapshot contains no access or
refresh token, browser credential, prompt, business argument/result, or invocation state. Files
are stored under `$DSH_HOME/plugins/dsh-bailinghub/session-scopes` (`~/.dsh` is the default home),
with hashed session filenames and, on POSIX, mode-0600 files and mode-0700 directories. They remain local until
removed by the host/operator; the adapter does not upload them. An embedded host may inject its
own durable store and retention policy. The explicit memory store is not persistent, and storage
failure never causes an automatic switch to it.

On reopening a conversation, only a valid locked scope is restored after its binding and original
Agent Sessions are rechecked. A stored unlocked draft needs explicit scope confirmation again;
loading it does not query its old authorizations or send them user input. A failed replacement
write can leave that draft on disk, but it still cannot reactivate automatically in a new runtime.
Configuration or metadata history alone does not lock a never-started draft. Missing or invalid
scope snapshots on started conversations do not adopt current registry connections.
Restoring that scope does not recover pending business invocations, approvals, completions, or
tasks across a process restart.

## Visible conversation archive

For a nonempty frozen scope, SDK 0.4.0 with Core 0.6.1 receives the claimed user messages,
visible assistant text, turn boundaries, and original run links as one conversation audit owned
by the complete selected authorization set. Visible text may itself contain personal or business
data; the adapter does not claim to redact arbitrary secrets pasted into that text. It never adds
SDK credentials, hidden reasoning, raw provider requests, attachments, or arbitrary tool payloads.
The combined conversation is not broadcast to each authorization's memory. Empty scope remains
outside this archive boundary. Review the whole selected group's data-sharing permission before
sending the first message.
If an original run response arrives after cancellation, only its audit link is retained for that
ended turn; it does not reactivate business tools, dispatch remaining members, or replace a newer turn.

The independent outbox lives under `$DSH_HOME/plugins/dsh-bailinghub/conversation-outbox` by default.
It contains a random persistent archive id, frozen public bindings/original Session ids, visible
events, hashes, and synchronization cursor. POSIX directories use `0700` and files `0600`; text is
not encrypted by this adapter. Outboxes remain on disk, including acknowledged events, until the
host/operator removes them. Hosts may inject a different durable store and retention policy;
there is no automatic retention cleanup or deletion of the separate Hub audit. Removing a local
outbox loses retry identity/history and must not be treated as deleting the remote record.

Network failures preserve successfully written events for later upload. Local write failures do
not prove durable capture. Reopened DSH history is checked for detectable missing visible events,
reported as `recovery_gap`; unavailable host history is marked unverified. Previously unarchived
messages, attachments, and hidden content are not claimed as a complete transcript. The archive
does not restore business invocation or approval execution after restart. An older SDK reports
unsupported without creating an outbox, and business calls remain available.

An offline reopen keeps the original frozen scope closed until every member can be revalidated.
A later retry on the same runtime may recover a temporary network failure, but cannot recover
confirmed revocation, replacement identity, or a storage conflict. Archive status retains known
unsaved events and history gaps while upload is blocked. Revocation confirmed during asynchronous
archive capability discovery or opening is rechecked before reporting availability or uploading.
