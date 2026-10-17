---
name: em-feedback
description: >-
  Receive browser feedback in a user-started LLM agent for an emviz Event
  Modeling session. Use for existing em-feedback requests, selected-node edits,
  and resuming a feedback session.
---

# Handle emviz feedback

Use the [emviz skill](../emviz/SKILL.md) for the complete launch, poll, edit,
reply, and cleanup workflow. `emviz` is the primary entry point. This skill keeps
the existing `em-feedback` name available without a second lifecycle procedure.

If installed skills are not siblings, locate the installed skill named `emviz`.
If it is missing, read the [repository copy](https://github.com/craftell/em/blob/main/skills/emviz/SKILL.md)
or ask the user to install the companion skills together.

Reuse this agent's existing verified session when resuming. Do not open a second
server or start another LLM. A normal 25-second poll timeout means poll again.
After a successful reply, poll again. Stop when the user or session stops, and
report when the host cannot continue monitoring.
