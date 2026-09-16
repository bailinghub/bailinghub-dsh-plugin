# 开始使用 0.6.0

这份指南面向业务系统已经接入 BailingHub 的用户。管理员需要先准备 Core 0.8.0、公开的 Client
App ID、workspace 和浏览器业务授权入口。多系统时，每个目标分别授权，且属于同一中枢、同一
审计域；已有能力无需重新声明，但每项动作必须已由相应业务系统开放。

## 第一步：安装与配置

使用 Node.js `22.19.0+` 或 `24+`，并安装兼容的 DSH：

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-bailinghub@0.6.0
```

插件会自动安装 SDK 0.6.0。通过插件设置填写四项公开信息，或使用对应环境变量。下面都是
占位值，需要替换成管理员提供的中枢地址、Client App ID 和 workspace：

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='order_assistant'
export BAILINGHUB_CONNECTION_NAME='A 店'
dsh --profile web --dump-config
dsh web
```

`Connection Name` 是你设置的本机名称。这四项都不是凭据；不要把业务密码、Client Token、签名
密钥、模型 Key、业务 API 地址或授权页面地址写入插件设置或聊天消息。

## 第二步：分别授权账号

在 DSH 中为第一家店执行：

```text
/bailinghub login
/bailinghub doctor
/bailinghub status
```

浏览器会打开原业务授权页面。在那里登录、切换账号，并按业务系统要求选择门店或租户；同意前
核对实际业务身份。可信身份由业务授权页面决定，本机名称 `A 店` 不证明身份。配套后端可自动
提供授权主体名称，它与固定连接键、系统用途说明独立；缺名会明确提示。同名或改名不重建授权，
也不更改原会话记录。

如需使用**同一系统、同一 workspace** 的 B 店，用同样的三项公开信息创建清晰命名的新连接，
再分别授权：

```text
/bailinghub connections add "B 店" https://hub.example.com example-agent-client order_assistant
/bailinghub login
/bailinghub connections list
```

请在业务页确认选中了 B 店。如果实际再次同意的是同一可信身份，SDK 会替换它的旧连接和 Session，
不会凭名称造出第二个身份。从已有名称授权另一身份时，原连接保留，新身份会获得可用别名。
`default-2` 之类的名称不能证明是哪家店，使用前应核对对应关系。若登录提示需要清理，新连接
已经授权成功；请检查并删除提示的旧条目，不要重复授权。

要接入**另一个系统**，使用管理员提供的该系统 Client App 与 workspace，并在同一中枢上
独立授权。例如库存目标可以使用以下占位配置：

```text
/bailinghub connections add "库存系统" https://hub.example.com inventory-client inventory_assistant
/bailinghub login
/bailinghub connections list
```

这些配置不能从产品名称推测。每个选中目标都需要独立原 Agent Session；同系统流程中已有的
B 店连接可以继续保留。

## 第三步：选择本次会话的业务范围

**新建会话，在发送任何消息前**执行：

```text
/bailinghub connections list
/bailinghub scope set <商城连接键> <库存连接键>
/bailinghub scope
```

从列表复制固定连接键替换占位符，不能直接填写名称。可以选单份授权、同系统多份授权，或
同一中枢、同一审计域的多个系统。等设置成功回显后再发请求。相应能力已开放、商品关系已确认时：

```text
先查保温杯库存。有货就把商城对应商品的售价改为 59 元并上架；没货就先不要上架。
```

系统说明可在首次查工具前解释“线上售卖”和“库存管理”的区别。“尚未加载”表示还没查询工具，
不是没有能力。查库存不等于锁库存或自动同步；改价、上架及审批要分别核对结果。

原同系统流程仍可选择 A 店和 B 店，在报表能力可用时对比营业情况。没有实际调用的系统不能
被标为已执行。

智能体自行选择每次调用使用哪份选中授权；实际数据和操作范围仍由业务权限决定。先验证一次
查询，再在开发空间尝试一次可回滚且允许的修改。需要审批的操作继续沿用原规则。

未选择范围，或执行 `/bailinghub scope none` 时，只进行普通聊天，不启动 BailingHub 业务执行。
第一条消息会固定这个选择。之后要增减账号，或从普通聊天开启业务访问，需要新建会话；切换
连接管理的默认连接不会改变会话范围。

## 第四步：核对业务结果与沟通过程

在业务后台核对最终结果，在 BailingHub 查看原调用轨迹。配合 Core 0.8.0，还能把可见用户消息、
助手回复、轮次与相关执行记录放在同一份沟通记录里查看。多授权的各份执行记录仍分别保留自身
调用摘要。

```text
/bailinghub archive status
/bailinghub archive sync
```

第一条查看上传状态，第二条补传已保存记录，不会重做业务操作。`synced` 表示已保存事件获中枢
确认，不代表业务成功；`pending` 表示尚未传完；`blocked` 表示原授权当前无法允许上传；
`unsupported` 表示 SDK 或中枢不支持归档。`storage_error`、`recovery_gap` 表示采集本身可能
不完整；宿主没有历史可供核对时，覆盖度为未验证。

## 第五步：断网或重开后继续

重开已保存的业务会话时，核验全部原授权后才恢复原账号范围。若离线重开，联网后可以在同一
会话执行 `/bailinghub archive sync` 或 `/bailinghub scope` 再试一次。临时网络不确定可以恢复；
已撤销、被替换的授权，损坏的范围快照或存储冲突仍会阻断整组，不会自动换账号。

恢复范围与补传记录，**不等于恢复进程重启前未完成的业务调用或审批**。未开始的保存草稿需要
重新选择；旧版已开始但没有有效范围快照的会话只能保留为历史，请另开新会话。
`/bailinghub sync` 只用于当前仍运行会话的待同步执行结尾记录。

所选账号的上下文会共用本地模型会话；本机私有归档含明文任务正文，直到手动清理才删除。它不
采集隐藏思考、附件或全部历史。启用前请看[隐私说明](../PRIVACY.md)；数据需要隔离的账号应分开
会话，不要在可见消息里粘贴秘密。

初始化失败时，可向 [GitHub Issues](https://github.com/bailinghub/bailinghub-dsh-plugin/issues)
提供版本、操作系统、失败命令和脱敏错误，不附带凭据、私有地址、授权码、个人信息或生产载荷。
