# `.event-modeling/config.yaml`

Per-project configuration for the `em-*` skills. Lives at
`<project-root>/.event-modeling/config.yaml`. Created on first use; reused on
every subsequent session.

The skill reads this file at the start of every activation. Two purposes:

1. **Lock the facilitation language** so the skill keeps using the same language
   across sessions.
2. **Locate the project's event-modeling output directories** so skills write
   to the right place without re-asking.

## Schema

```yaml
# Required. Facilitation language.
language: ja                    # ISO 639-1 code or free-text name (e.g. "ja", "en", "Japanese")

# Optional. Output paths. All paths are relative to the project root.
paths:
  event_model_dir: event-model        # holds events.yaml and stories/
  features_dir: src/features          # parent of <story-slug>/<slice-slug>/
  slice_extension: .slice.yaml        # extension for slice files
  events_file: event-model/events.yaml
  stories_dir: event-model/stories

# Optional. Free-form notes the user can add. The skill does not interpret these.
notes: |
  Multi-line scratchpad for project-specific conventions.
```

## Defaults

When a key is absent, the skill applies these defaults:

| Key | Default |
|---|---|
| `paths.event_model_dir` | `event-model` |
| `paths.features_dir` | `src/features` |
| `paths.slice_extension` | `.slice.yaml` |
| `paths.events_file` | `<event_model_dir>/events.yaml` |
| `paths.stories_dir` | `<event_model_dir>/stories` |

`events_file` and `stories_dir` derive from `event_model_dir` unless the user
overrides them. So in most projects, customising `event_model_dir` is enough.

`language` has no default — the skill must ask on first run.

## First-run behavior

If the file is missing:

1. Ask the user for the facilitation language. Phrase the question in English
   the very first time, since you don't know the user's preference yet.
2. Ask whether the default paths are fine, or whether to customise them. Offer
   the defaults as the first option.
3. Write `.event-modeling/config.yaml` populated with the answers. Omit any
   keys the user accepted as default — the skill applies defaults at read time.
4. Confirm in the chosen language that future sessions will reuse this config,
   and where the file lives so the user can edit it later.

## Migration / changing the language later

If the user asks to switch languages mid-session, update `language:` in the
config file and confirm. New YAML output uses the new language; existing free
text stays as-is unless the user explicitly asks to retranslate.

## Path resolution

When generating files, always compose paths through this config:

- Slice file:
  `<features_dir>/<story-slug>/<slice-slug>/<slice-slug><slice_extension>`
- Events registry: `<events_file>`
- Story file: `<stories_dir>/<story-slug>.yaml`

`<story-slug>` and `<slice-slug>` are kebab-case ASCII derived from the human
slice/story names. Use English ASCII slugs even when the configured language is
non-Latin — directory names show up in tooling that may not handle Unicode
well.

## Example

```yaml
language: ja
paths:
  event_model_dir: docs/event-model
  features_dir: apps/web/features
  slice_extension: .slice.yaml
notes: |
  events_file と stories_dir はデフォルト (event_model_dir 配下) を利用。
```

In this example, slices land in `apps/web/features/<story>/<slice>/<slice>.slice.yaml`,
events.yaml lives at `docs/event-model/events.yaml`, and stories at
`docs/event-model/stories/`.
