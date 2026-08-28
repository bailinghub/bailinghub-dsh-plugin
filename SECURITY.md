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

## Native 0.2.0 boundary

The native 0.2.0 plugin accepts only `hubUrl`, `clientAppId`, `workspace`, and
`connectionName`. The generic SDK owns browser authorization, refresh, and secure credential
storage; business endpoints and final authorization remain Core/business-system concerns. The
Hub Client App owns one business authorization entry. That business page, not the plugin or model,
handles login, account switching, tenant selection, and the trusted `on_behalf_of` identity.

The unreleased multi-connection candidate stores only public Hub/client/workspace metadata in its
registry. `connectionName` is a user-only local selector, not an identity claim. After browser
authorization, the SDK replaces an older same-binding connection only when the trusted
`on_behalf_of` matches; different trusted identities remain isolated. If inspection or old-Session
revocation is uncertain, the new connection stays authorized and explicit cleanup is required.
Connection add/use/remove are user slash commands, not model tools. Removing an authorized
connection is remote-revoke-first and keeps the local credential if revocation fails, so it cannot
falsely report a complete logout.

Tools are Agent/run scoped. Message ids are replaced by Core-safe hash aliases, invocation ids are
stable 64-character digests, and an `accepted_unknown` outcome must resume that exact invocation
instead of creating a replacement. Completion retries are bounded and reuse one frozen,
visible-only payload. Version 0.2.0 installs `bailinghub-mcp-server@0.2.0` as an exact ordinary
dependency and resolves its `./sdk` export. It does not depend on ambient modules, an optional
peer, a range, a dist-tag, or a local path. Public `0.1.1` does not provide that facade.
