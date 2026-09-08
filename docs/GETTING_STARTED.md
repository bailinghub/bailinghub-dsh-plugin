# Get started in three minutes

This guide is for someone whose organization has already connected a business system to
BailingHub. If that integration does not exist yet, the BailingHub administrator and business
developer must prepare it before an end user installs this plugin.

This guide installs public `0.3.0`, which selects one connection per conversation. Same-system
authorization selection is an [unreleased source candidate](../README.md#unreleased-source-candidate-one-system-multiple-authorizations),
not a feature of that npm release.

## What to ask your administrator for

Ask for these four public connection values:

```text
Hub URL
Client App ID
Workspace
Connection Name
```

They identify the BailingHub application and starting workspace. They are not credentials. Do not
ask the administrator to send you a Client Token, Tool Provider secret, business password, model
API key, authorization code, browser session cookie, business URL, or tenant-specific login URL.

## 1. Install the plugin

Install the exact public version into the DSH Web profile:

```bash
dsh plugin --profile web add dsh-bailinghub@0.3.0
```

The plugin installs the matching BailingHub SDK automatically.

## 2. Enter the four connection values

Use the DSH plugin settings page or these environment names:

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='employee_assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

The values above are placeholders. Use the public values from your own BailingHub administrator.
Never paste credentials into the Cordis patch or a chat message.

## 3. Authorize in the browser

Start DSH and run:

```text
/bailinghub login
/bailinghub status
/bailinghub workspaces
```

`login` opens the one business-side authorization entry configured for the Client App. Sign in or
switch account there, select a tenant there when the business system asks, and check the resulting
business identity and requested workspace before approving. Authorization uses the business
system's own login; it does not send the business password or business URL to the plugin.

`Connection Name` is only a local selector. If the same trusted business identity authorizes the
same Hub/client/workspace binding again, the SDK replaces the older local connection. A different
trusted identity remains separate. When the selected name already belongs to the old identity,
the SDK preserves it and assigns the new identity an available alias such as `default-2`; the new
alias becomes current. Run `/bailinghub connections list` to see both and
`/bailinghub connections use <name-or-key>` to switch. If login says cleanup is required, the new
connection is already authorized, but an existing connection may still need inspection or
removal: do not authorize again; list connections and remove the reported old entry.

## 4. Confirm the conversation scope, then try a business request

For public `0.3.0`, a new conversation uses its selected connection. The **unreleased source
candidate changes this default**: unset scope or `/bailinghub scope none` means ordinary chat,
with no BailingHub business tools or runs. When testing that candidate, before the first user
message run:

```text
/bailinghub connections list
/bailinghub scope set <connection-key> [<another-connection-key> ...]
/bailinghub scope
```

Use fixed keys from the list, not aliases. Select only the accounts this conversation needs;
multiple accounts must share the same Hub/client/workspace. Wait for successful scope confirmation
before sending. The first user message freezes the scope, so changing accounts or switching from
ordinary chat requires a new conversation. A selection/check failure pauses business access for
the whole scope, without using the default or a remaining subset. Embedded hosts without native
commands must integrate the [scope API](AGENT_CLIENT_CONTRACT.md#host-owned-session-scope-api).

In that new conversation, ask for one read-only action that the selected system exposes, for
example:

```text
Find the demonstration employee EMP-001 and summarize the visible fields.
```

Then try one reversible permitted update in a dedicated development workspace. The exact requests
depend on the capabilities your business system has exposed. An operation that requires approval
must continue through the existing approval flow; an operation outside the current identity's
permissions must remain unavailable.

## 5. Confirm the result in BailingHub

The BailingHub console should show the corresponding conversation, Agent Run, governed tool calls,
approval state, and final result. Do not treat a successful installation alone as proof that a
business action ran.
For a candidate scope containing multiple authorizations, each run receives only its own call
summary; the combined answer remains in DSH. Reopening a saved conversation restores only its
confirmed scope after validation. Missing or invalid old snapshots block business access, and
scope restoration does not recover pending invocations or approvals after a process restart.

If setup fails, include the DSH version, plugin version, operating system, the command that failed,
and redacted error text in a GitHub Issue. Never attach tokens, private URLs, personal information,
authorization codes, or production payloads.
