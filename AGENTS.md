# Repository instructions

## Keep skills aligned with behavior

When changing model schemas, validation, CLI commands, viewer behavior, or feedback workflows, update the affected skills in `skills/` in the same pull request. Do not leave skill updates for a later task.

- Update each affected `SKILL.md` and its supporting references to match the implemented behavior and compatibility rules.
- Edit shared references in `skills/_shared-source/references/`, then run `pnpm skills:sync` to refresh the copies in `em-model`, `em-lint`, and `em-extract`. Preserve skill-specific companion files.
- Add or update cases in the affected `skills/*/evals/evals.json`. Distinguish authored cases from agent evaluations that actually ran.
- Update `.agents/skills/verify-emviz/` when the change affects a verification journey. Record only checks that actually ran.
- Before reporting completion, run `pnpm check` and `pnpm test`, validate affected skills with `pnpm skills:validate` when its validator is available, and verify that shared copies match. Report any blocked or unrun checks explicitly.

For a change that does not affect a skill, state why no skill update is needed in the pull request.

## Prepare a release in every change PR

Include an appropriate `packages/cli/package.json` version bump and release metadata in the same PR as each fix or feature. Do not defer the bump to a separate release PR.

- Use a patch bump for backward-compatible fixes, a minor bump for backward-compatible features, and a major bump for breaking changes.
- Recheck the latest main version before finishing. Resolve competing version bumps before merge.
- Update current pinned CLI references and add `docs/releases/<version>.md` with behavior, compatibility, and actual verification evidence. Preserve historical release notes.
- Keep private workspace-package versions independent. Update the lockfile only if its recorded data changes; it does not store the CLI package's own version.
- Verify the release path and state any remaining approval or publishing step. A version bump alone is not evidence of publication.
- Do not merge, push release tags, publish packages, or remove approval gates without the user's authorization.
