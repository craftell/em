# YAML Format Reference

The canonical format for every file the `em-model` skill produces. The
**slice file** is the canonical artifact parsed by Event Modeling tooling, so
its schema must stay exact. event registry, story indices, and feature timelines describe how those artifacts
fit together. Feature documents use the versioned structure below.

## Table of contents

1. [Slice file (`*.slice.yaml`)](#slice-file)
2. [Command slice example](#command-slice-example)
3. [View slice example](#view-slice-example)
4. [Automation slice example](#automation-slice-example)
5. [Translation slice example](#translation-slice-example)
6. [`event-model/events.yaml` (documentation)](#event-modeleventsyaml-documentation)
7. [Standalone story files (legacy-compatible)](#standalone-story-files-legacy-compatible)
8. [Field types](#field-types)
9. [GWT reference](#gwt-reference)
10. [Validation rules tooling enforces](#validation-rules-tooling-enforces)
11. [Actor registry](#actor-registry)
12. [Feature timelines](#feature-timelines)
13. [Document headers](#document-headers)

---

## Slice file

One file per slice. Path resolved through the project config:
`<features_dir>/<story-slug>/<slice-slug>/<slice-slug><slice_extension>`.

### Top-level keys

| Key | Required | Type | Notes |
|---|---|---|---|
| `kind` | no | string | If supplied, use `slice` and supply `schema_version` too. |
| `schema_version` | no | number | Supported value: `1`. See document headers below. |
| `slice` | yes | string | Human-readable slice title. Free text in the configured language. |
| `screen` | yes | object | Exactly one. See [Screen block](#screen-block). |
| `commands` | no | array | Command objects. |
| `queries` | no | array | Query objects. |
| `gwt` | no | array | Alternative-scenario specs. |

Any other top-level key produces a parser warning. Two keys are **hard errors**:

- `events` (top-level array) → `Top-level 'events' is no longer supported; use commands[].produces instead`
- `external` inside a `commands[]` or `queries[]` item → hard error
- `external` at the top level → parser warning (not a hard fail, but treat as an error in review)

### Screen block

```yaml
screen:
  type: user           # 'user' | 'system' (required)
  name: Sign Up        # optional display label; defaults to "Screen" / "Processor"
  url: https://www.figma.com/design/example/Sign-Up # optional external link, user only
  actors:              # optional: actor IDs associated with this screen (user type only)
    - Customer
  reads:               # optional: query names this screen consults
    - ExistingUserByEmail
  executes:            # optional: command names this screen triggers
    - RegisterUser
```

- `screen.type: user` → renders as a user-facing Screen node.
- `screen.type: system` → renders as a system Processor node.
- `screen.actors` is optional and only valid when `screen.type` is `user`. The parser
  hard-fails if `actors` is present on a `system` screen.
- Names in `reads`/`executes` must match `queries[].name` / `commands[].name`
  **in the same slice** (case-insensitive, whitespace-normalized). Cross-slice
  `screen.reads` references are not supported and will cause a hard parse failure.

### Screen links

`screen.url` is an optional nonempty string on user screens only. It accepts
an absolute HTTP or HTTPS URL, including a Figma design link. The field does
not change graph connections or require a schema-version migration.

The value must have an absolute authority and contain no whitespace, control
characters, backslashes, or credentials, including empty user information.
The parser does not trim values. Relative paths, local files, unsupported
schemes, non-string values, and `url` on system screens produce L10 validation
findings. Rejected links are omitted from the parsed screen and graph, while
the rest of the model remains available for inspection.

The viewer's top-right screen link and Details reference link open the URL in
a new tab. Export preserves the URL without downloading the destination.
The linked page still requires its host's availability and authentication.

### Commands

```yaml
commands:
  - name: RegisterUser           # PascalCase verb (required)
    fields: |                    # multi-line STRING, not a YAML map (optional but strongly recommended)
      email: string
      password: string
    notes: Customer fills sign-up form     # optional, free text in user's language
    produces:                    # optional: event names this command emits
      - UserRegistered
```

`fields` is optional in the parser but **strongly recommended** — without it the
command is undocumented. When present, it must be a string (block scalar with `|`),
even for a single field. Visualizers render it verbatim into a text block.

### Queries

```yaml
queries:
  - name: ExistingUserByEmail    # PascalCase noun (required)
    fields: |                    # multi-line STRING (optional but strongly recommended)
      email: string
    notes: Checked before new registration  # optional, free text in user's language
    from_events:                 # optional: events feeding this projection
      - UserRegistered
```

`fields` is optional in the parser but **strongly recommended**. `notes` is also
optional and follows the same conventions as `commands[].notes`.

### GWT

Alternative-scenario block. The slice structure already describes the happy
path — GWT is only for business-rule violations, edge cases, and errors. See
[GWT reference](#gwt-reference) below.

---

## Command slice example

```yaml
slice: Register User

screen:
  type: user
  name: Sign Up
  actors:
    - Customer
  reads:
    - ExistingUserByEmail
  executes:
    - RegisterUser

commands:
  - name: RegisterUser
    fields: |
      email: string
      password: string
    produces:
      - UserRegistered

queries:
  - name: ExistingUserByEmail
    fields: |
      email: string
    from_events:
      - UserRegistered

gwt:
  - name: Duplicate Email
    description: A user cannot register with an email already in use.
    given:
      - name: UserRegistered
        type: event
    when:
      - name: RegisterUser
        type: command
    then:
      - name: DuplicateEmailError
        type: error

  - name: Invalid Email Format
    description: Registration must be rejected when the email is not valid.
    given: []
    when:
      - name: RegisterUser
        type: command
    then:
      - name: InvalidEmailError
        type: error
```

---

## View slice example

A view slice has a screen and queries but **no commands**. No `gwt` is required.

```yaml
slice: Room Availability Dashboard

screen:
  type: user
  name: Front Desk Dashboard
  reads:
    - RoomAvailability

queries:
  - name: RoomAvailability
    fields: |
      date: date
      roomType: string
      available: int
    from_events:
      - RoomBooked
      - BookingCancelled
```

---

## Automation slice example

Automation runs without a human. The screen's `type` is `system` and `name`
labels the processor.

```yaml
slice: Send Welcome Email

screen:
  type: system
  name: Welcome Email Processor
  reads:
    - PendingWelcomeEmails
  executes:
    - SendWelcomeEmail

queries:
  - name: PendingWelcomeEmails
    fields: |
      userId: uuid
      email: string
    from_events:
      - UserRegistered
      - WelcomeEmailSent

commands:
  - name: SendWelcomeEmail
    fields: |
      userId: uuid
      email: string
    produces:
      - WelcomeEmailSent
      - WelcomeEmailFailed

gwt:
  - name: Email delivery fails
    description: External email service returns an error.
    given:
      - name: PendingWelcomeEmails
        type: query
    when:
      - name: SendWelcomeEmail
        type: command
    then:
      - name: WelcomeEmailFailed
        type: event
```

---

## Translation slice example

Translation adapts an external signal into a domain event. Same structure as
automation; the `screen.name` identifies the translator.

```yaml
slice: Translate GPS Location

screen:
  type: system
  name: GPS Translator
  executes:
    - TranslateGPSLocation

commands:
  - name: TranslateGPSLocation
    fields: |
      lat: float
      lng: float
      deviceId: string
    produces:
      - GuestLeftHotel

gwt:
  - name: Unknown device
    description: GPS reading from a device not associated with any guest.
    given:
      - name: GPSLocationUpdated
        type: event
    when:
      - name: TranslateGPSLocation
        type: command
    then:
      - name: UnknownDeviceIgnored
        type: event
```

Notice there is **no `external:` flag**. External signals enter the model as
the `given` of a translator slice. Past versions of the schema used `external:
true` on events — that key now hard-fails the parser.

---

## `event-model/events.yaml` (documentation)

A registry of every event the model uses, with field shapes. This file exists
so humans and validation tooling can spot drift between a producer's `produces`
and a consumer's `from_events`.

```yaml
events:
  UserRegistered:
    fields: |
      userId: uuid
      email: string
      registeredAt: datetime
    description: A new account has been created (pre-verification).

  WelcomeEmailSent:
    fields: |
      userId: uuid
      email: string
      sentAt: datetime

  WelcomeEmailFailed:
    fields: |
      userId: uuid
      email: string
      reason: string

  GuestLeftHotel:
    fields: |
      guestId: uuid
      leftAt: datetime
    description: Translated from a GPS feed indicating the guest moved off-property.
```

Conventions:

- Map keyed by event name (PascalCase, past tense).
- `fields` uses the same multi-line string format as slices for consistency.
- `description` is optional and written in the configured language.

When generating slices, append/merge new event names here so the registry stays
the union of every slice's producers and consumers.

---

## Standalone story files (legacy-compatible)

Existing standalone stories use one file per user story at
`<stories_dir>/<story-slug>.yaml`. Each file lists slice paths in narrative order.
For stories owned by a feature, use the embedded `stories` array in
[Feature timelines](#feature-timelines) instead. Do not create a duplicate
standalone file for an embedded story unless that duplication is intentional.

```yaml
name: User Registration
description: New user signs up with email, receives a verification email, and confirms.
slices:
  - src/features/user-registration/register-user/register-user.slice.yaml
  - src/features/user-registration/send-verification-email/send-verification-email.slice.yaml
  - src/features/user-registration/verify-email/verify-email.slice.yaml
```

Use repository-root-relative paths. Resolve `src/features/...` through the
project config's `features_dir`. A typical story has 5–15 slices; split when it
grows past ~15.

---

## Field types

Use these names inside `fields` strings:

| Type       | Example                |
|------------|------------------------|
| `string`   | `title: string`        |
| `int`      | `count: int`           |
| `float`    | `price: float`         |
| `boolean`  | `isActive: boolean`    |
| `date`     | `startDate: date`      |
| `datetime` | `createdAt: datetime`  |
| `array`    | `items: array`         |
| `object`   | `address: object`      |
| `uuid`     | `roomId: uuid`         |
| `enum`     | `status: enum`         |

The plugin treats `fields` as opaque text, so other type names are tolerated —
but stick to this set for cross-team consistency.

---

## GWT reference

GWT scenarios document **alternative paths only**. The critical path — usually
the happy path, but sometimes an irregular flow that carries the business value —
is the slice structure itself. If an irregular path is critical, give it its own
slice rather than burying it in GWT.

### Structure

```yaml
gwt:
  - name: <Scenario name>             # in the configured language
    description: <business rule>      # in the configured language
    given:
      - name: <EventOrQueryName>      # PascalCase
        type: event                   # 'event' | 'query'
        fields: |                     # optional: scenario-specific values
          fieldName: value
    when:                             # omit for view slices
      - name: <CommandName>
        type: command
    then:
      - name: <EventOrErrorName>
        type: event                   # 'event' | 'error'
        fields: |
          fieldName: value
```

### Item types

| Type      | Used in        | Meaning                             |
|-----------|----------------|-------------------------------------|
| `event`   | given, then    | A fact that happened or should happen |
| `command` | when           | The action being tested              |
| `query`   | given          | State from a read model              |
| `error`   | then           | A business rule violation            |

### Guidelines

- The slice's critical path is **not** a GWT scenario — it's the slice structure.
- Every GWT entry has a `description` explaining the business rule.
- For view slices, omit `when`.
- GWT names and descriptions are free text in the configured language.

---

## Validation rules the plugin enforces

These cause hard parse failures — the slice will not import:

- Missing `slice` field.
- Missing `screen` block, or `screen` is an array.
- `screen.type` missing or not `user`/`system`.
- `screen.actors` present when `screen.type` is `system`.
- `commands` / `queries` / `gwt` is not an array (when present).
- A command, query, or GWT item missing `name`.
- A GWT item with no `type` or a `type` outside `command | event | query | error`.
- Top-level `events:` block.
- `external:` key inside a `commands[]` or `queries[]` item. (Top-level `external:`
  produces a parser warning, not a hard failure — but treat it as an error in review.)
- `screen.reads` referencing a name that isn't in `queries[].name` **in the same
  slice**. Cross-slice `screen.reads` references are not supported.
- `screen.executes` referencing a name that isn't in `commands[].name` in the same
  slice.
- Duplicates within any single list (`commands[]`, `queries[]`, any `produces`,
  any `from_events`, `screen.reads`, `screen.executes`). Comparison is
  case-insensitive and whitespace-normalized.

Parser warnings (non-fatal):

- Unknown top-level key (including top-level `external:`).
- Missing `fields` on a command or query (strongly recommended but not enforced).

Cross-slice `from_events` references (events produced in another slice) are
**not** parser errors — the plugin resolves them interactively at import time.

## Actor registry

emviz reads an optional `<actors_file>`, which defaults to `<event_model_dir>/actors.yaml`.

```yaml
actors:
  Customer:
    name: Customer
    color: "#2563EB"
  Support:
    name: Support team
    color: "#7C3AED"
```

Each map key is a stable, case-sensitive actor ID. IDs must be nonempty strings without surrounding whitespace. Each value is a mapping. The optional `name` is a nonempty display string and defaults to the ID. The optional `color` is a quoted six-digit hex string. Omitted colors use a stable palette.

User screens reference these IDs with `screen.actors: [Customer, Support]`. Actor definitions do not create graph nodes or change the meaning of command, event, or query colors. System screens remain actor-free.

When the registry exists, every referenced actor must be defined there. Register an actor before adding a new reference. An empty registry does not permit undeclared IDs. Invalid definitions and references produce emviz A1 findings; unresolved IDs remain visible with fallback colors.

When the file is absent, legacy actor strings remain valid. emviz derives actor display entries from user screens. Adding a registry is optional and does not require renaming existing IDs.

## Feature timelines

Store a feature's stories and timeline presentations together in
`<features_dir>/<feature-slug>/<feature-slug>.feature.yaml`.
Keep slice definitions in their own files.

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

- Root `kind: feature`, numeric `schema_version: 1`, project-unique `id`,
  display `name`, `stories`, and `timelines` are required.
- Story entries require feature-local `id`, `name`, and `slices`.
  Their optional `description` explains the journey.
- Slice paths are project-root-relative, not relative to this feature file.
- Timeline entries require feature-local `id`, `name`, and nonempty `steps`.
- Step entries require timeline-local `id` and a `story` ID from this feature.
  Optional `after` lists predecessor step IDs in the same timeline.
- `after` controls layout only. It adds no event, query, or other domain edge.
  Two steps after one predecessor have no relative order; this does not imply
  simultaneous execution. Multiple predecessors express a visual join only.
- Stories can be reused across timelines. A timeline cannot repeat a story or
  contain the same slice through several stories.
- Feature and local IDs define story and timeline identity. Preserve them across
  display-name changes and file moves. Moving a story to another feature ID
  changes its identity. Slice identity remains source-path-based.
- Unsupported versions, duplicate IDs, unknown references, repeated slices, and
  layout cycles produce F1 findings. Invalid timelines are excluded. Structural
  feature or story errors prevent that feature's timelines from loading.

Existing standalone story files remain supported. Avoid maintaining the same
journey in both a legacy story file and a feature story unless that duplication
is intentional. There is no automatic YAML migration.

## Document headers

Feature files require `kind: feature` and numeric `schema_version: 1`.
Existing story, slice, events, and actors documents may omit both headers for
compatibility. When either header is present, both are required. The kind must
match the file: `story`, `slice`, `events`, or `actors`.

The version is the YAML schema version, not the installed emviz version.
Unsupported versions, wrong kinds, and incomplete pairs produce F1 findings.
Do not rename a schema version to make a newer format appear compatible.
