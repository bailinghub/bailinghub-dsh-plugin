# Changelog

## Unreleased

- Recover an offline-reopened locked conversation on the same runtime after connectivity returns.
  Treat uncertain authorization probes as retryable closed gates, revalidate every original member,
  and keep confirmed identity loss and storage conflicts blocked without changing persisted scope.
  Concurrent business and archive calls wait for the current whole-scope proof.
- Preserve known unsaved archive events and visible-history gaps during blocked uploads and late
  network failures. Archive capability-discovery failures remain pending rather than storage errors.

- Change the unreleased candidate to explicit per-conversation scope: unset or empty scope stays
  ordinary chat. Registered authorizations and the global default no longer automatically enable
  business tools or runs in a new candidate conversation.
- Add host `setSessionScope`, `getSessionScope`, and `restoreSessionScope` APIs, plus user-only
  `/bailinghub scope`, `scope none`, and `scope set <connection-key>...` commands. Validate selected
  keys before sending business input and freeze scope on the first `user/message` event, with
  the inbox claim as a fallback for drivers that do not emit it.
  Hosts must await and display successful selection before sending; scope changes require a new
  conversation after the first message.
- Persist non-secret scope snapshots with revision compare-and-swap, cross-process locking, and
  atomic files under the DSH home. Permit injected stores and an explicit non-persistent memory
  adapter. Missing or invalid old snapshots, failed selection, or any unavailable selected
  authorization block the whole business scope without a default or subset fallback.
- Require explicit reconfirmation of every unlocked scope draft loaded into a new runtime,
  without probing its old authorizations. This also blocks a stale draft when the first
  replacement-marker write failed. Valid locked conversations still restore their original scope.
- Recognize started conversations from actual user-sourced messages or turn-start events, not
  `firstLiveSeq` or metadata alone. Preserve selection for metadata-only drafts and distinguish
  seeded/previous history from the current first message without changing the scope schema or API.
- Allow explicitly selected, independently authorized identities sharing one Hub/client/workspace
  binding in one conversation, without changing the global connection.
- Register matching typed business tools once, with a host-issued `authorization_ref` selector
  outside the original business arguments in multi-authorization conversations. Preserve the
  original argument shape for single-authorization conversations and the 12-tool total budget.
- Keep per-authorization context, permission checks, run state, and exact-invocation recovery
  across turns of the same live conversation; pin the original Agent Session before transport,
  reject conflicting same-name declarations and never retarget a pending operation.
  Scope restoration across a process restart does not restore invocations, approvals, or tasks.
- Synchronize separate deterministic call summaries for multi-authorization runs. A matching
  candidate SDK/Core additionally archives one visible conversation for the full frozen member
  set, without broadcasting the combined answer into each member's memory or collecting reasoning.
- Persist a separate private visible-event outbox with a random archive identity, stable event ids,
  original run links, and acknowledgement cursor. Add host archive status/sync APIs and user-only
  `/bailinghub archive status|sync`; archive retry after restart never replays business actions.
  Keep older SDKs usable with explicit unsupported status. Detect visible-history gaps after local
  write failure/restart instead of claiming complete capture; hosts without history remain unverified.
- Keep a cancelled turn ended when its original `startTurn` response arrives late: retain its audit
  link without reactivating business tools, dispatching remaining members, or replacing a newer turn.
- Keep public `dsh-bailinghub@0.3.0` as the stable release; this candidate has not been published.

## 0.3.0 - 2026-09-01

- Add `/bailinghub doctor` for credential-safe host-contract, configuration, SDK, authorization,
  and workspace diagnostics before a business turn starts.
- Add real lifecycle coverage for DeepSeek Harness `0.1.1-rc.2` and enforce it in Ubuntu,
  Windows, and tagged publication workflows.
- Make `connectionName` a user-controlled local selector while the business authorization page
  owns login, account switching, tenant selection, and the trusted identity result.
- Reconcile same-binding connections by trusted `on_behalf_of`: replace an older same-identity
  connection, keep different identities independent, and surface cleanup-required authorization
  as a successful login with an explicit no-reauthorize warning.
- Preserve an existing alias and Session when same-alias authorization returns a different trusted
  identity; allocate and select a non-conflicting local alias for the new identity.
- Add user-only `/bailinghub connections list|add|use|remove` lifecycle commands with quoted-name
  parsing, new-session-only selection, existing-session pinning, and revoke-before-remove safety.
- Restore the SDK registry's current connection before the first new session or user command after
  restart, with validated public metadata and a non-blocking bootstrap-field fallback.
- Reconcile defaults after connection removal: adopt a remaining current profile, become
  unconfigured after the last removal, and preserve successful removal across registry refresh
  failures without disturbing a valid non-current default.
- Pin the stable public `bailinghub-mcp-server@0.3.0` SDK, including Windows CurrentUser DPAPI
  credential storage for Agent Session connections.

## 0.2.0 - 2026-08-26

- Add the native Cordis Agent Client adapter that keeps reasoning and orchestration in local DSH
  while BailingHub retains identity, context, capability governance, approval, recovery, and audit.
- Add browser authorization, isolated connection aliases, dynamic per-turn business tools,
  capability search, exact-invocation resume, and visible-only run completion through the generic
  `bailinghub-mcp-server/sdk` facade.
- Restrict host configuration to `hubUrl`, `clientAppId`, `workspace`, and `connectionName`; no
  business endpoint, Client Token, model key, or other secret is accepted by the plugin config.
- Preserve public `0.1.1` as the explicit static MCP/Client Token compatibility path rather than
  silently migrating its credentials or orchestration semantics.
- Pin `bailinghub-mcp-server@0.2.0` as an ordinary dependency so installing only this plugin also
  installs the exact compatible Agent Client SDK.
- Document the Core to MCP/SDK to DSH release order and the clean-profile browser-auth acceptance
  gate.

## 0.1.1 - 2026-08-18

- Make the project contract accept future SemVer releases while keeping package and lock versions aligned.
- Keep the npm landing page English-first and retain the Chinese guide under `docs/`.
- Document the exact release-update surface, focused compatibility smoke, and patch-release recovery path.

## 0.1.0 - 2026-08-18

- Add an installable DeepSeek Harness bundle for BailingHub.
- Expose the existing submit, get, and bounded-wait MCP tools under the `bailinghub` namespace.
- Pin `bailinghub-mcp-server@0.1.1` and keep route and credentials outside model arguments.
