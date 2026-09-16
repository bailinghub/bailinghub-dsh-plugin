# Security Policy

Report vulnerabilities through a private GitHub Security Advisory in this repository.
Do not put tokens, private deployment URLs, personal information, or raw business payloads
in a public issue.

## Cross-system scope in 0.5.0

Different applications/workspaces may participate only through a frozen same-Hub target set,
with a distinct original Session per target. Capability support must be explicitly negotiated;
unsupported Core/SDK combinations cannot start cross-system business runs. Each member keeps
its own app/workspace binding, credential checks, approval rules and original invocations.
The SDK verifies the full expected binding before target HTTP dispatch, including refresh.

Capability search requires an explicit target and sends a model-authored, task-specific query;
it cannot fan out to all systems by omitting a selector. Identical tool names or schemas in
different systems do not establish shared semantics. Scoped aliases map back to an immutable
original capability and an allowed authorization set. The host enforces target membership;
it does not automatically prove the business meaning of model-generated queries or arguments.

All original members must remain valid. Temporary validation failure closes a retryable gate;
confirmed identity replacement or revocation blocks the complete selection. Cancellation and
late responses cannot reactivate ended-turn tools. Scope/outbox v2 retains original membership,
event IDs and CAS; a downgrade cannot reinterpret that state as v1. Full transcript reading
remains in the Hub's management audit boundary, not an individual member's Agent bearer.

## System descriptions and authorization names

System purpose comes from controlled Client/route metadata and is read only for selected original
bindings before capability search. It is descriptive data, not executable instructions or a grant
of tools. Business backends supply subject display names for the actual approved identity; names
remain separate from internal keys, original Sessions and the system description. Only the name
field is projected, with bounded length, valid Unicode and no control or line-separator characters.

A duplicate or changed name cannot merge authorizations, replace scope members or rewrite archived
labels. SDK display-cache data is auxiliary and cannot validate credentials or mask a scope/archive
storage error. Missing or unsupported display metadata leaves existing tools unchanged; a confirmed
identity failure still blocks the complete selection.

## Public legacy 0.1.x boundary

This bundle contributes configuration only. It has no custom runtime JavaScript, production
dependencies, or install-time scripts. On Harness startup, the built-in DSH MCP Client runs
the exact external command
`npx -y --package=bailinghub-mcp-server@0.1.1 bailinghub-mcp-server` outside the agent sandbox.
Treat that package as trusted executable code and review any version change before upgrade.

Use a dedicated BailingHub Client Token restricted to one route. The bundle must never
receive an administrator token, executor token, approval credential, business-system secret,
or acting-subject credential. Route, URL, and token stay in operator-controlled environment
configuration and are never model tool arguments.

Non-loopback HTTP is denied by default. Do not enable insecure HTTP on an untrusted network.

## Native 0.5.0 boundary

The native 0.5.0 plugin accepts only `hubUrl`, `clientAppId`, `workspace`, and
`connectionName`. The generic SDK owns browser authorization, refresh, and secure credential
storage; business endpoints and final authorization remain Core/business-system concerns. The
Hub Client App owns one business authorization entry. That business page, not the plugin or model,
handles login, account switching, tenant selection, and the trusted `on_behalf_of` identity.

The multi-connection registry stores only public Hub/client/workspace metadata. `connectionName`
is a user-only local selector, not an identity claim. After browser
authorization, the SDK replaces an older same-binding connection only when the trusted
`on_behalf_of` matches; different trusted identities remain isolated. A same-alias authorization
for a different identity preserves the original alias and Session and assigns the new identity a
non-conflicting local alias. If inspection or old-Session revocation is uncertain, the new
connection stays authorized and explicit cleanup is required.
Connection add/use/remove are user slash commands, not model tools. Removing an authorized
connection is remote-revoke-first and keeps the local credential if revocation fails, so it cannot
falsely report a complete logout.

Tools are Agent/run scoped. Message ids are replaced by Core-safe hash aliases, invocation ids are
stable 64-character digests, and an `accepted_unknown` outcome must resume that exact invocation
instead of creating a replacement. Completion retries are bounded and reuse one frozen,
visible-only payload. Version 0.5.0 installs `bailinghub-mcp-server@0.5.0` as an exact ordinary
dependency and resolves its `./sdk` export. It does not depend on ambient modules, an optional
peer, a range, a dist-tag, or a local path. Public `0.1.1` does not provide that facade.

Agent Session credentials use macOS Keychain or Windows CurrentUser DPAPI-protected files under
LocalAppData. Windows PowerShell or DPAPI unavailability fails closed without a plaintext fallback.
Linux and other POSIX hosts must explicitly enable the SDK's isolated mode-0600 file store. The
plugin never receives the credential value and never writes one into Cordis configuration.

## Same-system authorization selection

The same-system path introduced in 0.4.0 lets the model select a session-local `authorization_ref` from the current
conversation's directory. This is a constrained per-call selector, not a connection-management
tool or authority to supply a Hub, route, raw connection key, credential, or business identity.
The host must first explicitly select fixed connection keys for this conversation through
`setSessionScope` or the user-only `/bailinghub scope set <connection-key>...` command. Aliases are
not scope keys. Unset scope and `[]` (`/bailinghub scope none`) remain ordinary chat, without
BailingHub tools or runs. Authorization and registry defaults cannot grant conversation scope.
The selected bindings must share one Hub/client/workspace; unselected bindings are excluded.
The adapter never implements selection by changing the SDK's global current connection.

Hosts must await successful scope persistence and confirmation before sending the first user
message. The first `user/message` event freezes scope, with the inbox claim as a fallback, before
`startTurn`; an in-flight or
failed selection cannot admit business work. Subsequent changes require a new conversation.
The full selected group is checked before business input is sent. Any missing, revoked, replaced,
or unreadable selected authorization pauses the whole conversation's business access. The adapter
must not silently adopt a default or shrink the scope to the remaining valid authorizations.

Local connection names are untrusted display data. They do not prove tenant identity, widen an
authorization, or replace the business system's final permission checks. The directory is a
binding snapshot, not a credential snapshot: expired, removed, or revoked access must fail
without silently selecting another authorization. New authorizations and alias changes require
a new conversation.
The host checks the fixed connection key, workspace, and original Agent Session id before
transport operations. An Agent Session replacement also requires a new conversation, even if
the local alias or connection key remains unchanged.

Matching declarations share one typed tool. Conflicting same-name descriptions, schemas, or
governance are not merged for execution, and a shared declaration cannot confer another identity's permissions.
Each invocation binds its chosen authorization, Core run, and capability revision. Recovery
accepts only an invocation known to this conversation and resolves its original binding; the
model cannot provide a replacement authorization. Changing a default connection cannot retarget
an existing call.
The live invocation map supports later turns of the same conversation. The unreleased
[durable recovery journal](docs/INVOCATION_RECOVERY.md) additionally persists original
metadata before dispatch and validates it after reopening. New conversations, missing records,
and conflicting original identities still reject recovery. Raw parameters and credentials do
not belong in the invocation journal; model text never reconstructs its authority.

Only non-secret scope metadata belongs in the scope store. Its default file store uses SHA-256 session filenames,
mode-0600 files and mode-0700 directories on POSIX, bounded reads, rejection of symlinks/non-regular files,
revision compare-and-swap, a cross-process lock, and atomic replacement. Lock timeout reports a
conflict without deleting another process's lock. Corrupt data and I/O failure fail closed; they
are never interpreted as an absent selection or a reason to use memory storage. Before validating
a replacement scope, the coordinator attempts to persist `needs_selection`. Failure of that first
write can leave the previous draft on disk. Every unlocked snapshot loaded into a new runtime is
therefore blocked pending explicit selection, without checking its previous SDK authorizations;
restart safety does not assume that the failed write replaced the old record.

The host may inject a store with the same CAS semantics; the provided memory adapter is explicitly
non-persistent. `restoreSessionScope` restores only a valid locked selection after verifying its
keys, binding, and original Agent Session ids. Unlocked drafts require explicit selection again;
started conversations without valid locked scope stay blocked. History containing only metadata,
configuration, or seed markers does not prove that a conversation started. The lifecycle check
requires an actual user-sourced `user/message` or `turn/start` and uses seed/observation boundaries
to distinguish prior history from a new first message. It restores scope only, not invocations,
approvals, pending completions, or task execution. A new conversation is required to change an
already-started scope. No token, credential, prompt, or business payload belongs in the
scope snapshot.
The trusted host owns stable, unique conversation ids and the store namespace. Scope APIs and
records must not be exposed as model-controlled storage or allow an untrusted caller to select
another conversation's id. This plugin does not secure unrelated host filesystem tools; the host
must enforce that access boundary.

The adapter keeps authorization-specific instructions and context labeled, and each run receives
only its authorization's deterministic call summary. It does not broadcast a combined final
answer to every run. Visible user input and context do share the local conversation boundary;
see [Privacy](PRIVACY.md#same-system-authorization-selection).

The independent conversation-audit extension sends visible text for the complete frozen member
set through an optional SDK API. A durable random archive UUID supplies correlation, not authority:
the SDK/Core must validate every original member before confirming or appending, and Core owns the
aggregate read permission. Never expose mixed free text to a reader authorized for only one member
by assuming it can be safely redacted. The original run id and member Session bind run links;
archive synchronization cannot create or resume a business action. Late links remain attached to
their original turn.

The separate private outbox contains plaintext visible task text and must be protected from
untrusted host/model filesystem tools. It has bounded reads, no-follow regular-file checks,
CAS/lock/atomic-write semantics, and no credential or scope-store fallback. Payloads and ids remain
stable on ambiguous network retries. Local I/O failure can leave an unpersisted event: available
DSH history is compared after reopening, and missing events produce `recovery_gap`, not a claim
of a complete transcript. Hosts without history must show unverified coverage. This boundary is
not a distributed transaction or durable business-task recovery mechanism.

Transient transport failures do not prove that an original authorization was revoked. Scope
get/restore and archive retry may revalidate all original members on the same runtime, while
keeping business access and uploads closed until validation succeeds. Concurrent callers share
that validation. Confirmed revocation/replacement and storage/CAS conflicts remain terminally
blocked, with no default or subset fallback. The gate is rechecked after asynchronous archive
capability discovery and outbox opening; a late result cannot erase a confirmed revocation.
Known local storage errors and capture gaps remain visible even while network or scope checks block upload.


## Task records in 0.6.0

A private persistent task store binds the original Session, fixed members and administrator-created task. It does not store administrative credentials or grant model task-management authority. Retain original scope, task, invocation and archive records; storage errors never downgrade to an unrestricted flow. Task enrollment persists on the original Agent Session even after cancellation. Do not downgrade an enrolled authorization to a host/Core that ignores that requirement. See [task control](docs/TASK_CONTROL.md) and [upgrade](docs/UPGRADE_v0.6.0.en.md).
