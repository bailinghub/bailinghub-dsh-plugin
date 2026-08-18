# Security Policy

Report vulnerabilities through a private GitHub Security Advisory in this repository.
Do not put tokens, private deployment URLs, personal information, or raw business payloads
in a public issue.

## Boundary

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
