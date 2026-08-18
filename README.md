# BailingHub for DeepSeek Harness

[简体中文](docs/README.zh-CN.md) | English

Run governed tasks from DeepSeek Harness against a business route already connected to
BailingHub, then track the same job and read its available result. You can do this from the
Harness Web UI on your own computer without opening the embedded chat page in each business
backend.

This is an independent community integration. It is not developed, certified, endorsed, or
recommended by DeepSeek.

## What You Get

After installation, DeepSeek Harness discovers three native tools:

| Harness tool | What it does |
| --- | --- |
| `mcp__bailinghub__submit_governed_job` | Submit task text with a stable request ID |
| `mcp__bailinghub__get_governed_job` | Read the current state and public result of one job |
| `mcp__bailinghub__wait_for_governed_job` | Wait briefly for the same job without resubmitting it |

BailingHub remains the control plane between the model and the business system. The URL,
Client Token, and route are operator configuration, not model arguments. The model cannot
switch to another route or supply administrator, executor, approval, or business-system
credentials through these tools.

## Install

Prerequisites:

- Node.js `22.19.0+` or `24+`;
- `pnpm` and `@deepseek-ai/dsh@0.1.0-rc.7`;
- a reachable [BailingHub deployment](https://github.com/bailinghub/bailinghub#quick-start);
- one BailingHub Client Token restricted to the route you want this Harness profile to use.

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.0-rc.7
dsh plugin --profile web add dsh-bailinghub@0.1.1
```

Configure the process that starts Harness:

```bash
export BAILINGHUB_BASE_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_TOKEN='replace-with-a-route-scoped-client-token'
export BAILINGHUB_ROUTE='order_assistant'
```

Then verify the composed profile and start the local Web UI:

```bash
dsh --profile web --dump-config
dsh web
```

The default Web UI is local to your computer. Ask Harness to submit a task through
BailingHub, preserve the returned `job_id`, and wait for or query that same job.

For a first try, use a task supported by your configured route and say explicitly: submit it
once with a stable `request_id`, preserve the returned `job_id`, and query that same job if a
bounded wait times out.

## Correct Task Flow

1. Generate one stable `request_id` for one business request.
2. Call `mcp__bailinghub__submit_governed_job` once.
3. Preserve its `job_id`.
4. Call `wait_for_governed_job`, or call `get_governed_job` later.
5. A wait timeout is not a failed task. Do not submit a replacement request.

## Identity and Permission Boundary

Using the local Harness UI removes the need to open a business backend's embedded chat UI;
it does **not** turn the Harness login or local user into a trusted business identity.
The current `0.1.x` bundle deliberately does not accept an acting subject as tool input. A route or
downstream business system must still resolve trusted identity and perform final
authorization. If the selected action requires identity that the configured path cannot
establish, it should remain unavailable or be rejected.

This bundle governs only tasks submitted through its three BailingHub tools. It does not
intercept or govern every other tool installed in DeepSeek Harness.

## Supply-Chain Note

This bundle contains no custom runtime JavaScript, no production dependencies, and no
install scripts. When Harness starts the bundle, its built-in MCP Client runs the pinned
command `npx -y --package=bailinghub-mcp-server@0.1.1 bailinghub-mcp-server` outside the
agent sandbox. The first start may
need npm network access. Review and pin the package before using it in a sensitive
environment; production images may pre-cache the exact version.

Non-loopback HTTP is rejected by the MCP server by default. Only set
`BAILINGHUB_ALLOW_INSECURE_HTTP=true` on a controlled private network where TLS terminates at
another trusted boundary.

## Compatibility and Feedback

The first release is verified against DeepSeek Harness `0.1.0-rc.7`,
`bailinghub-mcp-server@0.1.1`, and BailingHub Client API v1. Harness is still a developer
preview, so each Harness release requires a compatibility smoke test.

Report problems through [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues).
Never include tokens, private deployment URLs, personal information, or production business
payloads.
