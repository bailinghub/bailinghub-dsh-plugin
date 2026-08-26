# Changelog

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
