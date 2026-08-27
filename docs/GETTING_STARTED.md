# Get started in three minutes

This guide is for someone whose organization has already connected a business system to
BailingHub. If that integration does not exist yet, the BailingHub administrator and business
developer must prepare it before an end user installs this plugin.

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
API key, authorization code, or browser session cookie.

## 1. Install the plugin

Install the exact public version into the DSH Web profile:

```bash
dsh plugin --profile web add dsh-bailinghub@0.2.0
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

`login` opens the business-side authorization page. Check the signed-in business identity and
requested workspace before approving. Authorization uses the existing business login; it does not
send the business password to the plugin.

## 4. Try one safe business request

Start a new conversation and ask for one read-only action that the connected system exposes, for
example:

```text
Find the demonstration employee EMP-001 and summarize the visible fields.
```

Then try one reversible permitted update in a dedicated development workspace. The exact requests
depend on the capabilities your business system has exposed. An operation that requires approval
must continue through the existing approval flow; an operation outside the current identity's
permissions must remain unavailable.

## 5. Confirm the result in BailingHub

The BailingHub console should show the same visible conversation, Agent Run, governed tool calls,
approval state, and final result. Do not treat a successful installation alone as proof that a
business action ran.

If setup fails, include the DSH version, plugin version, operating system, the command that failed,
and redacted error text in a GitHub Issue. Never attach tokens, private URLs, personal information,
authorization codes, or production payloads.
