# Releasing

## Release units and order

The Agent Client spans three independently versioned release units. Publish and verify them in
this dependency order:

```text
1. BailingHub Core
   Agent Auth, Runtime Context, capability governance, invoke/resume, completion, and audit

2. bailinghub-mcp-server
   the host-neutral `./sdk` export, browser authorization, credential storage, and DTO mapping

3. dsh-bailinghub
   native DSH lifecycle, commands, prompt/context projection, dynamic tools, and completion sync
```

Do not publish the DSH package before the exact SDK version in its ordinary dependency is publicly
installable. Do not publish the SDK before the matching Core contracts are released and available
for compatibility tests. A deployment-specific business adapter is an acceptance fixture, not a
fourth BailingHub package and not a dependency to publish from this repository.

The public `0.1.1` static MCP bundle is a separate compatibility path. Never move its tag, rewrite
its package, or silently reinterpret its Client Token and Hub-orchestrated semantics.

## Public manifest gates

The stable `0.2.0` manifest is publishable and must retain all of these properties:

```text
version: 0.2.0
publishConfig.access: public
publishConfig.provenance: true
dependency: bailinghub-mcp-server@0.2.0 (exact ordinary dependency)
```

For every public prerelease or stable version:

1. Keep npm public/provenance metadata enabled and do not add `private:true`.
2. Place one exact compatible `bailinghub-mcp-server` version in ordinary `dependencies`.
3. Keep the SDK out of `peerDependencies`, `peerDependenciesMeta`, and
   `optionalDependencies`.
4. Regenerate `package-lock.json`; both its root dependency and resolved package version must equal
   the exact manifest value.
5. Keep all install hooks absent. The package must not download code through `preinstall`,
   `install`, `postinstall`, or `prepare`.
6. Keep local paths, private deployment URLs, credentials, and business-specific identifiers out
   of the manifest, lockfile, Cordis patches, docs, tests, and tarball.

`scripts/check-project.mjs` enforces these properties. A stable plugin may depend only on an exact
stable SDK version.

For a public prerelease, publish both upstream SDK and DSH packages under an explicit prerelease
version and non-`latest` dist-tag such as `next`. Verify that the workflow actually supplies that
tag before pushing a public tag. Move `latest` only with an explicitly accepted stable release.

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
8. Run the project, package, clean-profile, live Agent Client, and legacy checks below.

The native host configuration remains exactly:

| Field | Environment value | Owner |
| --- | --- | --- |
| `hubUrl` | `BAILINGHUB_HUB_URL` | deployer |
| `clientAppId` | `BAILINGHUB_CLIENT_APP_ID` | Hub/business integrator |
| `workspace` | `BAILINGHUB_WORKSPACE` | Hub/business integrator; Agent Client v1 route id |
| `connectionName` | `BAILINGHUB_CONNECTION_NAME` | local end-user profile |

No Client Token, model key, business endpoint, authorization endpoint, signing secret, or business
credential belongs in the DSH plugin configuration.

## Source and tarball verification

Run from a clean release checkout with no production credentials in the environment or shell
history:

```bash
npm ci
npm run verify
npm audit --audit-level=low
npm pack --dry-run --json
npm pack --json
```

Inspect the exact tarball inventory. It should contain the public native runtime, selected Cordis
patch, user documentation, compatibility/security/privacy material, and package metadata. It must
not contain tests, local profiles, credentials, real deployment values, business payloads, editor
state, or a local tarball dependency.

Re-run the repository secret and local-path guard, then inspect the tarball independently for:

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

Use a dedicated non-production Hub client/workspace and a no-surprise business fixture. Never put
its credentials, private URL, authorization code, personal data, or raw payload into logs,
screenshots, release notes, or CI artifacts.

A separate `DSH_HOME` keeps DSH configuration, sessions, and logs apart, but macOS Keychain
credentials for the same Hub/client/workspace tuple are still shared. A different
`connectionName` is only an alias. Use a dedicated client app id or workspace before testing
logout or revocation.

In the isolated DSH Web profile:

1. Run `/bailinghub doctor`; before login it must identify the isolated connection as logged out
   without printing any credential, private endpoint, or model-provider key.
2. Run `/bailinghub login` and confirm the system browser opens the business authorization page.
3. Confirm the page shows the intended business identity, Hub client, requested workspace, and
   requested capability boundary before approval.
4. Complete the callback and verify `/bailinghub doctor` plus `/bailinghub status` without exposing
   access or refresh tokens.
5. Run `/bailinghub workspaces`; optionally switch to another already-authorized workspace using
   `/bailinghub use <workspace>` before opening a new session.
6. Start a new conversation and perform one read-only query.
7. Perform one permitted mutation whose ACC governance does not require approval.
8. Exercise one approval-required or pending invocation and prove DSH resumes the exact original
   invocation id instead of repeating `invoke`.
9. Confirm BailingHub contains the same conversation, run, user message, visible final assistant
   response, legal completion status, public usage, and tool trajectory without hidden reasoning or
   raw credential material.
10. Exercise `/bailinghub sync` only for a deliberately pending completion and prove it reuses the
   frozen completion payload.
11. Run `/bailinghub logout` and confirm the selected Agent Session is revoked and removed.

Native Code Mode must degrade rather than expose stale or unsafe dynamic schemas. Run the live
business checks in Native Tool Mode.

## Legacy 0.1.1 compatibility acceptance

Use a second isolated profile and install the immutable exact version:

```bash
DSH_HOME="$dsh_release_home" dsh plugin --profile web add dsh-bailinghub@0.1.1
```

Supply a dedicated route-scoped Client Token through the legacy environment names, verify the
three `mcp__bailinghub__*` tools, submit one no-side-effect task exactly once with a stable
`request_id`, and follow the returned `job_id` to its terminal state. A bounded wait timeout must
not create a replacement task.

This check proves that the newly released Core still supports the old public `/run` and
`/jobs/{job_id}` Client API. It does not prove native Agent Client behavior, and the native check
does not prove legacy compatibility.

## OIDC publication and registry verification

1. Merge only a clean release commit after CI and all acceptance evidence pass.
2. Create an annotated immutable `v<version>` tag on that exact commit and push only the tag.
3. Confirm the `Publish` workflow passes `check:release-tag`, project verification, package audit,
   and npm Trusted Publisher authentication.
4. For a prerelease, confirm npm uses the approved non-`latest` dist-tag. Stop if the workflow would
   change `latest` unintentionally.
5. Verify the exact npm version, `gitHead`, integrity, and provenance independently.
6. Install that exact registry version into a second clean profile and repeat dependency
   resolution plus composition checks.
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

Stop before tagging if the exact Core contract, SDK package, dependency lock, clean-profile
resolution, browser authorization, native trajectory, secret scan, or legacy check is missing.
Do not treat an already-running development profile as clean-install evidence.

An npm version and public Git tag are immutable:

- If authentication fails before npm accepts the unchanged package, fix the publisher and rerun
  the same tag workflow.
- If source or package content must change after a public tag, release the next version; never move
  or reuse the tag.
- If npm accepts the version but GitHub Release creation fails, create the Release from the
  existing tag without republishing.
- If an accepted package is unsafe, deprecate that exact version and fix forward. Rotate any
  exposed credential separately; unpublish is not a credential rollback.

After recovery, verify npm, the GitHub tag and Release, workflow provenance, exact dependency
resolution, and a clean registry installation independently.
