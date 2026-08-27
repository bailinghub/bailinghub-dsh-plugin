# BailingHub for DeepSeek Harness

[English](../README.md) | 简体中文

把商城、SaaS 或其他业务系统接到 BailingHub 后，本地 DeepSeek Harness 智能体就能直接操作
它们的后台：查询数据、修改资料，或者执行系统已经开放的其他操作。实际能做什么仍由当前业务
账号权限和审批规则决定，执行过程也会记录在 BailingHub 中。

具体能做什么取决于业务系统开放了哪些能力，例如：

- 查询订单、客户、商品或员工资料；
- 修改允许编辑的字段或业务状态；
- 完成其他已经授权的后台操作；
- 把结果返回到本地对话，同时在 BailingHub 中保留对应的工具步骤。

思考、工具选择与编排留在本地 DSH；BailingHub 负责向本地智能体提供已授权的业务上下文、
可用能力、审批状态、调用恢复与审计记录。

这是独立社区集成，不是 DeepSeek 官方开发、认证、合作、背书或推荐的插件。

> **当前稳定版本线：**`dsh-bailinghub@0.2.0` 使用下文说明的原生 Agent Client 流程。
> 公开 `0.1.1` 仅作为明确的静态 MCP 兼容路径继续保留。

希望用最短路径完成首次使用，可以直接阅读[三分钟开始使用](GETTING_STARTED.zh-CN.md)。

## 0.2 Agent Client 的关系

```text
DeepSeek Harness 本地智能体
  -> dsh-bailinghub 原生 Cordis 适配器
  -> bailinghub-mcp-server/sdk
  -> BailingHub Agent Auth + Agent API
  -> 部署者选择的业务接入与最终业务授权
```

各层职责保持独立：

- **BailingHub Core** 负责 Agent Auth、可信业务身份、运行时上下文、知识库与记忆投影、
  能力治理、审批、调用状态和审计记录。
- **`bailinghub-mcp-server/sdk`** 负责浏览器登录、PKCE、凭据存储与刷新，以及按
  Hub/client/workspace 隔离连接和映射 HTTP DTO。
- **`dsh-bailinghub`** 只负责 DSH 会话、提示词、命令和动态工具生命周期，不保存凭据，
  也不直接调用业务 API。

Agent Client 不是 BailingHub 现有的“执行器”。执行器接收中枢任务并处理必须靠近某台机器
完成的工作；Agent Client 则把交互式思考与编排循环放在用户本地 DSH 智能体中。

## 安装前准备

部署者和业务接入开发者需要先在自己的 BailingHub 中准备这些公开标识：

1. 一套可访问的 HTTPS BailingHub，并部署匹配版本的 Agent Auth 与 Agent API；
2. 一个公开 Agent Client 应用标识 `clientAppId`；
3. 至少一个允许授权的 workspace；在 Agent Client v1 中，workspace id 就是
   BailingHub route id；
4. 该 route 后方已经接通业务授权页面，以及受治理的 ACC/Tool Provider 能力。

最终用户**不需要**在插件中填写业务 API 地址、业务账号密码、Tool Provider 签名密钥、
BailingHub Client Token 或模型提供方 Key。

## 安装 0.2 版本线

前置条件：

- Node.js `22.19.0+` 或 `24+`；
- `pnpm` 与 DeepSeek Harness `0.1.0-rc.7`；
- 已完成上面的 BailingHub 接入准备。

将精确稳定版本安装到 DSH Web Profile：

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.0-rc.7
dsh plugin --profile web add dsh-bailinghub@0.2.0
```

`dsh-bailinghub@0.2.0` 会自动安装精确兼容的 `bailinghub-mcp-server@0.2.0` 依赖。
DSH 用户不应该再自行猜测或单独安装某个 SDK 版本。

## 配置一个中枢连接

原生插件只有四个宿主配置字段：

| 插件字段 | 环境变量 | 含义 | 是否 Secret |
| --- | --- | --- | --- |
| `hubUrl` | `BAILINGHUB_HUB_URL` | 开发者自己部署的 BailingHub 公共 HTTPS 地址 | 否 |
| `clientAppId` | `BAILINGHUB_CLIENT_APP_ID` | 在该中枢注册的公共 Agent Client 应用标识 | 否 |
| `workspace` | `BAILINGHUB_WORKSPACE` | 初始已授权 workspace/route id | 否 |
| `connectionName` | `BAILINGHUB_CONNECTION_NAME` | 当前 SDK 隔离连接的本地别名 | 否 |

使用中性占位值的示例：

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='order_assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

也可以通过 DSH 的插件设置界面填写同样四个字段。不要在 Cordis Patch 中增加 Token、授权
页面地址、业务域名或任何凭据。

启动前检查最终合成配置：

```bash
dsh --profile web --dump-config
dsh web
```

## 浏览器授权与使用

在 DSH 中依次执行：

```text
/bailinghub login
/bailinghub status
/bailinghub workspaces
```

`login` 会打开系统浏览器。业务侧授权页面负责确认当前已登录的业务身份和申请的
workspace，然后返回受 `state` 与 PKCE S256 保护的随机回环回调。Access Token 与 Refresh
Token 只进入 SDK 所有的安全存储，不会写入插件配置，也不会由命令输出。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/bailinghub login` | 在浏览器授权当前 Hub/client/workspace |
| `/bailinghub status` | 查看当前连接状态，但不输出凭据 |
| `/bailinghub workspaces` | 查看当前业务授权允许使用的 workspace |
| `/bailinghub use <workspace>` | 为新会话切换到另一个已授权 workspace |
| `/bailinghub sync` | 重试同步待处理的可见回复，不重复业务工具调用 |
| `/bailinghub logout` | 撤销并删除当前 Agent Session |

标准 v1 登录只申请当前配置的 workspace。`use` 只有在当前 Agent Session 明确包含目标
workspace 时才会成功，不能借此任意切换中枢 route。当前命令始终使用这个插件实例配置的四个
字段，不接受连接别名选择器。连接另一套 Hub 或 route 时，应使用第二个 DSH Profile/插件实例，
或修改四字段并重新加载当前 Profile；设置新的 `connectionName` 后再完成浏览器授权。

首次验收时，新建一个 DSH 会话，先做一次只读查询，再做一次允许的修改。确认 BailingHub
后台能看到同一个会话、run、可见最终回复和工具调用轨迹。需要审批的能力必须在审批后恢复
原 invocation，不能生成替代业务调用。

本版本在 DSH Code Mode 下会明确降级，因为当前 Code Mode 无法安全呈现本轮动态 Schema。
需要执行受治理业务操作时应使用 Native Tool Mode。

## 安全与隐私边界

- 模型不能通过工具参数选择 Hub URL、workspace、身份、凭据、审批结论或能力版本；
- SDK 在 macOS 使用 Keychain；Linux 与其他 POSIX 系统必须显式启用安全文件回退；0.2.0
  暂不支持 Windows Agent Session 凭据存储；
- BailingHub 对每次治理调用重新校验身份、scope、审批、幂等与调用状态，业务系统仍执行
  最终权限判断；
- 适配器会发送 Agent Client 契约所需的可见用户输入、受治理工具参数/结果和可见最终回复，
  但不会上传隐藏思考片段；
- 本插件只治理它注册的 BailingHub 工具，不会拦截 DSH 其他工具或模型提供方流量。

生产使用前请阅读[安全策略](../SECURITY.md)、[隐私说明](../PRIVACY.md)、
[Agent Client 契约](AGENT_CLIENT_CONTRACT.md)和[兼容范围](COMPATIBILITY.md)。

## 公开 0.1.x 静态兼容模式

公开 `dsh-bailinghub@0.1.1` 仍是不可变的纯配置 Bundle。它通过 DSH 内置 MCP Client 启动
`bailinghub-mcp-server@0.1.1`，把运营者提供的一个 Client Token 固定绑定到一个 route，
并由 BailingHub 完成编排。

```bash
dsh plugin --profile web add dsh-bailinghub@0.1.1

export BAILINGHUB_BASE_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_TOKEN='replace-with-a-route-scoped-client-token'
export BAILINGHUB_ROUTE='order_assistant'
```

它只暴露三个固定工具：

```text
mcp__bailinghub__submit_governed_job
mcp__bailinghub__get_governed_job
mcp__bailinghub__wait_for_governed_job
```

0.2 Agent Client 不会自动读取或迁移 0.1 Client Token。测试升级或回滚时必须显式固定版本，
并遵循 [0.1 到 0.2 的迁移边界](MIGRATION_VNEXT.md)。

## 兼容范围与反馈

0.2.0 只对 [COMPATIBILITY.md](COMPATIBILITY.md) 中列出的版本完成了验证。DeepSeek
Harness 仍是 Developer Preview，每次 Harness 升级都必须重新执行 Native Lifecycle Smoke。

问题请提交到 [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues)。
请勿附带 Token、私有部署地址、个人信息或生产业务数据。
