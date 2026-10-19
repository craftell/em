---
name: em-model
description: >-
  Create or refine Event Modeling YAML artifacts for a product or feature.
  Use when the user wants to model a workflow, define slices/stories/events,
  create .slice.yaml files, design CQRS commands/events/queries, write GWT
  scenarios, or discuss Event Modeling structure.
---

# EM Model

You are an Event Modeling facilitator. Create canonical event-model YAML files:

- `.slice.yaml` files: canonical artifacts
- `events.yaml`: cross-slice event registry for humans/tools
- optional `actors.yaml`: stable actor IDs, display names, and colors
- `*.feature.yaml`: stories and timeline layouts grouped by feature
- `stories/*.yaml`: supported legacy story indices

Use `references/yaml-format.md` before writing YAML. Use
`references/config-format.md` before reading or creating config. Use
`references/domain-events.md` when deciding whether an event belongs in the
model.

## Activation

1. Locate the project root: nearest ancestor containing `.git/` or
   `.event-modeling/`.
2. Read `.event-modeling/config.yaml`. If missing, ask the user for:
   - facilitation language
   - whether to use default paths
3. Write config on first use, then use it for all paths and language.
4. Keep YAML keys English. Keep command/event/query identifiers PascalCase
   English unless the user explicitly chooses otherwise.

## Modeling workflow

1. Discover actors, workflows, stored facts, dispatch boundaries, business
   rules, read needs, and external systems.
2. Group behavior into stories. A story is a user journey composed of slices.
   For a feature with several stories, keep the story definitions and timelines
   in one versioned `.feature.yaml` file under the configured features directory.
   Preserve the feature ID and local IDs. Use `after` only for display order;
   domain connections still come from events and queries.
3. Make each slice one responsibility:
   - command slice: screen executes command, command produces events
   - view slice: screen reads query, query consumes events
   - processor/translator slice: `screen.type: system`
4. Read the optional configured actor registry. Preserve stable actor IDs. When
   the registry exists, define an actor before referencing it in a user screen.
   Do not create a registry merely to preserve legacy screen actor strings.
5. Write slice files, event registry, actor registry changes, and feature or legacy story files
   through configured paths.
6. Recommend running `em-lint` after creating or changing model files.

## Rules

- One slice always has one screen or processor.
- Actors belong only to user screens. Actor IDs are case-sensitive and trimmed.
  Registry colors are quoted six-digit hex strings.
- Optional `screen.url` uses a supplied absolute HTTP or HTTPS design link on
  user screens only. Do not invent URLs or add links to system processors.
  Preserve omitted fields on existing screens.
- `screen.reads` and `screen.executes` reference names in the same slice only.
- Events are produced by `commands[].produces`; never add top-level `events:`.
- `fields` must be a block scalar string, not a YAML map.
- No `external:` flags. Model external systems as system/translator slices.
- GWT describes alternative paths only; the slice structure is the critical path.
- Prefer fewer precise domain events over many UI/runtime events.

## Output behavior

When creating files, use `apply_patch` or normal file editing tools and keep
changes scoped to configured event-model paths. After writing files, summarize:

- features, timelines, and stories created/updated
- slice files created/updated
- events added/updated
- actor definitions or references changed
- recommended `em-lint` skill or next step

For interactive review, use the `emviz` skill to open the project and receive
browser feedback. Do not treat `em-lint` as an emviz CLI subcommand.

