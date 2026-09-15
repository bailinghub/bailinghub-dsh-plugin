# 本地智能体附件空间：DSH 宿主接入（候选）

智能体生成或用户明确指定用于业务的图片，可以用于活动海报、内容封面、经营图表，也可以用于商城商品。宿主把当前会话获准使用的图片登记到附件目录，插件提供目录查询和上传工具；模型选择目标授权与附件引用，中枢保存图片并返回 URL，供后续业务工具使用。图片不必在当前轮生成；仅用于聊天理解的附件不会因此自动登记或上传，聊天附件历史存档是另一项独立能力。

首期支持 PNG、JPEG、WebP。附件空间提供会话级目录、上传与上传结果恢复，不把 PDF、Word、视频或完整网盘管理写成已经交付的能力。业务系统需要预先提供相应的图片 URL 接口。

这是尚未公开发布的候选能力。需要配套 Core / SDK / DSH，并由客户端宿主连接实际生成文件。本插件不内置图片生成服务，不扫描用户电脑，也不接受模型指定的任意本地路径。

## 宿主需要接哪两处

```js
import { createAgentClientPlugin, createFileArtifactStore } from 'dsh-bailinghub'

const plugin = createAgentClientPlugin({
  // 保留原 SDK、scopeStore、archiveStore 等配置。
  artifactSource: {
    async list({ sessionId }) {
      // 从本会话已获准用于业务的图片中读取；只返回元数据，最多 100 项。
      return [{ artifactRef: 'campaign-banner', name: 'campaign-banner.png',
        mime: 'image/png', bytes: generatedSize, sha256: generatedDigest }]
    },
    async read({ sessionId, artifactRef }) {
      // 宿主按已登记引用读取获准文件，返回 Uint8Array。
      // 检查归属、允许目录、符号链接及读取期间文件变化；不要直接拼接模型给出的路径。
      return generatedBytes
    },
  },
  artifactStore: createFileArtifactStore({ directory: artifactRecoveryDirectory }),
})
```

`artifactRef` 是宿主管理的稳定引用，允许字母、数字、下划线和短横线，最多128字符；不可把同一个引用改指另一份文件。同名图片可以用不同引用。目录属于真实 DSH Session，重新打开时保持原归属；后台持久化上传元数据目录同样需要跨重启保留。也可实现自有 `artifactStore.get(uploadId)` / `reserve(record)`：reserve 必须原子、只写一次并返回先前记录或新记录，落盘完成才成功返回。内存 store 仅用于测试或明确的临时会话。

未提供 artifactSource 时不会新增模型工具，已有业务流程不变。缺少持久恢复 store 时上传返回 storage_error，并且不会发送文件。

## 模型实际能用的工具

- `list_generated_artifacts`：读取当前会话产物目录，不返回路径或文件正文。
- `upload_generated_artifacts`：必须明确 `authorization_ref` 与 `artifact_refs` 数组；每批1–8张，单张不超过6MiB，支持PNG/JPEG/WebP。

上传成功后模型直接使用 ready URL，不需要为每次使用重复查询地址或上传。只有不确定的上传结果或会话重开恢复才查询原上传记录。

业务操作独立执行并单独判断结果。例如更新商城轮播图时，所有必需图片 ready 后再提交完整清单，保留未被要求删除的旧图片；业务结果未知时保留原 invocation，不能重发写操作。

模型不选择桶或密钥。中枢管理员在“智能体客户端 → 配置接入 → 工具与审批 → 生成图片上传”选择媒体存储。第一期图片用于公开展示；普通COS/OSS或显式本地存储都由部署方管理保留，不增加文件到期判定。

## 失败和重开

### 跨轮上传与旧错误记录恢复

新上传只关联目标授权**当前轮次的 active run**。跨系统按需启动业务 run；该目标当轮尚未启动时，上传使用原会话与当前轮次、不带可选 runId，既不沿用上轮记录，也不为上传额外创建业务 run。

旧候选可能保存了“本轮上传 + 上轮 run”的记录。只有配套 Core 返回 `artifact_run_turn_mismatch`（同一原身份、路由、会话均一致，仅轮次不同），且再次读取原上传 ID 明确返回 `artifact_not_found`，DSH 才自动纠正。泛化的 `artifact_run_mismatch`、授权失效、网络错误或结果未知都不能触发纠正。Core 的身份和关联检查保持生效。

纠正不覆盖原恢复记录：通过现有 get/reserve 原子保存独立的 `bailing.artifact-run-link-repair.v1` 记录，保留原记录摘要和原上传 ID。修正元数据只删除已证明属于另一轮的 runId，保留原上传会话、轮次、内容及目标；实际 HTTP 始终使用原上传 ID。宿主应完整保存记录中的 `runLinkRepair` 字段，不把这个本地记录键当成新增云端上传或新产物。无需新增 store 方法。

纠正必须落盘后才补传；已 ready 的原回执直接复用，pending 不改绑，确认丢失后读取原 ID。原记录或纠正记录缺失、损坏时返回 storage_error，不根据服务端 URL 猜补本地历史。旧 Core/SDK 没有精确错误码时，旧错链记录继续明确阻断；当前正确链接的新上传仍兼容原附件 API。

两个工具名中的 `generated` 为兼容保留，不限制来源必须是 AI 生成。宿主需要更新自己的目录说明，让用户明确指定业务用途的图片可以受控登记，不新增聊天附件自动同步或用户手动上传入口。

每文件上传身份绑定原真实 Session、连接与产物引用，首发前原子保存原 Hub/client/workspace/Agent Session、内容摘要、名称和原会话/轮次/run关联。重试或重开先读取原中枢记录，成功项直接复用 URL；pending 或尚未写入时补传原文件。即使原文件已不可读，已确认成功的上传仍可恢复。

批量结果包含 `results`、`all_ready` 和 `business_operation_performed=false`。每项为 ready、pending 或 blocked。成功项保留，失败项独立处理；不要因部分上传成功就写入残缺图库。

本地持久化失败返回 storage_error；原记录损坏或丢失须由宿主标记恢复缺口，不能猜补原历史。暂时网络失败可以在同一 runtime 重试，保留原记录。任何原授权成员撤销或改绑时整组阻断，不退回默认、子集或替代 Session。取消后迟到上传不会重新注册业务工具或返回可继续执行的轮次；已经保存的对象及原记录仍可在合法恢复时查询。

旧SDK/Core返回artifact_unsupported，保留原业务工具能力。Lazy SDK transport 已转发新增接口，但宿主仍必须实际提供生成文件来源。测试替身与真实对象存储连通性分开验收。

## 业务后端要不要改

如果原业务能力已经接收图片 URL，不必改授权或审批规则。客户端将 ready URL 作为原业务参数传入即可。需要业务自身素材ID、转存或素材库归属时，另接该系统的业务导入能力。

## 分开记录的已知限制

配套 Core 候选已提供可配置的中枢工具限额，小时/日额度按原窗口计数，并为新调用保留加密原参数。DSH 读取 `retry_after_ms`，等待后只恢复原 `invocation_id`；长于自动等待预算时返回 `agent_client_wait.state=rate_limited`，保留等待时间和原调用。手动过早恢复也不向中枢反复请求。原权限、审批、取消和授权目标约束继续生效；旧 Core 不返回提示时仍沿原恢复流程。

当前列表工具的源错误可能经过通用分类变成 unknown_failure；宿主应保留自己检查到的 storage_error/recovery_gap，不能将其描述为空目录。上传工具仍返回逐项错误。不要用新业务调用或重新上传已经 ready 的附件掩盖这些问题。
