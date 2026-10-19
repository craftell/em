# Repository instructions

## Keep skills aligned with behavior

When changing model schemas, validation, CLI commands, viewer behavior, or feedback workflows, update the affected skills in `skills/` in the same pull request. Do not leave skill updates for a later task.

- Update each affected `SKILL.md` and its supporting references to match the implemented behavior and compatibility rules.
- Edit shared references in `skills/_shared-source/references/`, then run `pnpm skills:sync` to refresh the copies in `em-model`, `em-lint`, and `em-extract`. Preserve skill-specific companion files.
- Add or update cases in the affected `skills/*/evals/evals.json`. Distinguish authored cases from agent evaluations that actually ran.
- Update `.agents/skills/verify-emviz/` when the change affects a verification journey. Record only checks that actually ran.
- Before reporting completion, run `pnpm check` and `pnpm test`, validate affected skills with `pnpm skills:validate` when its validator is available, and verify that shared copies match. Report any blocked or unrun checks explicitly.

For a change that does not affect a skill, state why no skill update is needed in the pull request.
