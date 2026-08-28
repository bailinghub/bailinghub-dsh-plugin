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
>
> **未发布候选能力：**下文的 `connections list|add|use|remove` 命令目前只存在于本开发分支，
> 需要配套 SDK 候选版本；公开 `0.2.0` 暂不包含这些命令。

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
  Hub/client/workspace 选择连接和映射 HTTP DTO。
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
4. 在中枢 Client App 上配置一个稳定且不绑定具体账号、租户的业务授权入口，并在该 route
   后方接通受治理的 ACC/Tool Provider 能力。登录、切换账号和选择租户都由业务授权页完成。

最终用户**不需要**在插件中填写业务 API 地址、业务账号密码、Tool Provider 签名密钥、
BailingHub Client Token 或模型提供方 Key。

## 安装 0.2 版本线

前置条件：

- Node.js `22.19.0+` 或 `24+`；
- `pnpm` 与兼容矩阵中列出的 DeepSeek Harness 版本；
- 已完成上面的 BailingHub 接入准备。

将精确稳定版本安装到 DSH Web Profile：

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
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
| `connectionName` | `BAILINGHUB_CONNECTION_NAME` | 用户选择的本机连接名称 | 否 |

使用中性占位值的示例：

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='order_assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

也可以通过 DSH 的插件设置界面填写同样四个字段。不要在 Cordis Patch 中增加 Token、授权
页面地址、业务域名或任何凭据。中枢会根据 Client App 找到唯一业务授权入口。在未发布候选版
中，`connectionName` 只是用户控制的本机连接选择器，不是账号、租户或身份声明。

启动前检查最终合成配置：

```bash
dsh --profile web --dump-config
dsh web
```

## 浏览器授权与使用

在 DSH 中依次执行：

```text
/bailinghub login
/bailinghub doctor
/bailinghub status
/bailinghub workspaces
```

`login` 会在系统浏览器打开中枢管理员配置的唯一业务授权入口。业务授权页负责登录、切换账号、
选择租户，并确认最终业务身份和申请的 workspace，然后返回受 `state` 与 PKCE S256 保护的
随机回环回调。Access Token 与 Refresh Token 只进入 SDK 所有的安全存储，不会写入插件配置，
也不会由命令输出。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/bailinghub doctor` | 在不输出凭据的前提下检查宿主 API、公开配置、SDK、授权状态和 workspace 连通性 |
| `/bailinghub connections list` | 查看本机公开连接元数据与授权状态，不输出 Token |
| `/bailinghub connections add <名称> <中枢地址> <clientAppId> <workspace>` | 创建并选择另一个本机连接实例；公开绑定可以与已有实例相同 |
| `/bailinghub connections use <名称或连接键>` | 只为之后新建的会话选择一个已登记连接 |
| `/bailinghub connections remove <名称或连接键>` | 先远程撤销 Agent Session，再删除本机凭据和公开元数据 |
| `/bailinghub login` | 在浏览器授权当前 Hub/client/workspace |
| `/bailinghub status` | 查看当前连接状态，但不输出凭据 |
| `/bailinghub workspaces` | 查看当前业务授权允许使用的 workspace |
| `/bailinghub use <workspace>` | 为新会话切换到另一个已授权 workspace |
| `/bailinghub sync` | 重试同步待处理的可见回复，不重复业务工具调用 |
| `/bailinghub logout` | 撤销并删除当前 Agent Session |

插件四字段是启动连接。其他连接可用 `connections add` 登记；BailingHub 控制台“智能体客户端”
页面也能生成同样的不含秘密命令。连接名含空格时需要加引号。执行 `connections use` 后，如果该
绑定尚未授权，再执行 `/bailinghub login`。

连接选择只能由用户斜杠命令发起，不会作为模型工具暴露。切换只影响之后创建的 Agent 会话，已有
会话继续固定在原连接与 workspace。`/bailinghub use <workspace>` 是另一件事：只有当前 Agent
Session 已经允许目标 workspace 时才成功。

对于同一个 `Hub + clientAppId + workspace` 公开绑定，最终身份由业务授权页及其可信
`on_behalf_of` 结果决定。如果另一个本机连接名已经授权同一身份，SDK 会用本次连接覆盖旧连接，
并撤销旧 Agent Session；不同可信身份则继续作为相互独立的连接。如果登录结果返回
`cleanupRequired: true`，说明新连接仍然授权成功，但一个或多个同绑定旧连接还需要显式清理；
如果身份检查被推迟，此时还不能断言它们是同一身份。不要重复授权；先查看 `connections list`，
再对提示的旧连接执行
`/bailinghub connections remove <名称或连接键>`。

首次验收时，新建一个 DSH 会话，先做一次只读查询，再做一次允许的修改。确认 BailingHub
后台能看到同一个会话、run、可见最终回复和工具调用轨迹。需要审批的能力必须在审批后恢复
原 invocation，不能生成替代业务调用。

本版本在 DSH Code Mode 下会明确降级，因为当前 Code Mode 无法安全呈现本轮动态 Schema。
需要执行受治理业务操作时应使用 Native Tool Mode。

## 安全与隐私边界

- 模型不能通过工具参数选择 Hub URL、workspace、本机连接、业务身份、凭据、审批结论或能力版本；
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
