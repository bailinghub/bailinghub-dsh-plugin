# Security Policy

Report vulnerabilities through a private GitHub Security Advisory in this repository.
Do not put tokens, private deployment URLs, personal information, or raw business payloads
in a public issue.

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

## Native 0.3.0 boundary

The native 0.3.0 plugin accepts only `hubUrl`, `clientAppId`, `workspace`, and
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
visible-only payload. Version 0.3.0 installs `bailinghub-mcp-server@0.3.0` as an exact ordinary
dependency and resolves its `./sdk` export. It does not depend on ambient modules, an optional
peer, a range, a dist-tag, or a local path. Public `0.1.1` does not provide that facade.

Agent Session credentials use macOS Keychain or Windows CurrentUser DPAPI-protected files under
LocalAppData. Windows PowerShell or DPAPI unavailability fails closed without a plaintext fallback.
Linux and other POSIX hosts must explicitly enable the SDK's isolated mode-0600 file store. The
plugin never receives the credential value and never writes one into Cordis configuration.

## Unreleased same-system authorization selection

The source candidate lets the model select a session-local `authorization_ref` from the current
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
This invocation map lasts only for the live conversation: later turns can recover its original
calls, while new conversations and process restarts must reject unknown invocation ids.

Only non-secret scope metadata is durable. The default file store uses SHA-256 session filenames,
mode-0600 files and mode-0700 directories on POSIX, bounded reads, rejection of symlinks/non-regular files,
revision compare-and-swap, a cross-process lock, and atomic replacement. Lock timeout reports a
conflict without deleting another process's lock. Corrupt data and I/O failure fail closed; they
are never interpreted as an absent selection or a reason to use memory storage. Before validating
a replacement scope, a durable `needs_selection` record prevents the previous broader scope from
reappearing after a failed selection and restart.

The host may inject a store with the same CAS semantics; the provided memory adapter is explicitly
non-persistent. `restoreSessionScope` verifies the stored keys, binding, and original Agent Session
ids, and keeps old conversations without valid snapshots blocked. It restores scope only, not
invocations, approvals, pending completions, or task execution. A new conversation is required to
choose different authorizations. No token, credential, prompt, or business payload belongs in the
scope snapshot.
The trusted host owns stable, unique conversation ids and the store namespace. Scope APIs and
records must not be exposed as model-controlled storage or allow an untrusted caller to select
another conversation's id. This plugin does not secure unrelated host filesystem tools; the host
must enforce that access boundary.

The candidate keeps authorization-specific instructions and context labeled, and synchronizes
only each authorization's own deterministic call summary. It does not broadcast a combined final
answer to every run. Visible user input and context do share the local conversation boundary;
see [Privacy](PRIVACY.md#unreleased-same-system-authorization-selection). This candidate is not
part of the published `0.3.0` package.
