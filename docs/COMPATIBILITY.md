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
