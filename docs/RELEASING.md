# Releasing

## Initial npm bootstrap

The npm package must already exist before npm can attach a GitHub Trusted Publisher. For the
first release only:

1. Push the exact clean release commit to the public repository and let CI pass.
2. Authenticate an npm account that owns the package name and complete its 2FA challenge.
3. From that exact clean commit, run `npm publish --access public --provenance=false`.
4. Verify `dsh-bailinghub@0.1.0` from the public registry.
5. Configure the Trusted Publisher for repository `bailinghub/bailinghub-dsh-plugin`, workflow
   `publish.yml`, environment unset, and publishing access enabled.
6. Tag the same commit as `v0.1.0`; the workflow should detect the existing version and finish
   without republishing it.

The one-time bootstrap is the only release without npm provenance. Later versions must publish
through the GitHub OIDC workflow.

## Normal release

1. Verify the target DeepSeek Harness release with a clean `web` profile.
2. Confirm the three `mcp__bailinghub__*` tools are discovered.
3. Run one no-side-effect submit and follow the same `job_id` to a terminal result.
4. Run `npm run verify` and `npm pack --dry-run`.
5. Confirm the package version and `v<version>` tag match.
6. Publish through npm trusted publishing, then verify installation from the registry.
7. Create a GitHub Release and update the compatibility table.

Do not publish a new version solely from static checks when the DSH compatibility version
changes. A single focused smoke is sufficient; a broad business-system test matrix is not a
release requirement for this bundle.
