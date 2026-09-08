# Changelog

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
