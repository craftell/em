---
name: em-lint
description: >-
  Validate and audit Event Modeling YAML files for schema errors, broken graph
  links, missing producers/consumers, orphan slices, contradictory events,
  query drift, and modeling smells. Use when the user asks to lint, validate,
  check, audit, review, or analyze an event model.
---

# EM Lint

You are an event-model validator. Report findings; do not edit model files unless
the user explicitly asks for fixes after seeing the report.

Read these references as needed:

- `references/config-format.md` for path resolution
- `references/yaml-format.md` for parser/schema rules
- `references/checks.md` for finding wording and check rationale
- `references/domain-events.md` for domain-event heuristics

## Activation

1. Locate the project root, or trust an explicit path from the user.
2. Read `.event-modeling/config.yaml`.
3. If config is missing, stop and report that paths cannot be resolved.
4. Resolve configured/default paths.
5. Read:
   - `events.yaml`
   - the optional configured actor registry, when present
   - `stories/*.yaml`
   - `**/*.feature.yaml` under the configured features directory
   - story-referenced slices
   - all `**/*<slice_extension>` files outside ignored directories
6. Build the graph:

```text
screen reads queries <- from_events <- events <- produces <- commands <- executes <- screen
```

## Checks

Run the full check set from `references/checks.md`:

- config, event registry, and actor registry checks
- story checks
- feature schema version, stable IDs, local references, repeated story or slice
  use within a timeline, and layout cycle checks
- slice schema checks
- within-slice references
- cross-slice graph checks
- domain-event validity heuristics
- slice modeling warnings
- graph info summaries

Treat timeline `after` as a layout constraint. Do not add its links to the domain
graph or report a missing business dependency from its absence. Unsupported
versions and malformed header pairs are F1 findings, not silent migrations.

Be conservative on domain-event warnings. Dispatch boundary events are valid when
they have a consumer slice.

## Report format

Return a Markdown report inline unless the user asks for a file:

```markdown
# Event Model Analysis: <project>

## Summary
- N slices across S stories
- U user screens, V system processors
- E events, C commands, Q queries
- X errors, W warnings

## Errors
...

## Warnings
...

## Event Flow
...

## Slice Dependency Map
...

## Story Coverage
...
```

Always include file paths, and line numbers when available. If there are no
errors or warnings, say so clearly.

Use the `emviz` skill for interactive review of findings. `em-lint` is an agent
skill, not an emviz CLI subcommand. Do not claim a validator command ran when the
report came from manual inspection.
