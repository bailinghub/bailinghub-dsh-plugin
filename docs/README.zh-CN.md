# BailingHub for DeepSeek Harness

[English](../README.md) | 简体中文

让本地 DeepSeek Harness 智能体操作已经接入 BailingHub 的业务系统：查询记录、修改允许的字段，
需要审批时继续走原有规则。BailingHub 会记录用了哪份授权、做了什么，以及业务系统返回的结果。

**0.4.0 支持在一个会话中使用同一系统的多份授权。** 例如，分别授权 A 店和 B 店后，新建会话并
选中两者，就可以说：

> 对比今天 A 店和 B 店的营业情况，按门店分别说明。

智能体会为每次调用选择对应授权，不需要你反复切换当前连接。具体能查什么、能改什么，仍取决于
业务系统开放的能力和各账号权限。本版尚不提供不同系统或不同路由之间的编排。

本版也能把可见沟通过程与业务操作关联起来。记录上传失败后，可以在联网或重启后继续补传，
不会因此重新执行业务操作。

这是独立社区集成，不是 DeepSeek 官方开发、认证、合作、背书或推荐的插件。

## 安装与开始使用

需要 Node.js `22.19.0+` 或 `24+`、pnpm，以及兼容的 DeepSeek Harness。管理员应先完成业务系统
接入。配套版本为 **BailingHub Core 0.6.0 → BailingHub MCP/SDK 0.4.0 → 本插件 0.4.0**。

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-bailinghub@0.4.0
```

插件会自动安装精确依赖 `bailinghub-mcp-server@0.4.0`，无需另装 SDK。
已经使用旧版的用户请先看[0.3 到 0.4 的迁移步骤](MIGRATION_VNEXT.md)。

按照[开始使用指南](GETTING_STARTED.zh-CN.md)填写管理员提供的四项公开连接信息，再到浏览器授权。
不要把业务密码、Client Token、签名密钥或模型 Key 填进插件设置或聊天消息。

## 为每个会话选择账号

在原业务授权页面分别授权 A 店和 B 店。创建连接时使用清晰的本机名称，例如 `A 店`、`B 店`，
并在授权页核对实际业务身份。名称是你提供的标签，不证明身份，也不授予权限；`default`、
`default-2` 无法让智能体知道你指的是哪家店。

**新建会话，在发送第一条消息前**执行：

```text
/bailinghub connections list
/bailinghub scope set <A店连接键> <B店连接键>
/bailinghub scope
```

把占位符换成列表里的固定连接键，不是连接名称。也可以只选一份授权；多份授权必须属于同一个
中枢、Client App 和 workspace。等待设置成功回显后，再发送业务请求。

**新会话默认是普通聊天，选择业务范围后才会提供业务工具。** 登录成功或切换默认连接不会自动
开启业务访问。`/bailinghub scope none` 可显式选择普通聊天。第一条用户消息会固定这个范围；
之后要增减账号，或从普通聊天改成业务会话，都需要新建会话。

同一套能力不必为每家店重复声明。智能体选择每次调用使用的授权，不会拿到凭据；各项操作仍受
对应账号权限和审批规则约束。需要审批时，在会话仍运行的情况下，继续的是原调用。

任意一份选中授权撤销、被替换或暂时无法核验时，整个会话的业务访问暂停，不会偷偷改用其他账号。
临时断网可以在联网后重试原范围；已确认的撤销或身份变化，需要新建会话并选择有效授权。

## 查看沟通过程与操作结果

配合 Core 0.6.0 和 SDK 0.4.0，BailingHub 可以把可见的用户消息、助手回复、轮次，以及原业务
执行记录的关联放在同一份会话记录中。各份授权仍保留自己的业务调用记录，汇总回答不会复制到
每个账号的记忆中。

```text
/bailinghub archive status
/bailinghub archive sync
```

`archive status` 查看沟通记录是否已上传；`archive sync` 补传已保存记录，不重做业务操作。
它与 `/bailinghub sync` 不同：后者只重试当前运行中会话的待同步执行结尾记录。

| 状态 | 含义 |
| --- | --- |
| `synced` | 已保存事件已获中枢确认，不代表业务操作成功 |
| `pending` | 还没传完，恢复连接后可以重试 |
| `blocked` | 原授权核验阻止上传，可用 `/bailinghub scope` 查看 |
| `unsupported` | 当前 SDK 或中枢不支持这套归档契约 |
| `storage_error` | 本地写入失败，部分可见消息可能尚未安全保存 |
| `recovery_gap` | 对照 DSH 历史发现归档缺失，记录不完整 |

重开已保存的业务会话时，必须核验全部原授权后才恢复原范围。离线重开后，可以联网并在**同一
会话**执行 `/bailinghub archive sync` 或 `/bailinghub scope` 重试核验。这恢复的是范围与
已保存记录的补传，**不恢复进程重启前的业务调用、待审批操作或未完成任务**。未开始的已保存
草稿需要重新选择；没有有效旧范围快照的已开始会话不能自动采用今天的默认账号。

## 哪些信息会共享和保存

选中账号的业务上下文与可见用户请求会进入同一个本地智能体及模型会话。合并后的沟通归档按完整
授权集合控制访问，仅有其中一份授权不能读取混合会话。若这些账号的数据需要彼此隔离，应使用
不同会话。

采集从本版启用后的业务轮次开始，只包含可见文本，不包含附件、隐藏思考或全部历史会话，也不会
自动清除用户粘贴在正文里的秘密。检测到历史缺口会明确显示；宿主不提供持久历史时，覆盖度为
`unverified`，不会声称完整。

本机私有待上传记录含有**明文任务正文**，已上传的事件也会保留，直到宿主或用户自行清理；目前
没有自动保留期限。删除本机记录不等于删除中枢记录。授权凭据仍由 SDK 安全存储。启用业务访问前
请阅读[隐私说明](../PRIVACY.md)与[安全策略](../SECURITY.md)。

## 常用管理命令

| 命令 | 用途 |
| --- | --- |
| `/bailinghub doctor` | 检查配置、SDK、授权及 workspace，不输出凭据 |
| `/bailinghub login` | 在浏览器授权当前连接 |
| `/bailinghub status` | 查看当前连接的授权状态 |
| `/bailinghub connections list` | 查看连接名称、固定连接键和授权状态 |
| `/bailinghub connections add <名称> <中枢地址> <clientAppId> <workspace>` | 创建并选择一个待管理的连接；含空格的名称加引号 |
| `/bailinghub connections use <名称或连接键>` | 选择要管理或授权的连接，不改变已有会话范围 |
| `/bailinghub connections remove <名称或连接键>` | 先撤销远端 Agent Session，再删除本机凭据 |
| `/bailinghub workspaces` | 查看当前授权允许的 workspace |
| `/bailinghub use <workspace>` | 为连接管理切换到另一已授权 workspace |
| `/bailinghub logout` | 撤销并删除当前 Agent Session |

连接管理与范围选择都是用户命令，不是模型工具。再次授权同一可信身份会替换旧连接和旧 Agent
Session；不同身份独立保留。若登录提示需要清理，新连接已经授权成功，应检查提示的旧条目并重试
删除，不要再次授权。详情见[身份与连接规则](AGENT_CLIENT_CONTRACT.md#browser-identity-and-local-reconciliation)。

## 给接入开发者

DSH 负责思考与工具编排；BailingHub Core 负责可信身份、治理、审批、调用状态和审计；SDK 负责
浏览器授权、安全凭据和 HTTP 映射。本插件只适配 DSH 的会话、提示词、命令、工具和可见事件，
不直接调用业务 API，也不治理其他 DSH 工具。

业务系统继续声明原有能力，为每个身份分别授权即可。自定义 DSH 宿主需接入[范围选择与恢复 API](AGENT_CLIENT_CONTRACT.md#host-owned-session-scope-api)，
在首条消息前显示确认；原生斜杠命令已经使用这些 API。参数结构、持久化和恢复细节见
[Agent Client 契约](AGENT_CLIENT_CONTRACT.md)。

请使用 Native Tool Mode。DSH Code Mode 无法安全呈现本轮动态工具结构，因此明确降级。
版本范围见[兼容矩阵](COMPATIBILITY.md)。

## 旧版 0.1.1 与反馈

公开 `dsh-bailinghub@0.1.1` 继续作为独立的静态 MCP 兼容路径：它启动
`bailinghub-mcp-server@0.1.1`，使用运营者提供的固定路由 Client Token，由 BailingHub 编排。
0.4.0 不会读取或转换该凭据。使用旧路径时继续固定旧版本，并参考[迁移说明](MIGRATION_VNEXT.md)。

问题请提交到 [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues)，提供版本与
脱敏错误，不附带 Token、私有地址、个人信息或生产业务数据。兼容测试与下载量不代表生产采用。
