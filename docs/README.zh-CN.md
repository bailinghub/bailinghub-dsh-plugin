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

> **当前稳定版本线：**`dsh-bailinghub@0.3.0` 使用下文说明的原生 Agent Client 流程。
> 公开 `0.1.1` 仅作为明确的静态 MCP 兼容路径继续保留。
> 下文的同系统多授权选择属于**尚未发布的源码候选能力**，安装公开 `0.3.0` 不会获得该能力。

希望用最短路径完成首次使用，可以直接阅读[三分钟开始使用](GETTING_STARTED.zh-CN.md)。

## 0.3 Agent Client 的关系

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

## 安装 0.3 版本线

前置条件：

- Node.js `22.19.0+` 或 `24+`；
- `pnpm` 与兼容矩阵中列出的 DeepSeek Harness 版本；
- 已完成上面的 BailingHub 接入准备。

将精确稳定版本安装到 DSH Web Profile：

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-bailinghub@0.3.0
```

`dsh-bailinghub@0.3.0` 会自动安装精确兼容的 `bailinghub-mcp-server@0.3.0` 依赖。
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
页面地址、业务域名或任何凭据。中枢会根据 Client App 找到唯一业务授权入口。
`connectionName` 只是用户控制的本机连接选择器，不是账号、租户或身份声明。

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
| `/bailinghub connections use <名称或连接键>` | 修改 registry 默认连接；候选会话仍须显式选择业务范围 |
| `/bailinghub connections remove <名称或连接键>` | 先远程撤销 Agent Session，再删除本机凭据和公开元数据 |
| `/bailinghub login` | 在浏览器授权当前 Hub/client/workspace |
| `/bailinghub status` | 查看当前连接状态，但不输出凭据 |
| `/bailinghub workspaces` | 查看当前业务授权允许使用的 workspace |
| `/bailinghub use <workspace>` | 把连接管理所用 workspace 切换到另一个已授权 workspace |
| `/bailinghub sync` | 重试同步待处理的可见回复，不重复业务工具调用 |
| `/bailinghub logout` | 撤销并删除当前 Agent Session |

插件四字段是启动连接。其他连接可用 `connections add` 登记；BailingHub 控制台“智能体客户端”
页面也能生成同样的不含秘密命令。适配器为连接管理读取 SDK registry，并采用其中当前连接的
公开元数据；registry 缺失或不可用时，这些命令继续使用四个启动字段，不会选择候选会话范围。
连接名含空格时需要加引号。执行 `connections use` 后，如果该绑定尚未授权，再执行
`/bailinghub login`。

连接管理和默认连接选择仍只能由用户斜杠命令发起，不会作为模型工具暴露。公开 `0.3.0` 为之后
创建的会话采用当前连接，并把每个会话固定到一份连接。未发布候选中，这些命令不会为任何会话
开启业务访问；必须按下文规则显式选择会话范围。registry 或启动字段回退只用于连接管理，不能
用于恢复失败的会话范围。`/bailinghub use <workspace>` 是另一件事：只有当前 Agent
Session 已经允许目标 workspace 时才成功。

删除当前连接后，适配器会读取 SDK registry，把剩余的当前连接（包括没有别名的连接）设为连接
管理默认值；删除最后一个连接后则明确进入未配置状态。删除后的 registry 刷新失败不会把已经成功的
删除改写成错误；如果删除的是非当前连接，刷新不可用时也会保留仍然有效的默认连接。

对于同一个 `Hub + clientAppId + workspace` 公开绑定，最终身份由业务授权页及其可信
`on_behalf_of` 结果决定。如果另一个本机连接名已经授权同一身份，SDK 会用本次连接覆盖旧连接，
并撤销旧 Agent Session；不同可信身份则继续作为相互独立的连接。如果从一个已经属于其他身份的
`connectionName` 发起登录，SDK 会保留原连接名及其 Session，为新身份分配一个不冲突的本机名称
（例如 `default-2`），并把新连接设为 registry 当前连接。用户可以用 `connections list` 查看
两者，再用 `connections use <名称或连接键>` 显式切换。如果登录结果返回
`cleanupRequired: true`，说明新连接仍然授权成功，但一个或多个同绑定旧连接还需要显式清理；
如果身份检查被推迟，此时还不能断言它们是同一身份。不要重复授权；先查看 `connections list`，
再对提示的旧连接执行
`/bailinghub connections remove <名称或连接键>`。

公开 `0.3.0` 首次验收时，新建一个 DSH 会话，先做一次只读查询，再做一次允许的修改。确认 BailingHub
后台能看到同一个会话、run、可见最终回复和工具调用轨迹。需要审批的能力必须在审批后恢复
原 invocation，不能生成替代业务调用。
测试源码候选时，必须先为新会话选择业务范围，等待宿主成功回显，再发送第一条请求。

本版本在 DSH Code Mode 下会明确降级，因为当前 Code Mode 无法安全呈现本轮动态 Schema。
需要执行受治理业务操作时应使用 Native Tool Mode。

## 未发布源码候选：同一系统，多份授权

候选能力允许用户显式选择同一个会话可使用的业务账号，所选授权必须属于同一
`Hub + clientAppId + workspace`。例如，智能体为两份选中授权分别调用报表工具，再汇总比较结果。
本次范围不包括不同中枢、Client App 或 workspace，也不要求修改业务侧已有能力声明。
业务接入方继续沿用现有 SDK 流程，为各身份分别完成授权；本次能力的首个消费端是 DSH 插件
源码候选。
对象名称来自现有本机 `connectionName`，不会解码 Token 推导业务名称，也没有新增 Core 可信
身份展示名字段。应以清晰名称创建连接，再通过原业务授权页分别授权对应身份；`default` 和
`default-2` 这样的名称不能让模型猜测用户要操作哪个账号。

**本候选改变默认行为。** 新会话未选择范围，或显式选择空数组 `[]` 时，都只进行普通聊天：
不启动 BailingHub run，不暴露 BailingHub 业务工具。登录成功、切换默认连接都不会选中会话
业务范围。原生 DSH 用户可在第一条用户消息前执行：

```text
/bailinghub connections list
/bailinghub scope set <连接键> [<另一连接键> ...]
/bailinghub scope
```

用 `/bailinghub scope none` 显式选择普通聊天。占位符须替换为列表中的固定连接键，不接受别名；
等待范围设置成功回显后再发送消息。这些命令仅属于源码候选，不会启动业务 run 或采用默认连接。
第一条消息发送前，宿主必须调用 `setSessionScope(sessionId, { connectionKeys,
expectedRevision })`，等待成功并回显确认的范围；`getSessionScope` 用于读取状态。
原生命令也使用该 API；没有这些命令或范围选择界面的嵌入宿主需要接入
[宿主 API](AGENT_CLIENT_CONTRACT.md#host-owned-session-scope-api)，
不能用 `connections use` 替代。

只选一个连接键时保留原有 typed 业务参数与结果；选中多个键时才使用下文的共享工具 envelope。
目录只包含用户显式选中的授权，向模型提供本会话 `authorization_ref`、脱敏本机名称及可用状态。
名称只是显示数据，不是可信身份声明。宿主收到第一条用户消息时，范围立即冻结；之后增减或
替换账号，以及在普通聊天与业务模式间切换，都需要由 UI 新建会话。

任何选中系统收到用户输入前，会先验证整组选中授权。任意一份授权失效、撤销、被替换或无法
检查时，整个会话的业务访问暂停，不会改用默认连接，也不会自动缩小为剩余有效授权。需要调整
范围时，新建会话并显式选择有效授权。

声明相同的业务工具只注册一次。在多授权会话里，模型在原业务参数外选择本次授权：

```json
{
  "authorization_ref": "<本会话目录提供的引用>",
  "arguments": { "date": "2026-09-08" }
}
```

适配器把该引用解析为已记录的 SDK 连接，不让模型填写凭据、原始连接键、路由或业务身份。
只有一份授权的会话保留原业务参数形式。活跃业务工具总预算仍是 12 个；同名工具的描述、
Schema 或治理声明冲突时不会合并执行。工具声明相同也不代表权限相同，仍按所选授权检查可用
范围。能力搜索可指定一份 `authorization_ref`，省略时搜索本会话全部授权。

每一轮用户输入会分别为各份授权启动 Core run，让模型在选择操作前获得各自规则与上下文。
上下文和工具结果保留授权标记；本轮可见用户输入会到达各份授权对应的 run。需要彼此隔离、
不能共同提供给本地智能体的身份不应放在同一个会话。恢复操作绑定原 invocation、原授权和原
run，即使中间使用了另一份授权，也不会改变恢复目标。授权过期或撤销时不会自动改用其他连接。
传输操作前会核对固定连接键、workspace 和原 Agent Session id；Agent Session 被替换后须新建
会话。原调用绑定支持同一运行中会话跨轮恢复，不会持久化为进程重启后或新会话的恢复凭据。

默认适配器在 DSH home 下保存非秘密范围快照，使用 revision 校验、跨进程锁及原子文件替换。
重开会话的宿主必须先等待 `restoreSessionScope(sessionId)` 完成并显示状态，再发送消息。
有效且已锁定的快照会在验证后恢复原范围；未锁定的已保存草稿必须重新显式选择，不会自动启用或
检查原授权。即使替换范围的首次落盘失败、旧草稿仍在磁盘上，这条规则也不变。只有配置或元数据
历史的草稿不算已开始，可以在第一条用户消息前继续选择范围。已开始会话缺少有效快照时暂停
业务访问，不会采用当前 registry 默认连接。范围恢复不等于恢复原
invocation、审批或未完成任务。嵌入宿主可注入持久化 `scopeStore`；显式内存适配器不提供重启恢复。

跨授权汇总的最终回答留在 DSH；各 Core run 只接收自身业务调用的确定性摘要，不接收包含其他
授权结果的汇总回答。详见[候选契约](AGENT_CLIENT_CONTRACT.md#unreleased-same-system-authorization-selection)
与[隐私边界](../PRIVACY.md#unreleased-same-system-authorization-selection)。

## 安全与隐私边界

- 模型不能通过工具参数填写 Hub URL、workspace、原始连接键、业务身份、凭据、审批结论或
  能力版本；未发布候选只允许选择宿主为本会话公开的授权引用；
- SDK 在 macOS 使用 Keychain；Windows 凭据文件保存在 LocalAppData 并由 CurrentUser DPAPI
  保护，Windows PowerShell 或 DPAPI 不可用时失败关闭，不会降级为明文；Linux 与其他 POSIX
  系统必须显式启用安全文件回退；
- BailingHub 对每次治理调用重新校验身份、scope、审批、幂等与调用状态，业务系统仍执行
  最终权限判断；
- 适配器会发送可见用户输入与受治理工具参数/结果。公开 `0.3.0` 发送可见最终回复；候选在
  多授权会话中改为分别发送各自调用摘要，不会上传隐藏思考片段；
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

0.3 Agent Client 不会自动读取或迁移 0.1 Client Token。测试升级或回滚时必须显式固定版本，
并遵循 [0.1 到 0.3 的迁移边界](MIGRATION_VNEXT.md)。

## 兼容范围与反馈

0.3.0 只对 [COMPATIBILITY.md](COMPATIBILITY.md) 中列出的版本完成了验证。DeepSeek
Harness 仍是 Developer Preview，每次 Harness 升级都必须重新执行 Native Lifecycle Smoke。

问题请提交到 [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues)。
请勿附带 Token、私有部署地址、个人信息或生产业务数据。
