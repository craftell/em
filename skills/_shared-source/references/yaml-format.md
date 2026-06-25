# YAML Format Reference

The canonical format for every file the `em-model` skill produces. The
**slice file** is the canonical artifact parsed by Event Modeling tooling, so
its schema must stay exact. `events.yaml` and story files are documentation and
have more flexibility.

## Table of contents

1. [Slice file (`*.slice.yaml`)](#slice-file)
2. [Command slice example](#command-slice-example)
3. [View slice example](#view-slice-example)
4. [Automation slice example](#automation-slice-example)
5. [Translation slice example](#translation-slice-example)
6. [`event-model/events.yaml` (documentation)](#event-modeleventsyaml-documentation)
7. [Story files (documentation)](#story-files-documentation)
8. [Field types](#field-types)
9. [GWT reference](#gwt-reference)
10. [Validation rules tooling enforces](#validation-rules-tooling-enforces)

---

## Slice file

One file per slice. Path resolved through the project config:
`<features_dir>/<story-slug>/<slice-slug>/<slice-slug><slice_extension>`.

### Top-level keys

| Key | Required | Type | Notes |
|---|---|---|---|
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
  actors:              # optional: actor names associated with this screen (user type only)
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

## Story files (documentation)

One file per user story. Path: `<stories_dir>/<story-slug>.yaml`. Lists slice
file paths in narrative order, so a reader can follow the user journey.

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
