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

set 会锁定已选 scope，逐个查询所有原成员，并核对同 Hub、原 Agent Session、client、workspace、conversation、完整 member_count、scope_hash 和不可变工具集合。
任一成员失效、缺失、换绑或跨 Hub 都不能用剩余子集执行。暂时失败保留原关联，恢复仍验证整组。
已绑定任务不可切换或删除；已有非受管业务 run 的 Session 不能中途改绑。
任务确认失败后也不能静默降级成未受管调用。CAS 或保存回执失败保持阻断，restore 只重验或保存同一原关联，不自动创建任务或执行请求。

## 执行和恢复

受管 Session 对实际使用目标按需 startTurn，宿主 options 注入原 taskBinding，SDK 验证 Core 回显。
聊天、目录加载、task 查询、重开、缓存恢复都不会自动创建任务或业务 run。
受管 Session 保留最多 64 条声明与 12 条完整 schema 窗口；下一轮只准备实际目标，声明有效时无需再次远端搜索。
缓存或 task 快照都不是派发许可，每笔业务仍由 Core 原子裁决。

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
