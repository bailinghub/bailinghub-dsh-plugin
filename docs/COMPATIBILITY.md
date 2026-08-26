# Compatibility

| Component | Verified version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| DSH MCP Client | in-box version shipped by `0.1.0-rc.7` |
| BailingHub MCP Server | `0.1.1` |
| BailingHub Client API | `bailing.client-api.v1` |
| Node.js | `22.19.0+` |

DeepSeek Harness is currently a developer preview. Compatibility with another Harness release
must be rechecked before changing this table or the package's supported range.

The bundle uses DSH's in-box `@deepseek-ai/dsh-mcp-client`; it intentionally does not install a
second copy into the profile. The stdio child is pinned to `bailinghub-mcp-server@0.1.1`.

## Private vNext Candidate

| Component | Candidate target |
| --- | --- |
| DeepSeek Harness / Cordis lifecycle | `0.1.0-rc.7` |
| Tool presentation | native mode |
| BailingHub SDK facade | `bailinghub-mcp-server/sdk >= 0.2.0` |
| Agent Client Core | `bailing.agent-turn-context.v1` and related v1 schemas |

This table is private-candidate evidence, not a published compatibility promise. DSH Code Mode is
explicitly degraded because it cannot safely present the current-turn dynamic schemas in this
candidate. The SDK peer is optional at install time so Cordis can load and report a clear degraded
state when the facade is absent.
