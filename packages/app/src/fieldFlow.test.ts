import { describe, expect, it } from "vitest";
import { buildFieldFlows, fieldLabel, parseFieldNames } from "./fieldFlow";
import type { EventModelProject } from "./types";

describe("parseFieldNames", () => {
  it("extracts field names from common loose field text", () => {
    expect(parseFieldNames(`
      customerId: string
      - planId - selected plan
      * status (derived)
      1. subscriptionId, persisted id
      \`email\`: string
    `)).toEqual(["customerId", "planId", "status", "subscriptionId", "email"]);
  });

  it("ignores empty lines and deduplicates names", () => {
    expect(parseFieldNames(`
      customerId: string

      customerId - duplicate
      invalid field name
    `)).toEqual(["customerId"]);
  });
});

describe("buildFieldFlows", () => {
  it("keeps only same-name fields on command-event and event-query edges", () => {
    const project = fieldFlowProject();
    const flows = buildFieldFlows(project);

    expect(flows.get("command_event")?.sharedFieldNames).toEqual(["customerId", "planId"]);
    expect(flows.get("event_query")?.sharedFieldNames).toEqual(["customerId", "status"]);
    expect(flows.get("event_query")?.derivedFieldNames).toEqual([]);
    expect(flows.has("screen_command")).toBe(false);
  });

  it("tracks query projection fields derived from an event name", () => {
    const project = fieldFlowProject({
      eventLabel: "WelcomeEmailSent",
      eventFields: "customerId: string\nemail: string\nsentAt: datetime",
      queryFields: "customerId: string\nemail: string\nhasWelcomeEmailBeenSent: boolean"
    });
    const flow = buildFieldFlows(project).get("event_query");

    expect(flow?.sharedFieldNames).toEqual(["customerId", "email"]);
    expect(flow?.derivedFieldNames).toEqual(["hasWelcomeEmailBeenSent"]);
    expect(flow?.visibleFieldNames).toEqual(["customerId", "email", "hasWelcomeEmailBeenSent"]);
  });

  it("limits visible field labels to three names plus a remaining count", () => {
    const project = fieldFlowProject({
      commandFields: "a: string\nb: string\nc: string\nd: string",
      eventFields: "a: string\nb: string\nc: string\nd: string"
    });
    const flow = buildFieldFlows(project).get("command_event");

    expect(flow?.visibleFieldNames).toEqual(["a", "b", "c"]);
    expect(flow?.remainingCount).toBe(1);
    expect(flow && fieldLabel(flow)).toBe("a, b, c +1");
  });

  it("marks missing fields without inventing a shared flow", () => {
    const project = fieldFlowProject({ queryFields: undefined });
    const flow = buildFieldFlows(project).get("event_query");

    expect(flow?.sharedFieldNames).toEqual([]);
    expect(flow?.targetMissingFields).toBe(true);
  });
});

function fieldFlowProject(overrides: { commandFields?: string; eventFields?: string; queryFields?: string; eventLabel?: string } = {}): EventModelProject {
  const commandFields = overrides.commandFields ?? "customerId: string\nplanId: string\nignoredByEvent: string";
  const eventFields = overrides.eventFields ?? "subscriptionId: string\ncustomerId: string\nplanId: string\nstatus: string";
  const queryFields = Object.hasOwn(overrides, "queryFields") ? overrides.queryFields : "customerId: string\nstatus: string";

  return {
    root: "",
    config: {
      paths: {
        eventModelDir: "event-model",
        featuresDir: "event-model/features",
        sliceExtension: ".slice.yaml",
        eventsFile: "event-model/events.yaml",
        storiesDir: "event-model/stories"
      }
    },
    events: [],
    stories: [],
    slices: [],
    nodes: [
      { id: "screen", type: "screen", label: "Screen" },
      { id: "command", type: "command", label: "StartSubscription", fields: commandFields },
      { id: "event", type: "event", label: overrides.eventLabel ?? "SubscriptionStarted", fields: eventFields },
      { id: "query", type: "query", label: "SubscriptionStatusForCustomer", fields: queryFields }
    ],
    edges: [
      { id: "screen_command", kind: "screen-command", source: "screen", target: "command" },
      { id: "command_event", kind: "command-event", source: "command", target: "event" },
      { id: "event_query", kind: "event-query", source: "event", target: "query" }
    ]
  };
}
