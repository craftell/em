# Feature timelines

A feature file keeps story definitions and their timeline presentations together.
Slice files keep commands, events, queries, and screens separate.

## File structure

emviz discovers `**/*.feature.yaml` under `paths.features_dir`.
For example, place this file at
`event-model/features/customer-onboarding/customer-onboarding.feature.yaml`:

```yaml
kind: feature
schema_version: 1
id: customer-onboarding
name: Customer onboarding
stories:
  - id: registration
    name: Register customer
    slices:
      - event-model/features/customer-onboarding/register-customer/register-customer.slice.yaml
  - id: welcome
    name: Send welcome email
    slices:
      - event-model/features/customer-onboarding/send-welcome-email/send-welcome-email.slice.yaml
  - id: home
    name: View customer home
    slices:
      - event-model/features/customer-onboarding/view-customer-home/view-customer-home.slice.yaml
timelines:
  - id: overview
    name: Onboarding overview
    steps:
      - id: register
        story: registration
      - id: email
        story: welcome
        after: [register]
      - id: dashboard
        story: home
        after: [register]
  - id: customer-view
    name: Customer view
    steps:
      - id: register
        story: registration
      - id: dashboard
        story: home
        after: [register]
```

The [sample file](examples/customer-onboarding.feature.yaml)
references existing repository slices. It stays outside the discovered model directories.
To try it in a disposable copy, put it at the path above and remove the equivalent
`event-model/stories/customer-onboarding.yaml` from that copy. Keep the slice files.

## Why stories and timelines share a file

A feature file keeps short story definitions beside the presentations that use
them. A separate file for every timeline and story would add references and
navigation without moving much content out of the feature file.

The viewer selects a timeline over the canonical model instead of cloning a
graph for every occurrence. Events and feedback targets retain their canonical
identities. This choice currently prevents repeating a story or slice within
one timeline. Another timeline can reuse the same stories.

## Schema version 1

A feature document requires `kind: feature`, numeric `schema_version: 1`, a
project-unique `id`, a display `name`, a `stories` array, and a `timelines` array.
The schema version describes the YAML format, not the emviz package version.

Each story has a feature-local `id`, a `name`, and a `slices` array.
An optional `description` explains the journey.
Slice references are project-root-relative paths, even when the feature file is nested.
Absolute paths and parent traversal are invalid.

Each timeline has a feature-local `id`, a `name`, and a nonempty `steps` array.
Each step has a timeline-local `id` and a `story` reference to a story in the same feature.
Its optional `after` array refers to step IDs in that timeline.

Story and timeline identity combines the feature ID with the local ID.
Renaming a display name does not change that identity.
Moving the feature file preserves those IDs if the feature ID and local IDs stay unchanged.
Moving a story to a different feature ID changes its identity.
Slice identity still follows its source path.

## Layout order and domain connections

`after: [register]` places a story after the registration step.
Both `email` and `dashboard` follow `register`; neither follows the other.
Their sibling placement means no relative order was specified. It does not assert
simultaneous execution.

A step with `after: [email, dashboard]` follows both steps in the layout.
This is a visual join, not a runtime wait condition or an AND business rule.
Omitting `after` adds no predecessor constraint.
The renderer calculates positions without a project-wide sequence number.

The domain graph still comes from screen reads and executes, command produces,
and query from_events. Timeline order creates no domain edge.
Two stories can appear next to each other without a causal relationship.
Do not add a fictitious event or query just to change their positions.

A story can appear in several timelines.
Within one timeline, a story can appear only once, and its slice paths cannot
also appear in another step. Repeated execution and loops need separate modeled
occurrences or a future schema extension.

## Viewer selection

Use the toolbar's **Timeline** selector to choose a timeline.
The default **All stories** view keeps the existing overview.
Actor filters apply within the selected timeline.
In diff views, timeline selection is disabled and the canvas shows all stories so
removed model elements remain available for review. Returning to Current restores
the selected timeline preference. A layout-change notice flags changed timeline
metadata; it does not draw old and new timeline layouts side by side.

## Story summaries and connection visibility

Each story header shows its slice count and can expand or collapse the story.
The toolbar's **Expand all stories** and **Collapse all stories** controls apply
to the current view. Collapse preferences are stored locally in the browser,
separately for each project and timeline, using stable IDs. Renaming a display
name does not change that identity. Unavailable or malformed storage must not
prevent the viewer from working.

The global **Edge visibility** selector defaults to **Auto**: intra-slice edges
are visible; selecting a slice reveals all its incident cross-slice edges, and
selecting an ordinary node reveals that node's incident cross-slice edges.
**Intra-slice only** hides cross-slice edges regardless of selection. **All**
shows all domain edges permitted by the current timeline and filters. Details
still lists canonical incoming/outgoing connections in every mode.

Collapsed-story connections summarize real domain edges and respect the edge
mode. An `after` relation never creates a connection between story summaries.
Use All and expanded stories when comparing the complete rendered domain graph.

Selection, search/history, connection hover/clicks, and story expand/collapse
preserve the viewport. Use **Focus selected node** or the canvas fit control for
deliberate movement; focusing a node inside a collapsed story centers its summary.

## Validation and compatibility

Feature-format errors appear as F1 findings. These include an unsupported schema
version, duplicate IDs, unknown story or predecessor references, repeated stories
or slices in one timeline, and cycles in `after`.
An invalid timeline is excluded from selectable timelines.
Structural feature or story errors prevent that feature's timelines from loading.
Read the findings instead of relying on a partial canvas.

Existing standalone story, slice, event-registry, and actor-registry files remain valid
without headers. To add headers, supply both `kind` and `schema_version: 1`.
Their kinds are `story`, `slice`, `events`, and `actors`, respectively.
A mismatched kind, unsupported version, or incomplete header pair produces an F1 finding.
A new feature document always requires its headers.

Keep existing files during an incremental migration. Move a story definition into a
feature file when you want to maintain it there, and remove the old duplicate definition
as a deliberate model change. emviz does not migrate or rewrite your YAML automatically.

## Companion references

The canonical skill references live in `skills/_shared-source/references/`.
After editing them, run `pnpm skills:sync` to refresh the copies for
`em-model`, `em-lint`, and `em-extract`.
