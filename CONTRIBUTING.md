# Contributing

Keep this bundle narrow. Changes should improve DeepSeek Harness composition or compatibility;
generic BailingHub MCP behavior belongs in `bailinghub-mcp-server`, and BailingHub Core behavior
belongs in the main BailingHub repository.

Before opening a pull request:

```bash
npm ci
npm run verify
npm pack --dry-run
```

Never commit `.env` files, tokens, private deployment URLs, or production task data.
