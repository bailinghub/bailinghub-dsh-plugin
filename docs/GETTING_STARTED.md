# Get started with 0.5.0

This guide is for users whose business system is already connected to BailingHub. Your
administrator must prepare Core 0.7.0, a public Client App ID, a workspace, and the business
browser-authorization entry first. For multiple systems, prepare one independently authorized
connection per target on the same Hub and audit domain. Existing business capability declarations
remain valid; each requested action must already be exposed by its own system.

## 1. Install and configure

Use Node.js `22.19.0+` or `24+` and the compatible DSH version:

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-bailinghub@0.5.0
```

The plugin installs SDK 0.5.0 automatically. Enter the four public values in DSH plugin settings,
or use their environment names. The example values below are placeholders:

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='order_assistant'
export BAILINGHUB_CONNECTION_NAME='Store A'
dsh --profile web --dump-config
dsh web
```

Use your administrator's Hub URL, Client App ID, and workspace. `Connection Name` is your local
label. None of these fields is a credential. Never put passwords, Client Tokens, signing secrets,
model keys, or business API/authorization URLs into the plugin settings or chat.

## 2. Authorize each account

In DSH, authorize the first account:

```text
/bailinghub login
/bailinghub doctor
/bailinghub status
```

The browser opens the original business authorization page. Sign in or switch accounts there,
select the intended store/tenant when asked, and check the actual identity before approving.
The business page determines the identity; the local label `Store A` does not. A compatible
backend supplies the approved subject name automatically. The current display name is separate
from its fixed key and the system description; missing names remain explicit. Duplicate names
or renames do not recreate authorization or change old conversation records.

For another account in the **same system and workspace**, register a clearly named connection,
using the same three administrator-provided values, then authorize it separately:

```text
/bailinghub connections add "Store B" https://hub.example.com example-agent-client order_assistant
/bailinghub login
/bailinghub connections list
```

Confirm Store B on the business page. If you approve the same trusted identity again, the SDK
replaces its old connection and Session instead of creating a second identity. If an existing
name returns a different identity, the original connection remains and the new identity receives
an available alias. Names such as `default-2` do not prove which store was authorized. Check the
mapping before use. If login reports cleanup required, the new connection is already authorized;
inspect and remove the reported old entry rather than authorizing again.

To add a **different system**, use its administrator-provided Client App and workspace on the
same Hub, then authorize it independently. For example, an inventory target may use:

```text
/bailinghub connections add "Inventory" https://hub.example.com inventory-client inventory_assistant
/bailinghub login
/bailinghub connections list
```

These are placeholders, not values to guess from a product name. Each selected target needs its
own original Agent Session. Keep the existing Store B connection if using the same-system flow.

## 3. Choose this conversation's business scope

Start a **new conversation before sending any message**, then run:

```text
/bailinghub connections list
/bailinghub scope set <shop-connection-key> <inventory-connection-key>
/bailinghub scope
```

Copy the fixed connection keys from the list; the scope command does not accept names. Select
one key for one account, several for the same system, or several systems on one Hub and audit
domain. Wait for successful confirmation. With the required inventory/shop capabilities and a
confirmed product mapping, you can ask:

```text
Check tumbler stock. If any are available, change the corresponding shop product to 59 and list it.
Otherwise leave it unlisted.
```

The system description can explain online selling versus inventory before tool search. “Not loaded”
means tools have not been queried, not that none exist. A stock read does not reserve or synchronize
stock. Check price and listing outcomes separately, including any pending approval.

For the retained same-system flow, select Store A and Store B instead and compare their sales
when reporting tools are available. A system that was not used must not be marked as executed.

The Agent chooses which selected authorization to use for each call. The system still decides
which data and actions that authorization permits. Test a read first, then a reversible permitted
update in a development workspace. Approval-required work follows the original approval flow.

Without a selection, or with `/bailinghub scope none`, the conversation is ordinary chat and
starts no BailingHub business runs. The first message freezes this choice. Start a new conversation
to change accounts or enable business access after ordinary chat. Changing the registry's default
connection does not change a conversation's scope.

## 4. Check results and the visible conversation

Check the actual business result and its original invocation trail in BailingHub. With the matching
Core 0.7.0, you can also follow visible user/assistant messages, turns, and the linked runs as one
conversation record. Multi-authorization runs keep their own call summaries separately.

```text
/bailinghub archive status
/bailinghub archive sync
```

The first command shows upload status; the second retries the saved record. It never repeats a
business action. `synced` means saved events were acknowledged, not that an action succeeded.
`pending` means upload is unfinished; `blocked` means the original authorizations cannot currently
permit it; `unsupported` means the SDK or Hub lacks the archive contract. `storage_error` or
`recovery_gap` means capture itself may be incomplete. Missing host history is unverified.

## 5. Reconnect or reopen

A saved business conversation restores its original selected accounts only after they all pass
validation. If it was reopened offline, reconnect and run `/bailinghub archive sync` or
`/bailinghub scope` in that same conversation. Temporary uncertainty can recover; a revoked or
replaced authorization, corrupt snapshot, or storage conflict remains blocked for the whole scope.
There is no automatic fallback to another account.

Restoring scope and retrying uploads does **not** restore unfinished business invocations or
approvals after a process restart. A never-started saved draft needs selection again. An older
started conversation with no valid scope snapshot must be left as history; begin a new one.
Use `/bailinghub sync` only to retry a pending run completion in the still-running conversation.

All selected accounts' context shares the local model conversation. The private local archive
contains plaintext visible task text and stays on disk until manually removed; it does not capture
hidden reasoning, attachments, or all past history. Read [Privacy](../PRIVACY.md), and use separate
conversations when account data must remain separate. Do not paste secrets into visible messages.

If setup fails, include versions, operating system, failed command, and redacted error text in a
[GitHub Issue](https://github.com/bailinghub/bailinghub-dsh-plugin/issues). Never attach credentials,
private URLs, authorization codes, personal data, or production payloads.
