# 宿主任务关联与只读回执候选

这是本地集成候选，包版本仍为 0.5.0；同版本的公开包不代表包含本功能。
只与候选清单固定的 Core 和 SDK 配套验证，不因此执行部署、迁移或公开发布。

## 宿主接口

任务由受控管理端建立；DSH 和模型不创建任务、扩大预算、暂停、继续或取消任务。
模型工具不接受 task ID。宿主先按原流程选择完整授权集合，再绑定管理端返回的 task：

```js
import {
  createAgentClientPlugin, createFileSessionScopeStore,
  createFileInvocationStore, createFileSessionTaskStore,
} from 'dsh-bailinghub'

const plugin = createAgentClientPlugin({
  scopeStore: createFileSessionScopeStore({ directory: '/host/session-scopes' }),
  invocationStore: createFileInvocationStore({ directory: '/host/invocations' }),
  taskStore: createFileSessionTaskStore({ directory: '/host/session-tasks' }),
  toolLifecycle: 'session',
})

// runtime 来自 ctx.get('bailingHubAgentClient')；session 是真实宿主 Session。
await runtime.setSessionScope(session.id, { connectionKeys: originalSelectedKeys })
const coordinates = await runtime.getSessionTaskCoordinates(session)
// 仅 ready 时，将原成员坐标提供给受控管理端。它们不是执行许可。
// 管理端建立任务并返回 confirmedTaskId；普通聊天不需要建立任务。
await runtime.setSessionTaskBinding(session, { taskId: confirmedTaskId })
const state = await runtime.getSessionTaskState(session)
// 重开：先恢复原 scope，再恢复 task；这些操作不创建 run 或继续业务调用。
await runtime.restoreSessionScope(session.id)
await runtime.restoreSessionTaskBinding(session)
await runtime.restoreSessionInvocations(session.id)
```

三个 task 方法也接受原 Session ID 字符串。set 只接受 `{ taskId }`，不接受本地策略、预算或成员替换。
默认插件使用 DSH_HOME 下的私有 sidecar；注入自定义 scopeStore 的宿主必须明确注入 taskStore 和 invocationStore。
内存适配器仅用于测试，不提供跨进程持久化。存储目录 0700、文件 0600，原子写入、锁和 revision CAS 与既有 journal 一致。

### 没有进行中的对话轮次，也能核对或继续原调用

例如，商城商品上架正在等待审批，用户关闭客户端后重新打开会话。面板可以直接“核对结果”，
不必伪造一条用户消息或让模型重新执行上架。用户明确点击“继续原调用”时，才考虑继续原操作。

```js
// session 必须是真实、保留原 events/unsavedEvents 的宿主 Session，不接受 ID 字符串。
const inspected = await runtime.inspectSessionInvocation(session, originalInvocationId, { signal })
// 仅在用户明确要求继续时调用。不要把此方法用于自动轮询。
const continued = await runtime.resumeSessionInvocation(session, originalInvocationId, { signal })
```

仅接受原 invocation ID 和可选 AbortSignal，不接受新目标、参数、run 或 task。
原 ID 来自受保护的持久 invocation store，不能从聊天正文补造记录。
两种动作均重验整组选定身份、固定范围、原 journal、task 与 CAS；不创建业务 run，不注入工具，
不改变会话范围或原审批规则。没有 task 的旧 v1 记录仍保持无 task，不能据此跳过后来生效的受管要求。

| 动作 | 行为 |
| --- | --- |
| `inspectSessionInvocation` | 只读原服务端 receipt；即使审批已通过也不执行。暂停或取消的原任务仍可核对原结果。 |
| `resumeSessionInvocation` | 先核对原 receipt。只有明确 `not_dispatched`、无派发 journal 且状态可继续，才发送最多一次原 resume POST。后续等待使用 GET。 |
| 已派发、结果未知、缺少结果 | 只核对原结果，不新造调用；未知结果不能因“继续”按钮变成替代写入。 |
| 当前任务暂停、取消或被阻断 | 核对仍按权限进行；继续受原任务门禁限制。额度与并发限制由 Core 在实际派发时权威判断。 |

结果 envelope：`schema=bailing.agent-session-invocation-action.v1`，含 `operation`、`invocation_id`、
`state`、`resume_dispatched`。`ready` 表示本次核对/继续接口正常返回，**不代表业务成功或整个任务完成**。
读取 `receipt.result.state` 判断原业务结果；`receipt.result=null` 必须保持结果未确认。
`resume_dispatched=true` 表示运行时已将原 resume 请求提交给 SDK，不保证 Hub 已接收或业务已执行；
随后读取的 receipt 本身仍是只读。身份校验可能按 SDK 原规则刷新凭据，这不属于业务派发。
成功可能含 `result`（原 POST 回应）、`receipt`（其后的核对）、`next_action` 和 `retry_after_ms`。
未确定结果时继续用 inspect 原 ID；无隐式轮询、定时自动继续或替代 invocation。

失败返回 `blocked / unavailable / unsupported / storage_error / recovery_gap / cancelled`，
附 `reason` 与现有 `bailing.agent-feedback.v1`，不同时返回可操作的成功结果。
本地保存失败、`unsavedEvents` 和已确认历史缺口优先；已发出请求后出现这些错误，
`feedback.dispatch=unknown`，不能把它解释为“业务肯定没执行”。宿主显示主错误并保留原调用 ID。
网络恢复后可在同一 runtime 重试核对；明确原身份改变仍整组阻断，不退默认目标或剩余授权。

重开时只读加载原本地 outbox 以判断已保存历史，不创建归档、补原文或同步正文。
只读 GET 中相同限流结果保留原绝对等待截止；新的 POST 限流结果可以建立新的等待窗口。
宿主和模型对同一 Session / invocation 共享运行时串行控制；跨进程仍依赖原 journal CAS 和 Core 原 ID 幂等规则。
面板 AbortSignal 与对话轮次分开，关闭 Session/runtime 会取消相关面板动作。迟到响应至多保存原调用事实，
不会复活工具或恢复已取消任务。宿主应在面板操作取消时 abort，不能把旧响应写入另一个会话。

旧 SDK/Core 不支持只读 receipt 时明确 `unsupported`，不会将读取降级为 resume。
缺少持久 invocation store 不猜补原绑定。原“填写草稿 → 用户发送 → 模型工具”流程继续可用。

### 读取原任务坐标

例如，同一会话已选择商城和库存系统的授权，宿主需要让管理端建立一个累计预算任务。
调用 `getSessionTaskCoordinates(session)` 即可获得原会话、原 Agent Session、接入方和 workspace，
不必读取 `sessionScopes.snapshot()` / `sessionTasks.conversationId()` 或自己计算会话标识。
该方法也接受原 Session ID 字符串；推荐传入真实 Session，以同步检查已知的 `unsavedEvents` 和可见历史缺口。

成功结果为：

```js
{
  schema: 'bailing.agent-session-task-coordinates.v1',
  state: 'ready', availability: 'supported',
  sessionId: 'original-host-session-id',
  clientConversationId: 'dsh.conversation.…',
  scopeRevision: 2, scopeLocked: false,
  members: [{
    connectionKey: 'conn_…',
    agentSessionId: 'original-agent-session-uuid',
    clientAppId: 'shop_app', workspace: 'shop'
  }],
  snapshot_is_dispatch_permission: false
}
```

- 单授权、同系统多授权、同 Hub 跨系统使用同一结构；只返回当前已选成员，不含地址、凭据、名称、正文、参数或工具清单。
- 每次重新核验完整原范围及任务协议；已绑定时同时核对原任务成员。临时失败可在同一 runtime 上重试，不能取剩余子集或默认授权。
- 读取不保存、锁定或修复 sidecar，不建立任务、run，不搜索、调用、查询回执或继续业务操作。授权探针由 SDK 按已有机制维护凭据；“只读”不禁止正常凭据刷新。
- 草稿可读但保持未锁定；重开未锁定草稿仍须显式重新确认。已开始且持久保存的原范围按原规则恢复，缺失记录不猜补。异步改选、持久 CAS 变化会使本次读取失败。
- `scopeRevision` 只描述读取时的范围修订，不能当成 task 的 `scope_hash`。绑定仍通过 `setSessionTaskBinding` 重新验证，不能直接写 sidecar。
- 暂停或取消任务的坐标仍可能为 ready；它不表示任务可执行，也不表示宿主允许此时绑定。首消息前才允许绑定等产品规则由宿主判断，不由投影隐式改变。

非 ready 结果**不含** `sessionId/clientConversationId/scopeRevision/scopeLocked/members`，不能沿用界面缓存的旧坐标：

| state | 含义与处理 |
| --- | --- |
| `inactive` | 未选或显式空范围，reason 为 `SESSION_SCOPE_UNSELECTED` / `SESSION_SCOPE_CHAT_ONLY`；availability=`not_checked`，零 Hub 请求 |
| `unsupported` | SDK/Core 明确不支持任务协议；`TASK_UNSUPPORTED` 等，检查配套；不破坏普通未受管多授权流程 |
| `unavailable` | 临时网络失败、429/5xx 或原身份尚未完成验证；保持原范围，恢复连接后重试只读方法 |
| `blocked` | 原身份撤销/改绑、范围待确认、CAS 冲突、任务成员不匹配或未分类错误；按 reason/feedback 处理，禁止自动换授权 |
| `storage_error` | scope/task 持久读取失败或已知未保存消息、invocation、归档；优先解决原存储，不能清队列或创建替代调用 |
| `recovery_gap` | 当前可见历史尚未被原 outbox 完整覆盖；保留原事件并沿现有恢复流程核对 |

错误沿用 `bailing.agent-feedback.v1`，`operation=task_coordinates`、`dispatch=not_dispatched`，
提供安全的 `code/category/retryable/next_action`，不要求解析错误文本。
CAS 的 `SCOPE_STORE_CONFLICT` / `TASK_STORE_CONFLICT` 与读盘失败的 `*_STORE_UNAVAILABLE` 分开；
`SESSION_SCOPE_CONFLICT` 表示读取期间范围变化。已知本地存储错误优先于网络及 unsupported，随后才是 recovery_gap。
原 journal/outbox 的持久恢复仍需宿主正常调用既有恢复接口；本投影不代替恢复，也不证明尚未装载的本地存储完整。

旧候选缺少此方法时，宿主只将任务坐标功能显示为 unsupported，保留普通会话，不能回退读取内部协调器。
本增量只需替换精确 DSH 候选，沿用已验收的 SDK/Core；不需要业务后端修改、Core 迁移或部署。
它没有新增面板直接 inspect/resume 方法，现有“填入草稿→用户发送→原模型工具”流程继续有效。

set 会锁定已选 scope，逐个查询所有原成员，并核对同 Hub、原 Agent Session、client、workspace、conversation、完整 member_count、scope_hash 和不可变工具集合。
任一成员失效、缺失、换绑或跨 Hub 都不能用剩余子集执行。暂时失败保留原关联，恢复仍验证整组。
已绑定任务不可切换或删除；已有非受管业务 run 的 Session 不能中途改绑。
任务确认失败后也不能静默降级成未受管调用。CAS 或保存回执失败保持阻断，restore 只重验或保存同一原关联，不自动创建任务或执行请求。

## 执行和恢复

受管 Session 对实际使用目标按需 startTurn，宿主 options 注入原 taskBinding，SDK 验证 Core 回显。
聊天、目录加载、task 查询、重开、缓存恢复都不会自动创建任务或业务 run。
受管 Session 保留最多 64 条声明与 12 条完整 schema 窗口；下一轮只准备实际目标，声明有效时无需再次远端搜索。
缓存或 task 快照都不是派发许可，每笔业务仍由 Core 原子裁决。
同一受管操作合并重复身份探针：每次实际 invoke/resume 前仍验证全部原成员和最新任务状态，GET/restore 也重新验证。
若继续操作需要等待，等待结束后重新验证；同 runtime 断网后必须重验原组才能恢复，不跨操作缓存授权证明。
固定原绑定可复用协议支持证明；不缓存任务状态、成员身份、unsupported 或未绑定任务时的 required/optional 判定。

- `inspect_governed_tool_invocation` 仅接受原 invocation_id，读取 SDK GET receipt，并与可信 journal 的 run、工具、route、task 和完整原 scope 比对。没有可靠 journal 时不能根据聊天文本猜补身份。
- 受管后台等待只用 inspect，审批已批准也不会触发 POST resume。
- `resume_governed_tool_invocation` 表示明确继续原操作；每次显式动作只发一次原 resume，后续等待用 GET。任务暂停、取消、到期或预算拒绝不会给出重新搜索、换授权或换调用 ID 的建议。
- 取消不回滚已经产生的业务效果。迟到回执仍可保存原事实，但不能恢复已结束轮次的工具或触发后续派发。
- 旧 Core 的明确 unsupported 且 optional 流程继续原有行为；网络失败不是 unsupported。required 时缺 task 或不兼容 SDK 会阻断，不能降级。

`getSessionTaskState` 同时提供 task_state、控制 revision、计量 counters、policy、协议 availability、local 和 unsavedRecords。
计量是唯一写 invocation，不是成功数、商品数或附件数；object_metering 明确 unsupported。
`state` 优先保留 storage_error 和 recovery_gap，因此它可能与 task_state=cancelled 并存；local 保留各存储状态、unsavedEvents 和 unsavedInvocations。
`getSessionToolState` 和工具准备结果包含同一紧凑 task 摘要，不重新下载任务列表。

## 升级与回滚

既有 journal v1 仍可读取；第一次正常写入升级为 v2。旧条目保持没有 task，不推断归属；新条目的 taskBinding 不可改绑。
任务 sidecar 使用 `bailing.agent-session-task.v1`，只保存原 scope 指纹、原成员坐标和 task 引用，不保存凭据、聊天或业务参数。

运行前备份 task、scope、invocation 和会话归档存储。包含受管任务或 v2 journal 的 Session 不应回退给不识别它们的旧宿主。
Core 的 managed enrollment 是粘性的；回退客户端、删 sidecar 或换任务都不能用来解除服务端 task 要求。
未受管旧 Session 不需要自动创建任务或补写旧条目。部署与数据库升级顺序由 Core 候选手册另行授权。

## 合成验证

```sh
BAILINGHUB_SDK_DIST=/absolute/path/to/paired-sdk/dist/sdk.js npm run verify
```

集成测试使用真实 DSH Session、真实配套 SDK 和 loopback HTTP，隔离临时文件存储。
覆盖跨轮缓存、lazy run、整组检查、required/optional、CAS 失败和丢失保存回执、完整重开、暂停/取消、显式继续、只读 receipt、身份串换、迟到响应和存储优先级。
它证明 DSH/SDK 接线，不替代真实 Core 数据库事务/HTTP 派发验收，也不涉及真实业务写入。
