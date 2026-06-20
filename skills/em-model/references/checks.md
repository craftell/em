# Checks reference

Full list of checks the `em-lint` skill performs, with rationale
and suggested wording for findings. Read this when SKILL.md's summary isn't
enough — for instance, when a check is ambiguous or when you want consistent
phrasing across reports.

Severity legend: **E** = error, **W** = warning, **I** = info.

## Contents

- [Config & registry](#config--registry) — C1–C4
- [Stories](#stories) — S1–S4
- [Slice schema](#slice-schema) — L1–L9
- [Within-slice references](#within-slice-references) — W1–W2
- [Cross-slice graph](#cross-slice-graph) — G1–G3, G4a, G4b, G5–G7
- [Domain-event validity](#domain-event-validity) — D1–D5
- [Slice modeling](#slice-modeling) — M1–M4
- [Graph info](#graph-info) — I1–I3

## Config & registry

### C1 — `.event-modeling/config.yaml` is present (E)

**Why**: Without the config, paths can't be resolved. The skill stops here.

**Finding**: `.event-modeling/config.yaml` not found at <project-root>. Run
the `em-model` skill once to initialise it, or pass an explicit
`event-model/` path.

### C2 — `events.yaml` parses and is a map (E)

**Why**: The registry is the cross-slice contract for events. If it doesn't
parse or it's a list instead of a map, every G-check downstream is
unreliable.

**Finding**: `<events_file>` does not parse / is not a map of event names.
Expected shape: `{ EventName: { fields: "...", description?: "..." } }`.

### C3 — event names are PascalCase past-tense (W by default, E when unambiguous)

**Why**: Domain events name a fact that *happened*. Present tense or
non-verb keys usually indicate UI state or command-style naming.

**Heuristic**: PascalCase ending in `-ed`, `-en`, `-d`, or known irregular
past-tense forms (`Sent`, `Built`, `Made`, `Booked`, `Cancelled`,
`Submitted`, `Recorded`, `Created`). English past-tense detection has too
many irregulars to be reliable, so **default to warning**. Only escalate
to error when the name is unambiguously wrong: bare imperative verbs
(`Register`, `Book`), present-tense `-s`/`-ing` forms
(`Registers`, `Booking`), or pure nouns with no verb at all (`User`,
`Order`).

**Finding**: Event `<name>` in `events.yaml` does not look past-tense.
Domain events name facts that already happened — consider
`<suggested-name>`.

### C4 — every registry event has fields (E)

**Why**: Without fields the event is undocumented and slices can't agree on
its shape.

**Finding**: Event `<name>` in `events.yaml` has no `fields`. Add the field
shape (multi-line string).

## Stories

### S1 — story files are valid (E)

**Why**: Stories index slices; broken stories mean readers can't navigate.

**Finding**: `<stories_dir>/<story>.yaml` is missing required key `<key>`.

### S2 — slice paths resolve (E)

**Why**: A story listing a non-existent slice is misleading documentation.

**Finding**: Story `<story>` lists `<path>` but the file does not exist.

### S3 — no duplicate slice references (E)

**Why**: A slice in two stories produces ambiguity about ownership and
makes story-level metrics double-count.

**Finding**: Slice `<path>` is listed in stories `<a>` and `<b>`. Move it
to whichever story it belongs to.

### S4 — story size warning (W)

**Why**: Stories larger than ~15 slices stop being a coherent narrative.
This is a soft heuristic.

**Finding**: Story `<story>` has <n> slices. Consider splitting it into
multiple stories around natural seams (different actors, different
timeframes, different outcomes).

## Slice schema

These are direct mirrors of the parser rules in `em-model`'s
`references/yaml-format.md`. The Figma plugin enforces these on import — we
catch them earlier.

### L1 — valid YAML (E)

**Finding**: `<path>` does not parse: `<error>`.

### L2 — required top-level keys (E)

**Finding**: `<path>` is missing required key `slice` / `screen`.

### L3 — no top-level `events:` (E)

**Why**: Events are derived from `commands[].produces`. A top-level
`events:` block is from an old schema version and hard-fails the plugin.

**Finding**: `<path>` has a top-level `events:` block. Remove it; events
are documented in `events.yaml` and produced by `commands[].produces`.

### L4 — no `external:` key in commands/queries items (E)

**Why**: External signals enter via translator slices
(`screen.type: system`). The `external:` key inside `commands[]` or
`queries[]` items hard-fails the parser. A top-level `external:` key is
only a parser warning, but it still indicates a migration issue and should
be reported as an error in the review.

**Finding (inside item)**: `<path>:<line>` has `external:` inside a
commands[] or queries[] item. Model the external signal as a translator
slice with `screen.type: system` and use it as a `given` event in the
translator's GWT.

**Finding (top-level)**: `<path>` has a top-level `external:` key. This
is a parser warning, not a hard failure, but it signals an old schema
pattern. Remove it.

### L5 — `screen.type` is `user` or `system`; `actors` valid only on `user` (E)

**Finding (bad type)**: `<path>` has `screen.type: <value>` — must be `user` or
`system`.

**Finding (actors on system)**: `<path>` has `screen.actors` on a `system` screen.
`actors` is only valid when `screen.type` is `user`. Remove `actors` or change the
screen type.

### L6 — commands have `name`; `fields` is a string when present (W for missing fields)

**Why**: A missing `name` is a hard parser failure. A missing `fields` is not a
parser failure but leaves the command undocumented — flag as a warning.
A `fields` that is a YAML map instead of a block scalar will be silently ignored by
the parser, leaving the command undocumented — flag as a warning.

**Finding (missing name)**: Command in `<path>` is missing `name`. (Error — parser
rejects this.)

**Finding (missing fields)**: Command `<name>` in `<path>` has no `fields`. Add a
block scalar describing the command's inputs.

**Finding (fields as map)**: `fields` in `<path>:<line>` is a YAML map; rewrite as
a multi-line block scalar (`fields: |`).

### L7 — queries have `name`; `fields` is a string when present (W for missing fields)

(Same shape as L6 for queries.)

### L8 — GWT well-formed (E)

**Finding**: GWT item in `<path>:<line>` has invalid `type: <value>`.
Allowed: `event`, `command`, `query`, `error`.

### L9 — no duplicates within a list (E)

**Why**: The plugin treats names case-insensitive and
whitespace-normalized; a duplicate is a hard error.

**Finding**: `<path>:<line>` lists `<name>` twice in `<list>`.

## Within-slice references

### W1 — `screen.executes` resolves (E)

**Finding**: `<path>` declares `screen.executes: [<name>]` but no command
named `<name>` exists in the slice.

### W2 — `screen.reads` resolves within the same slice (E)

**Why**: `screen.reads` names must resolve to a query defined in the
**same slice**. The parser does not support cross-slice query references
in `screen.reads` — it will hard-fail on any name that isn't in the
slice's own `queries[]`. Note: cross-slice references in `from_events`
(not `screen.reads`) are supported.

**Finding**: `<path>` declares `screen.reads: [<name>]` but no query
named `<name>` is defined in the same slice. Define the query in this
slice or remove the reference.

## Cross-slice graph

### G1 — produced events exist in registry (E)

**Finding**: Command `<command>` in `<path>` produces `<event>` but the
event isn't in `events.yaml`. Add it to the registry with a `fields` block.

### G2 — consumed events exist in registry (E)

**Finding**: Query `<query>` in `<path>` reads `<event>` but the event
isn't in `events.yaml`. Add it to the registry, or fix the typo.

### G3 — missing producers (E)

**Why**: An event no command produces is either unimplemented work or a
missing translator slice for an external signal.

**Finding**: Event `<event>` is read by `<query>` in `<path>` but no
command in any slice produces it. Either add the producing command/slice,
or model the source as a translator slice.

### G4a — orphaned state-change events (W)

**Why**: An event with a state-change name (`*Created`, `*Updated`,
`*Placed`, `*Sent`, `*Recorded`, `*Cancelled`, etc.) that no slice
consumes is almost always a missing **view slice**. The state change
happened, but no read model projects it for display.

**Trigger**: event is produced by at least one command, no query has it
in `from_events:`, and the event name matches a state-change verb pattern
(see `domain-events.md` for red-flag verbs).

**Finding**: Event `<event>` is produced by `<command>` in `<path>` but
no query consumes it. This looks like a state-change event with a missing
view slice. Add a view slice whose query reads this event via
`from_events:`. If the event is intentionally fire-and-forget (audit
log, analytics-only), say so explicitly in `events.yaml`'s description
and the warning can be ignored.

### G4b — orphaned dispatch boundary events (W)

**Why**: An event with a dispatch boundary name (`*Requested`,
`*Triggered`, `*Scheduled`, `*Enqueued`, `*Dispatched`, `*Required`)
that no slice consumes via `from_events:` is *almost always* a
**missing connection on a processor slice**, not a useless event. The
entry-point slices produce the request, but the processor slice's query
forgot to declare `from_events: [...]` for it.

The honest fix is usually adding the missing `from_events:` connection,
not deleting the event. Deleting hides a real domain dispatch boundary.

**Trigger**: event is produced by at least one command, no query has it
in `from_events:`, and the event name ends in one of the dispatch
boundary verbs above.

**Finding**: Event `<event>` is produced by `<command>` in `<path>` but
no query consumes it. The name pattern (`*Requested` / `*Triggered` /
`*Scheduled` / `*Enqueued`) suggests this is a dispatch boundary event.

Check the processor/automation slices in story `<story>`:

- If a system slice (`screen.type: system`) consumes this dispatch in
  the real implementation, its query is missing a
  `from_events: [<event>]` connection — add it.
- If no slice actually needs to react to this dispatch, the event is
  genuinely unused — delete it from `events.yaml` and from every
  `produces:` block.

Do not suggest "add a view slice" for dispatch boundary events —
processors, not views, consume them.

### G5 — orphaned registry events (W)

**Finding**: Event `<event>` is in `events.yaml` but no slice produces or
consumes it. Either remove it or wire it up.

### G6 — phantom query references (E)

**Finding**: `<path>` declares `screen.reads: [<name>]` but no `queries[]`
entry in any slice has that name. Define the query, or fix the typo.

### G7 — duplicate query definitions (W)

**Why**: Two slices defining the same query with different shapes means
the read model has split. Pick the canonical definition.

**Finding**: Query `<name>` is defined in `<path-a>` and `<path-b>` with
different `fields` / `from_events`. Reconcile or rename.

## Domain-event validity

These rest on the **two-part Domain Event Litmus Test** from the
`em-model` skill:

- **Test (a) state-change**: would this fact be written to the database /
  event store and need to survive an app restart?
- **Test (b) dispatch boundary**: does it represent a meaningful handoff
  between an entry-point slice and a processor slice, such that an
  event-driven implementation would naturally persist it (Sidekiq job,
  outbox row, queue entry)?

An event qualifies if either test (a) or test (b) is YES. The D-checks
below target events that fail BOTH. Before raising a D-warning against a
`*Requested` / `*Triggered` / `*Scheduled` / `*Enqueued`-style event,
verify it has no consumer slice — if it has one, test (b) passes and the
warning is wrong. (If it has no consumer, use G4b instead.)

### D1 — red-flag verbs (W)

**Why**: These verbs almost always describe UI/runtime state, not stored
facts.

**Verbs**: `Selected`, `Shown`, `Viewed`, `Clicked`, `Opened`, `Closed`,
`Ticked`, `Incremented`, `Reached`, `Displayed`, `Navigated`.

**Note**: `Started` and `Stopped` are deliberately omitted from this
list because they often appear in legitimate domain events
(`NurturingStarted`, `JobStopped`); flag only when the surrounding
context confirms UI/runtime meaning.

**Finding**: Event `<name>` contains the red-flag verb `<verb>`. Apply
the Litmus Test (a) and (b): is this fact persisted, or does it represent
a dispatch boundary with a consumer slice? If neither, remove it; the
underlying domain change (if any) is the real event.

### D2 — UI interaction events (W)

**Finding**: Event `<name>` reads as a UI interaction (button click,
navigation, SDK callback). UI interactions belong in the front end, not
the event log.

### D3 — ephemeral runtime events (W)

**Finding**: Event `<name>` describes runtime state (timer, animation,
playback, session). Runtime state is not a domain fact.

### D4 — derived/computed events (W)

**Finding**: Event `<name>` looks computed (`Calculated`, `Reached`,
`Total`). Compute it on read as a query field instead of storing it as an
event.

### D5 — over-modeled stories (W)

**Finding**: Story `<story>` has <n> slices but only <m> produce events,
all of them with red-flag verbs. The story may describe pure UI behavior
that doesn't belong in the event model.

## Slice modeling

### M1 — command slices missing GWT (W)

**Finding**: Command slice `<path>` has no `gwt` block. Most commands
have at least one rule violation or edge case worth documenting.

### M2 — orphan slice files (W)

**Finding**: `<path>` exists on disk but no story lists it. Either add it
to a story, or delete it.

### M3 — queries read by no screen (W)

**Finding**: Query `<name>` in `<path>` is never referenced in any
`screen.reads`. The projection is dead code.

### M4 — event-to-command-slice ratio (W)

**Why**: Most command slices produce exactly one event. A ratio above 2:1
usually means UI/runtime events have crept in.

**Finding**: <events> events / <command_slices> command slices = <ratio>.
Review the registry — many domain models settle around 1:1.

## Graph info

### I1 — event flow summary

Table: every event in the registry, with its producing (command, slice)
and consuming (query, slice) pairs.

### I2 — slice dependency map

Table: every slice, with the slices whose events it reads and the slices
that read its events.

### I3 — islands

Connected components in the slice-dependency graph. More than one island
may indicate clean bounded contexts — or missing connections, depending
on the domain.
