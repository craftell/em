# Domain Event Rules

Use these rules from both `em-model` and `em-extract`. `em-lint` uses them for
domain-event warnings.

## Litmus test

A domain event qualifies if it passes either test:

1. **Stored fact**: would this fact be written to the database or event store and
   need to survive an app restart?
2. **Dispatch boundary**: does this represent a meaningful handoff between an
   entry-point slice and a processor/automation slice that would naturally be a
   queue/outbox/job/message in an event-driven implementation?

If neither is true, do not model it as an event.

## Dispatch boundaries

Events ending in `Requested`, `Triggered`, `Scheduled`, `Enqueued`,
`Dispatched`, or `Required` can be valid even when they are not state changes,
but only when a consumer slice exists. The consumer query must list the event in
`from_events:`.

If a dispatch event is produced but no query consumes it, prefer checking for a
missing processor/query connection before deleting it.

## Anti-patterns

Reject events that are only:

- UI navigation: `PageOpened`, `TabSwitched`, `Navigated`
- Runtime/UI state: `DrawerOpened`, `SearchTyped`, `TimerTicked`
- UI interactions: `ButtonClicked`, `DialogClosed`
- Derived/computed state: `TotalCalculated`, `TierReached`
- Transient session state: `BrowsingSessionStarted`, unless persisted and used
  as domain state
- Pure receipt acknowledgement: `WebhookReceived`, unless receipt itself is the
  durable fact or dispatch consumed by another slice

## Naming heuristics

Usually domain events:

- `Created`, `Updated`, `Deleted`, `Recorded`, `Placed`, `Booked`,
  `Registered`, `Verified`, `Cancelled`, `Approved`, `Rejected`, `Submitted`

Usually suspicious:

- `Selected`, `Shown`, `Viewed`, `Clicked`, `Opened`, `Closed`, `Ticked`,
  `Incremented`, `Reached`, `Displayed`, `Navigated`

Use the heuristic as a question, not an accusation. The actual deciding factor is
the litmus test.
