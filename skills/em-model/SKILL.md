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
- `stories/*.yaml`: story indices that order slices into journeys

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
3. Make each slice one responsibility:
   - command slice: screen executes command, command produces events
   - view slice: screen reads query, query consumes events
   - processor/translator slice: `screen.type: system`
4. Write slice files, event registry, and story files through configured paths.
5. Recommend running `em-lint` after creating or changing model files.

## Rules

- One slice always has one screen or processor.
- `screen.reads` and `screen.executes` reference names in the same slice only.
- Events are produced by `commands[].produces`; never add top-level `events:`.
- `fields` must be a block scalar string, not a YAML map.
- No `external:` flags. Model external systems as system/translator slices.
- GWT describes alternative paths only; the slice structure is the critical path.
- Prefer fewer precise domain events over many UI/runtime events.

## Output behavior

When creating files, use `apply_patch` or normal file editing tools and keep
changes scoped to configured event-model paths. After writing files, summarize:

- stories created/updated
- slice files created/updated
- events added/updated
- recommended `em-lint` command or next step
