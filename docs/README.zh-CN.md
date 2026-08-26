# BailingHub for DeepSeek Harness

[English](../README.md) | 简体中文

在电脑上的 DeepSeek Harness 里，通过 BailingHub 向已经接入的业务 route 发起受控任务，
并在同一会话中持续查看状态和可用结果，不必再进入每个业务后台里的嵌入聊天入口。

这是独立社区集成，不是 DeepSeek 官方开发、认证、合作、背书或推荐的插件。

## 私有 vNext 候选（未发布）

当前分支还包含一套 DSH 原生 Cordis Agent Client 私有候选：思考、工具选择与编排留在本地
DSH，可信身份、授权、候选能力裁剪、审批、受控调用与审计仍由 BailingHub Core 负责。它
不是现有“执行器”，也不是对公开 `0.1.x` 的静默升级。

下文公开 `0.1.x` 静态 MCP 的安装与使用说明保持不变。候选部署者只配置 `hubUrl`、
`clientAppId`、`workspace` 和本地 `connectionName`，最终用户不填写业务端点或任何
Secret。候选契约与迁移边界见 [AGENT_CLIENT_CONTRACT.md](AGENT_CLIENT_CONTRACT.md) 和
[MIGRATION_VNEXT.md](MIGRATION_VNEXT.md)。

## 使用者得到什么

安装后，DeepSeek Harness 会发现三个原生工具：

| Harness 工具 | 能力 |
| --- | --- |
| `mcp__bailinghub__submit_governed_job` | 使用稳定请求 ID 提交一项业务任务 |
| `mcp__bailinghub__get_governed_job` | 查询同一个任务的当前状态和公开结果 |
| `mcp__bailinghub__wait_for_governed_job` | 有界等待同一个任务，不重复提交 |

BailingHub 仍位于模型与业务系统之间。中枢地址、Client Token 和 route 都由运营者预先
配置，不是模型参数；模型不能借工具参数切换 route，也不能提交管理员凭据、执行器凭据、
审批结论或业务系统密钥。

## 安装

前置条件：

- Node.js `22.19.0+` 或 `24+`；
- 已安装 `pnpm` 与 `@deepseek-ai/dsh@0.1.0-rc.7`；
- 一套可访问的 [BailingHub](https://github.com/bailinghub/bailinghub#快速上手)；
- 一个只允许目标 route 的 BailingHub Client Token。

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.0-rc.7
dsh plugin --profile web add dsh-bailinghub@0.1.1
```

在启动 Harness 的终端或进程环境中配置：

```bash
export BAILINGHUB_BASE_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_TOKEN='替换为仅允许指定-route-的-client-token'
export BAILINGHUB_ROUTE='order_assistant'
```

检查最终配置，然后启动本机 Web 界面：

```bash
dsh --profile web --dump-config
dsh web
```

接下来可以直接要求 Harness 通过 BailingHub 提交任务、保存返回的 `job_id`，并等待或
查询同一个任务。

第一次尝试时，请选择当前 route 已支持的任务，并明确要求：使用稳定 `request_id` 只提交
一次，保存返回的 `job_id`；有界等待超时后，只查询同一个任务，不要重新提交。

## 正确任务流程

1. 为一项业务请求生成一个稳定的 `request_id`；
2. 只调用一次 `mcp__bailinghub__submit_governed_job`；
3. 保存返回的 `job_id`；
4. 短时调用 `wait_for_governed_job`，或者稍后调用 `get_governed_job`；
5. 等待超时不等于任务失败，不能因此重新提交一份替代任务。

## 身份与权限边界

使用本机 Harness 界面，省掉的是“必须打开业务后台聊天入口”这一步；它不代表 Harness
登录态或本机用户自动成为可信业务身份。当前 `0.1.x` Bundle 有意不接受模型传入行动主体。route 或
下游业务系统仍需解析可信主体并执行最终授权；如果目标动作必须具备业务身份，而当前接入
路径无法建立该身份，该动作就应保持不可用或被拒绝。

本 Bundle 只治理通过这三个 BailingHub 工具提交的任务，不会自动拦截 Harness 中安装的
其他工具。

## 供应链说明

这个 Bundle 没有自定义运行时代码、生产依赖和安装脚本。Harness 启动时，会由内置 MCP
Client 在 Agent 沙箱之外执行固定命令
`npx -y --package=bailinghub-mcp-server@0.1.1 bailinghub-mcp-server`。首次启动可能需要
访问 npm；敏感环境应审查并固定版本，生产镜像可提前缓存该精确版本。

MCP Server 默认拒绝非回环明文 HTTP。只有在受控私网中已经由其他可信边界终止 TLS 时，
才可设置 `BAILINGHUB_ALLOW_INSECURE_HTTP=true`。

## 兼容范围与反馈

首版验证范围为 DeepSeek Harness `0.1.0-rc.7`、`bailinghub-mcp-server@0.1.1` 与
BailingHub Client API v1。Harness 当前仍是 Developer Preview，升级 Harness 后应重新
执行兼容性 Smoke。

问题请提交到 [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues)。
请勿附带 Token、私有部署地址、个人信息或生产业务数据。
