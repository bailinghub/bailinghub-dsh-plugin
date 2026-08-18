# Releasing

## Release model

`dsh-bailinghub` is a small configuration bundle. Release confidence comes from keeping its
pinned versions and documentation aligned, then running one focused compatibility smoke. A
broad business-system E2E matrix is not required.

The `v0.1.0` package was the one-time manual npm bootstrap and therefore has no npm provenance.
The Trusted Publisher is configured for repository `bailinghub/bailinghub-dsh-plugin`, workflow
`publish.yml`, with no GitHub Environment. Every later version must be published by that tagged
workflow through GitHub OIDC; do not publish a later version from a maintainer workstation.

## Version update surface

For every release:

1. Run `npm version <version> --no-git-tag-version` so `package.json`, `package-lock.json`, and
   the lockfile root package stay aligned. Do not let this command create the Git tag.
2. Add the release entry to `CHANGELOG.md`.
3. Update the pinned plugin version in the install commands in `README.md` and
   `docs/README.zh-CN.md`.
4. Update `docs/COMPATIBILITY.md` only from compatibility evidence gathered for the release.
5. Run the focused smoke and local verification below before merging the release pull request.

When the supported DeepSeek Harness version changes, also update both README prerequisites and
install commands, then repeat the clean-profile smoke against that exact Harness version.

When the `bailinghub-mcp-server` pin changes, update all of these together:

- `cordis.patch.yml`;
- the expected command in `scripts/check-project.mjs` and `tests/bundle.test.mjs`;
- the supply-chain text in both READMEs and `SECURITY.md`;
- `docs/COMPATIBILITY.md` and `CHANGELOG.md`.

When tool names, environment variables, or the Client API contract change, update the bundle,
both READMEs, tests, compatibility table, and project-boundary documentation in the same pull
request. Generic MCP or BailingHub behavior still belongs in its owning repository, not here.

Before editing pins, check current upstream versions without automatically adopting them:

```bash
npm view @deepseek-ai/dsh@latest version
npm view bailinghub-mcp-server@latest version
```

An upstream release is a prompt to recheck compatibility, not evidence that this bundle already
supports it.

## Focused compatibility smoke

Use a clean temporary DSH home and the tarball that will be published. Keep production tokens and
payloads out of shell history, screenshots, logs, and compatibility reports.

```bash
npm ci
npm run verify
npm pack --dry-run --json
npm audit --audit-level=low
npm pack --json
```

With the exact target DSH version installed, create a temporary profile outside any normal DSH
home and install the generated tarball into the `web` profile:

```bash
dsh_release_version="$(node --print "require('./package.json').version")"
dsh_release_home="$(mktemp -d)"
DSH_HOME="$dsh_release_home" dsh plugin --profile web add "./dsh-bailinghub-${dsh_release_version}.tgz"
DSH_HOME="$dsh_release_home" dsh --profile web --dump-config
```

Use only placeholder credentials while inspecting dumped configuration. Confirm that the composed
profile contains the BailingHub bundle, the in-box DSH MCP Client, the exact pinned MCP Server, and
the expected `serverName`, timeout, and fail-closed startup setting.

For the single live check, start that same temporary profile with a dedicated non-production
BailingHub Client Token and route. Confirm all three `mcp__bailinghub__*` tools are discovered,
submit one no-side-effect request with a stable `request_id`, and follow the returned `job_id` to a
terminal result. A bounded-wait timeout is not a reason to submit again. Discard the temporary DSH
home after recording redacted versions and the pass/fail result.

This one install, discovery, submit, and same-job follow-up is the release smoke. Do not expand it
into an adapter or business-system test matrix unless a real regression requires that evidence.

## Normal OIDC release

1. Merge the clean release pull request after CI passes.
2. Create an annotated `v<version>` tag on that exact merged commit and push only that tag.
3. Confirm the `Publish` workflow passes `check:release-tag`, project verification, and npm
   Trusted Publisher authentication.
4. Verify the exact public version, its `gitHead`, integrity, and provenance on npm.
5. Install the exact registry version into another clean DSH profile and repeat the composition
   check.
6. Create the GitHub Release from the existing tag and include the verified compatibility range.

Useful registry checks:

```bash
dsh_release_version="$(node --print "require('./package.json').version")"
npm view "dsh-bailinghub@${dsh_release_version}" version gitHead dist.integrity --json
npm view "dsh-bailinghub@${dsh_release_version}" dist.attestations --json
```

The first real OIDC publication after the manual bootstrap must explicitly verify the npm
provenance record. A green workflow that only reports the version already exists does not prove
OIDC publication.

## Immutable npm recovery

An npm package version and a public Git tag are immutable release evidence. Never move or reuse a
published tag, and never expect an unpublished npm version to become reusable.

- If OIDC or registry access fails before npm accepts the package and no source change is needed,
  fix the Trusted Publisher or workflow setting and rerun the same unchanged tag workflow.
- If a source or package change is needed after the tag is public, prepare the next patch version
  and create a new tag; do not rewrite the old tag.
- If npm accepted the version but GitHub Release creation failed, create the GitHub Release from
  the existing tag. Do not republish the package.
- If an accepted npm version is defective or unsafe, deprecate that exact version with a concise
  migration message, fix forward in the next patch release, and rotate any exposed credential
  separately. Do not rely on unpublish as rollback.

After recovery, verify npm, the GitHub tag and Release, the workflow run, and a clean registry
installation independently before recording the release as complete.

## Historical initial npm bootstrap

The npm package must already exist before npm can attach a GitHub Trusted Publisher. For the
first release only, the completed `v0.1.0` bootstrap used this sequence:

1. Push the exact clean release commit to the public repository and let CI pass.
2. Authenticate an npm account that owns the package name and complete its 2FA challenge.
3. From that exact clean commit, run `npm publish --access public --provenance=false`.
4. Verify `dsh-bailinghub@0.1.0` from the public registry.
5. Configure the Trusted Publisher for repository `bailinghub/bailinghub-dsh-plugin`, workflow
   `publish.yml`, environment unset, and publishing access enabled.
6. Tag the same commit as `v0.1.0`; the workflow should detect the existing version and finish
   without republishing it.

This historical exception must not be repeated for `v0.1.1` or later.
