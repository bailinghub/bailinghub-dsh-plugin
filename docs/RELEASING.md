# Releasing

## Writing release notes

For each release, explain a concrete user problem, the new behavior, affected roles, exact upgrade steps, observable checks and limits. State which business APIs and mappings must already exist, and keep English and Chinese facts aligned. See [the 0.8.0 release notes](RELEASE_NOTES_v0.8.0.en.md) for an example.

## Release units and order

The Agent Client spans three independently versioned release units. Publish and verify them in
this dependency order:

```text
1. BailingHub Core 0.10.0
   Agent Auth, Runtime Context, capability governance, invoke/resume, completion, and audit

2. bailinghub-mcp-server 0.8.0
   the host-neutral `./sdk` export, browser authorization, credential storage, and DTO mapping

3. dsh-bailinghub 0.8.0
   native DSH lifecycle, commands, prompt/context projection, dynamic tools, and completion sync
```

Do not publish the DSH package before the exact SDK version in its ordinary dependency is publicly
installable. Do not publish the SDK before the matching Core contracts are released and available
for compatibility tests. A deployment-specific business adapter is an acceptance fixture, not a
fourth BailingHub package and not a dependency to publish from this repository.

This dependency order does not require new Core and SDK versions for an independent plugin fix.
An unchanged compatible upstream release may be reused; record its exact identity and compatibility
evidence. Do not change an immutable upstream release to make a new plugin's metadata match.

The public `0.1.1` static MCP bundle is a separate compatibility path. Never move its tag, rewrite
its package, or silently reinterpret its Client Token and Hub-orchestrated semantics.

## Public manifest gates

The stable `0.8.0` manifest is publishable and must retain all of these properties:

```text
version: 0.8.0
publishConfig.access: public
publishConfig.provenance: true
dependency: bailinghub-mcp-server@0.8.0 (exact ordinary dependency)
```

For every public prerelease or stable version:

1. Keep npm public/provenance metadata enabled and do not add `private:true`.
2. Place one exact compatible `bailinghub-mcp-server` version in ordinary `dependencies`.
3. Keep the SDK out of `peerDependencies`, `peerDependenciesMeta`, and
   `optionalDependencies`.
4. After SDK 0.8.0 is publicly installable, regenerate `package-lock.json` from the registry; both
   its root dependency and resolved package version must equal the exact manifest value. Never
   invent registry integrity metadata or commit a local tarball dependency. Before that point, a
   local exact SDK tarball can validate source behavior, but is not the final release lock or
   clean-registry-install evidence.
5. Keep all install hooks absent. The package must not download code through `preinstall`,
   `install`, `postinstall`, or `prepare`.
6. Keep local paths, private deployment URLs, credentials, and business-specific identifiers out
   of the manifest, lockfile, Cordis patches, docs, tests, and tarball.

`scripts/check-project.mjs` enforces these properties. A stable plugin may depend only on an exact
stable SDK version.

The current Publish workflow is the stable `latest` path; it does not select an alternate dist-tag.
A public prerelease needs a separately reviewed and tested non-`latest` publication policy before
any tag is pushed. Only components actually changing need a new version; an already-published
compatible stable SDK may remain the exact dependency. A stable plugin must not depend on a
prerelease SDK. Do not treat prerelease syntax support in a manifest check as a working publisher.

## Version update surface

For every prerelease or stable release:

1. Update `package.json`, `package-lock.json`, and the lockfile root version together.
2. Update the exact SDK dependency and resolved lock entry together.
3. Add the release entry to `CHANGELOG.md` without converting private evidence into an adoption
   claim.
4. Update the exact install version in `README.md` and `docs/README.zh-CN.md`.
5. Update `docs/COMPATIBILITY.md` only from real compatibility evidence.
6. Update `docs/AGENT_CLIENT_CONTRACT.md` and `docs/MIGRATION_VNEXT.md` when host fields, commands,
   schemas, credential behavior, or migration semantics change.
7. Update `SECURITY.md` and `PRIVACY.md` when data flow, storage, or supply-chain behavior changes.
8. Select the checks below by the changed surface and record whether evidence is new, reused,
   not applicable or an independent client task.

The native host configuration remains exactly:

| Field | Environment value | Owner |
| --- | --- | --- |
| `hubUrl` | `BAILINGHUB_HUB_URL` | deployer |
| `clientAppId` | `BAILINGHUB_CLIENT_APP_ID` | Hub/business integrator |
| `workspace` | `BAILINGHUB_WORKSPACE` | Hub/business integrator; Agent Client v1 route id |
| `connectionName` | `BAILINGHUB_CONNECTION_NAME` | user-selected local connection label |

No Client Token, model key, business endpoint, authorization endpoint, signing secret, or business
credential belongs in the DSH plugin configuration. The Hub Client App owns one stable business
authorization entry; the business page owns login, account switching, tenant selection, and the
trusted identity result.

## Acceptance scope

Every package release needs normal prepack/CI, an actual archive scan, candidate installation,
and a fresh exact official-registry installation with actual dependency/import/configuration checks.
Select additional real acceptance by what changed:

| Changed surface | Required focused evidence |
| --- | --- |
| Authorization, credentials, identity or host lifecycle | Affected authenticated paths and OS storage; browser login, identity replacement and logout where affected |
| Tool/context projection, approval, recovery, scope or archives | The affected native host path, original operation IDs and no repeated business action; final model-request delivery when context confirmation changes |
| Model streaming, budgets or task continuation | Synthetic transport/original-operation tests plus affected host/provider integration; do not claim automatic continuation from package installation |
| Legacy patch, stdio startup or Core Client API compatibility | The separate legacy path below, including original-job follow-up when its behavior changes |
| Documentation or release tooling only | Package/distribution gates and targeted regression tests; unchanged real runtime evidence may be reused |

Reuse real evidence only when relevant code, dependency, contract and configuration fingerprints
are unchanged and its host version, OS and tool mode remain applicable. Record its date, exact
subject and reuse reason; otherwise repeat the affected check. A changed-surface requirement cannot
be waived as a pending item. Independent downstream rollout, real-model task performance and
external adoption remain separate when they are not release requirements or claims. Composition,
synthetic behavior and authenticated client use must keep their own evidence levels. A new
official package always needs source/integrity verification and fresh registry consumption.

## Source and tarball verification

Run from a clean release checkout with no production credentials in the environment or shell
history:

```bash
npm ci
npm audit --audit-level=low
npm pack --json
```

For the final local candidate, normal `pack` runs the existing `prepack`/`verify` once. Keep that
complete log, pack JSON and actual archive. Do not prepend another `verify` plus a dry-run solely
to repeat the same checks. CI remains independently required; a dry-run or skipped lifecycle
scripts cannot replace the final candidate archive.

The checks below describe required coverage, not a request to rerun checks already recorded for
this candidate by normal prepack or CI. Reference that coverage and add only missing applicable
seams; actual-archive inspection and official-registry readback remain separate gates.

Inspect the exact tarball inventory. It should contain the public native runtime, selected Cordis
patch, user documentation, compatibility/security/privacy material, and package metadata. It must
not contain tests, local profiles, credentials, real deployment values, business payloads, editor
state, or a local tarball dependency.

Retain this candidate's repository secret/local-path guard result. If normal prepack or CI already
ran it, cite that result rather than repeating it; run the guard when that coverage is absent.
Inspect the actual tarball independently for:

- private keys or bearer credentials;
- access, refresh, client, model-provider, or business-system tokens;
- private hosts, numeric server addresses, user home paths, or `file:` dependencies;
- business-specific client ids, route ids, account ids, tenant ids, or payload examples.

Only neutral placeholders such as `https://hub.example.com`, `example-agent-client`,
`order_assistant`, and `default` belong in public setup examples.

## Clean-profile package acceptance

Use a truly isolated DSH home and the exact tarball or registry version that will be released.
Some desktop command shims may set their own DSH home; prove that the invoked CLI honors the
temporary value before installing anything. If it does not, use a standalone compatible DSH CLI
or its underlying entrypoint. Never run a release smoke against the maintainer's normal profile.

```bash
dsh_release_version="$(node --print "require('./package.json').version")"
dsh_release_home="$(mktemp -d)"
DSH_HOME="$dsh_release_home" dsh plugin --profile web add \
  "./dsh-bailinghub-${dsh_release_version}.tgz"
DSH_HOME="$dsh_release_home" dsh --profile web --dump-config
```

Use placeholder host configuration for composition checks. Confirm all of the following before a
live login:

1. The composed Web profile selects `cordis.agent-client.patch.yml` and native `dsh-bailinghub`.
2. Installing only the DSH plugin also installs the exact declared `bailinghub-mcp-server`.
3. `bailinghub-mcp-server/sdk` resolves from the installed plugin without ambient modules.
4. The dump contains only `hubUrl`, `clientAppId`, `workspace`, and `connectionName` for this
   plugin; it contains no credential value.
5. Missing or invalid configuration degrades clearly and does not claim a business action ran.

## Browser authorization and live acceptance

Use the applicable scenarios below when the selected acceptance scope requires them. They define
the evidence for those behaviors, not a requirement to repeat every scenario for an unrelated
documentation or packaging change. Referenced unchanged evidence must satisfy the reuse rule above.

Use a dedicated non-production Hub client/workspace and a no-surprise business fixture. Never put
its credentials, private URL, authorization code, personal data, or raw payload into logs,
screenshots, release notes, or CI artifacts.

A separate `DSH_HOME` keeps DSH configuration, sessions, and logs apart. A multi-connection
release must additionally prove the post-authorization reconciliation rules on
one Hub/client/workspace binding: a second authorization of the same trusted `on_behalf_of`
replaces the older local connection, while a different trusted `on_behalf_of` remains independent.
If old-Session revocation is deliberately made to fail, the new connection must remain authorized,
the old entry must remain available for explicit cleanup, and the command must say not to
authorize again. Do not infer any of these results from separate DSH homes or connection names.

In the isolated DSH Web profile:

1. Run `/bailinghub doctor`; before login it must identify the isolated connection as logged out
   without printing any credential, private endpoint, or model-provider key.
2. Run `/bailinghub login` and confirm the system browser opens the single business authorization
   entry configured for the Hub Client App; no business URL is present in plugin configuration.
3. Log in or switch account and select a tenant on that business page when required. Confirm it
   shows the intended final business identity, Hub client, requested workspace, and capability
   boundary before approval.
4. Complete the callback and verify `/bailinghub doctor` plus `/bailinghub status` without exposing
   access or refresh tokens.
5. Run `/bailinghub workspaces`; optionally switch to another already-authorized workspace using
   `/bailinghub use <workspace>` before opening a new session.
6. Start a new conversation and explicitly select its fixed connection key before the first
   message. Wait for scope confirmation, then perform one read-only query. Separately prove an
   unselected or empty-scope conversation starts no business run or archive.
7. Perform one permitted mutation whose ACC governance does not require approval.
8. Exercise one approval-required or pending invocation and prove DSH resumes the exact original
   invocation id instead of repeating `invoke`.
9. Confirm BailingHub contains the same conversation, run, visible messages, legal completion
   status, public usage, and tool trajectory without hidden reasoning or raw credential material.
   With multiple authorizations, inspect each run's own call summary and the separate full-member
   visible conversation archive; a single-member reader cannot access mixed text.
10. Exercise `/bailinghub sync` only for a deliberately pending completion and prove it reuses the
   frozen completion payload.
11. Add a new connection name on the same public binding, authorize the same trusted identity, and
    confirm the older local connection is replaced. Add another name and authorize a different
    trusted identity; confirm both identities remain independently selectable and revocable. Then
    start login from an existing alias and return a different trusted identity: confirm the old
    alias and Session remain, the new identity receives a non-conflicting alias that becomes
    current, and `connections list|use` can select either one.
12. Explicitly select both independently authorized identities in one new conversation and verify
    matching tools select the correct original authorization per call. Scope changes after the first
    message require a new conversation; invalid members must not shrink the group or select defaults.
13. In another new conversation, select a shop and inventory target from different Client Apps or
    workspaces on the same Hub/audit domain. Verify each original target and same-named tool route,
    while an unselected target receives no input/context/search/invoke. A selected but unused target
    must not be marked executed. Verify system descriptions before tool search without creating runs,
    and duplicate/renamed subject names without replacing identity or archive state.
14. Reopen a saved locked conversation offline, then reconnect in the same runtime. Verify scope
    restoration and archive retry preserve the original members, identity, events, and acknowledgements.
    A lost upload acknowledgement must retry the same events without duplicating business actions.
    Confirmed revocation and storage conflicts remain blocked; known capture gaps remain visible.
15. Run `/bailinghub logout` and confirm the selected Agent Session is revoked and removed.

Native Code Mode must degrade rather than expose stale or unsafe dynamic schemas. Run the live
business checks in Native Tool Mode.

## Legacy 0.1.1 compatibility acceptance

Keep this evidence independent of native Agent Client acceptance. Repeat the affected legacy
checks when its patch/startup, authentication, Client API or original-job recovery behavior changes;
otherwise reference applicable unchanged evidence. A static bundle installation alone is not proof
that a live `/run` and `/jobs/{job_id}` task completed.

Use a second isolated profile and install the immutable exact version:

```bash
DSH_HOME="$dsh_release_home" dsh plugin --profile web add dsh-bailinghub@0.1.1
```

Supply a dedicated route-scoped Client Token through the legacy environment names, verify the
three `mcp__bailinghub__*` tools, submit one no-side-effect task exactly once with a stable
`request_id`, and follow the returned `job_id` to its terminal state. A bounded wait timeout must
not create a replacement task.

A live result proves that the identified Core version supports the old public `/run` and
`/jobs/{job_id}` Client API; retain its exact version and date when reusing it. It does not prove
native Agent Client behavior, and the native check does not prove legacy compatibility.

## OIDC publication and registry verification

1. Merge only a clean release commit after CI and the selected required acceptance gates pass.
   If the repository squashes a reviewed candidate, verify the final tree equals the tested tree
   and bind the immutable tag and npm source identity to the final commit.
2. Create an annotated immutable `v<version>` tag on that exact commit and push only the tag.
3. Confirm the `Publish` workflow passes `check:release-tag`, project verification and
   npm Trusted Publisher authentication. The audit above is a separate pre-tag gate.
4. For a prerelease, confirm npm uses the approved non-`latest` dist-tag. Stop if the workflow would
   change `latest` unintentionally.
5. Verify the exact npm version, `gitHead`, integrity, and provenance independently.
   The workflow reads the official exact-version endpoint before publishing. Only a clear 404 on
   its first Tag run permits a first publish; locked, rate-limited, unavailable or failed reads
   cannot be treated as absence. After npm accepts the package, read-only requests wait at most ten
   minutes for matching package name, version and `gitHead`. Each read is bounded to fifteen seconds
   and 256 KiB. No second visibility wait runs when preflight already verified the same identity.
   A rerun never republishes an unreadable version: it waits only for the original public metadata,
   then skips publication. If the previous attempt's acceptance is uncertain, inspect the original
   npm version state before recovery. This also stops conservatively when an earlier attempt failed
   before publishing. Do not add an override, replace the version, or infer publish failure from 404.
6. Download the official archive and verify its integrity, provenance, source identity and payload.
   Install that exact registry version into a second clean profile and repeat actual dependency,
   import and composition checks. Different compressed bytes from the candidate are not proof of
   changed contents, but require verification of the official integrity and payload before claiming
   equivalence. Earlier local-source or candidate installation cannot replace this gate.
7. Create the GitHub Release from the existing tag and record only the verified compatibility
   range and redacted acceptance result.

Useful registry checks:

```bash
dsh_release_version="$(node --print "require('./package.json').version")"
npm view "dsh-bailinghub@${dsh_release_version}" version gitHead dist.integrity --json
npm view "dsh-bailinghub@${dsh_release_version}" dist.attestations --json
```

The Trusted Publisher is configured for repository `bailinghub/bailinghub-dsh-plugin`, workflow
`publish.yml`, with no GitHub Environment. Versions after the historical `0.1.0` bootstrap must be
published only by that tagged OIDC workflow, never from a maintainer workstation.

## Stop and recovery conditions

Stop before tagging if the exact Core contract, SDK package, dependency lock, candidate package
resolution, secret scan or selected changed-surface acceptance is missing. Apply the explicit reuse
rule to earlier real evidence; do not silently omit a required authentication or legacy check.
Do not treat an already-running development profile as clean-install evidence.

An npm version and public Git tag are immutable:

- If authentication fails or publication stops before acceptance is established, inspect the
  original attempt and exact npm version state before recovery. The current preflight still stops
  a rerun on an unreadable version, including a 404 after an earlier pre-publish failure. Fixing
  authentication alone does not guarantee that a rerun can publish. Do not bypass the guard or
  infer non-acceptance from a failed read.
- If npm accepted the version but it remains processing/unreadable, use bounded read-only status
  checks. Once matching public metadata exists, the workflow can skip npm and recover later steps;
  never republish the accepted version. An identity mismatch requires investigation.
- If source or package content must change after a public tag, release the next version; never move
  or reuse the tag.
- If npm accepts the version but GitHub Release creation fails, create the Release from the
  existing tag without republishing.
- If an accepted package is unsafe, deprecate that exact version and fix forward. Rotate any
  exposed credential separately; unpublish is not a credential rollback.

After recovery, verify npm, the GitHub tag and Release, workflow provenance, exact dependency
resolution, and a clean registry installation independently.
