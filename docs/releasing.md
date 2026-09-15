# Releasing emviz

Publishing a stable GitHub Release tagged `emviz-vX.Y.Z` triggers npm publication through GitHub Actions and trusted publishing, with provenance. Pushing a tag alone does not publish. Drafts and prereleases do not publish.

## One-time migration from staged publishing

Before publishing the first Release with this workflow, a maintainer must review the npm trusted publisher settings for `emviz`:

```text
Provider: GitHub Actions
Repository owner: craftell
Repository: em
Workflow filename: publish-npm.yml
Environment name: npm-publish
```

The old configuration allowed only `npm stage publish`. It must permit direct `npm publish` for this workflow. Confirm that the package's publishing policy also permits direct trusted publishing. Do not add an npm token or weaken account protections to work around a failure.

The GitHub environment remains `npm-publish`. Keep any required reviewers and restrict deployment tags to `emviz-v*`. If reviewers are required, their approval is still required before publication.

## Normal release

Commit all intended changes on `main`, then run:

```sh
pnpm release:patch
```

Use `pnpm release:minor` for new features or `pnpm release:major` for breaking changes.

The script checks for a clean `main`, bumps `packages/cli/package.json`, updates the lockfile, runs checks/tests/pack validation, commits the version, and creates a local `emviz-vX.Y.Z` tag. It does not push or publish.

Review the commit and package, then run the command printed by the script in your terminal:

```sh
git push --atomic origin main emviz-vX.Y.Z
```

On GitHub, open Releases, draft a new release, select the existing tag, add release notes, and click **Publish release**. Do not mark it as a prerelease. This is the approval to publish the package to npm.

Wait for **Publish npm package** to pass. Approve the GitHub environment if prompted. No npm staged approval is needed.

Verify:

```sh
npm view emviz version
npx emviz@X.Y.Z --help
```

## Recovery

- If tag and package versions differ, the workflow stops before publication. Fix the version and create a new release tag rather than moving a published tag.
- If npm rejects the publishing permission, check the trusted publisher and package policy described above. Do not fall back to a token automatically.
- If provenance validation fails, confirm that `packages/cli/package.json` points to `https://github.com/craftell/em`.
- npm versions are immutable. If a published package is wrong, prepare a corrected patch version.
- Publishing a GitHub Release does not guarantee npm publication succeeded. Check the Actions result and npm version.
