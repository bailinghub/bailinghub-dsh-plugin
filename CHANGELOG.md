# Changelog

## Unreleased

- Add an image-first Local Agent attachment space for adapted hosts: list approved conversation
  outputs, upload 1–8 PNG/JPEG/WebP images to an explicitly selected authorization, and reuse
  ready URLs with existing business tools. Persist original upload records for recovery.
- See [attachment integration](docs/GENERATED_ARTIFACTS.md) for campaign artwork, charts
  and shop examples. Host file access is explicit; upload success and business action results
  are independent. Known business rate-window and resume-argument limits remain documented.

- Explain each search target’s returned candidates separately from the conversation’s
  currently loaded tools. Keep unknown totals explicit and describe the shared loading limit.
- Return actionable, safe failure feedback through native DSH dispatch, including retired
  tool names rejected before the business SDK. Valid loaded tools remain directly callable.
- Keep an unconfirmed write bound to its original invocation; discovery cannot create
  a replacement operation. Add read-only feedback seams for custom hosts.
- See [capability discovery and recovery](docs/CAPABILITY_FEEDBACK.md) for shop/inventory
  examples, compatibility and exact candidate installation requirements.

## 0.5.0 - 2026-09-10

### Shop and inventory in one conversation

See [release scenarios and upgrade steps](docs/RELEASE_NOTES_v0.5.0.md): check inventory, update a shop price and follow the listing result or approval. Business tools and confirmed product mappings are prerequisites.

- Show the business-supplied name of an authorized organization, account, project or other subject
  separately from its product's purpose. Keep local connection selectors independent and explicitly
  identify missing names, unsupported metadata and cached display data. Renames and duplicate names
  preserve original scope, Session, invocation and archive identities and historical labels.
- Understand each selected system's purpose before searching its tools. Read administrator-managed
  descriptions using the original authorization binding, consistently for one account, multiple
  accounts in one system, or multiple systems. Descriptions grant no permissions and create no runs.
- Distinguish unknown or not-yet-loaded capabilities from unavailable services. Missing metadata
  and older metadata APIs preserve existing business flows; identity failures still block the whole
  scope. Cancelled description requests cannot replace a newer turn's directory.
- Select authorized targets from different applications or workspaces on one Hub in the same
  conversation. The Agent discovers each target's capabilities only when needed; unrelated
  targets do not automatically receive the full user turn or load their context.
- Keep same-named capabilities from different systems separate. Each call and recovery retains
  its original connection, application, workspace, Session, run and invocation.
- Keep one visible conversation archive with independently verified target members. Persist
  cross-system scope/outbox v2 while retaining same-system v1 snapshots and APIs.
- Require explicit SDK/Core capability support for cross-system scope. Older combinations
  refuse the new mode while retaining existing same-system behavior.
- Pair with Core 0.7.0 and pin exact SDK 0.5.0. Preserve existing credentials, v1 scopes and original
  archive events; open a new conversation when choosing targets from different systems.
- Keep the same-Hub, same-audit-domain boundary. This is not a durable task scheduler, automatic
  product mapping, stock synchronization, cross-system transaction or business rollback engine.
- Retain the transitive Hono 4.13.7 update for upstream fixes.

See the [migration guide](docs/MIGRATION_VNEXT.md) for upgrading from 0.4.0 or an older native
version. Maintainer and synthetic compatibility checks are not independent production adoption.

## 0.4.0 - 2026-09-08

### For users

- Use independently authorized accounts for the same system in one conversation. Select Store A,
  Store B, or both before the first message; the Agent chooses the correct authorization for each
  available business tool without changing the global connection. Existing permissions and approvals
  still apply. Different Hubs, Client Apps, and workspaces are outside this release.
- **New conversations now default to ordinary chat.** Login and connection defaults no longer enable
  business access. Use `/bailinghub scope set <connection-key>...` and wait for confirmation before
  the first message; later selection changes require a new conversation. See the [migration guide](docs/MIGRATION_VNEXT.md).
- Follow visible user/assistant messages, turn boundaries, and links to original business runs in
  a separate conversation archive with Core 0.6.1. Multi-account runs keep their own call summaries;
  the combined reply is not broadcast into each account's memory. Hidden reasoning is excluded.
- Check `/bailinghub archive status` and retry `/bailinghub archive sync` after a failed upload or
  restart. Saved events retain their original identity; retries do not execute business actions again.
- Recover the original saved scope after an offline reopen on the same runtime once connectivity
  returns and every original authorization is valid. Revocation, identity replacement, and storage
  conflicts still block the whole scope. Scope restoration does not restore unfinished invocations,
  approvals, or tasks after a process restart.

### Reliability and integration

- Persist non-secret scope snapshots and a separate private visible-text outbox with revision checks,
  cross-process locks, and atomic file replacement. Expose host selection, restore, archive status,
  and archive sync APIs. Reopened unlocked drafts require explicit confirmation; started conversations
  without valid locked scope cannot adopt current defaults. Metadata alone does not lock a draft.
- Share matching typed business tools once. Multi-authorization calls use a host-issued reference
  outside the unchanged business arguments; single-authorization arguments remain unchanged. Keep
  the 12-tool total budget, reject conflicting declarations, and retain original invocation bindings
  across turns of the same live conversation.
- Preserve stable archive event ids, original run links, and acknowledgement cursors through ambiguous
  network retries. Report detectable missing history as `recovery_gap`, and unavailable history as
  unverified. Local write failures and unsaved events remain visible while uploads are blocked.
  Archive capability network failures report pending, not a false storage error.
- Recheck the original scope after asynchronous archive capability discovery and opening, so a
  revocation confirmed during that work cannot return a misleading synchronized status or allow upload.
  Concurrent business and archive callers wait for the current whole-scope validation.
- Keep cancelled turns ended when their original run response arrives late. Retain only the original
  audit link, without reactivating tools, dispatching remaining members, or replacing a newer turn.
- Pin exact `bailinghub-mcp-server@0.4.0`. Injected older SDKs retain business operations with an
  explicit unsupported archive status. Keep the separate public `0.1.1` static MCP path unchanged.

The archive stores plaintext visible task text locally, including acknowledged events, until the
host/operator removes it. It does not export all past conversations or attachments. Review
[Privacy](PRIVACY.md) before enabling business scope; release verification is not production adoption.

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
