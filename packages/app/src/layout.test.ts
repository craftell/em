import { describe, expect, it } from "vitest";
import { toFlow } from "./layout";
import type { EventModelProject } from "./types";

function sameSliceProject(): EventModelProject {
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
    stories: [{ name: "Checkout", description: "", path: "event-model/stories/checkout.yaml", slices: ["event-model/features/checkout/start.slice.yaml"] }],
    slices: [{ title: "Start Checkout", path: "event-model/features/checkout/start.slice.yaml", storyName: "Checkout" }],
    nodes: [
      { id: "story_checkout", type: "story", label: "Checkout" },
      { id: "slice_start_checkout", type: "slice", label: "Start Checkout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "screen_start_checkout", type: "screen", label: "Start Checkout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "query_checkout", type: "query", label: "CheckoutForStart", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "command_start_checkout", type: "command", label: "StartCheckout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "event_checkout_started", type: "event", label: "CheckoutStarted", storyName: "Checkout", sliceTitle: "Start Checkout" }
    ],
    edges: [
      { id: "event_query", kind: "event-query", source: "event_checkout_started", target: "query_checkout" }
    ]
  };
}

function forwardCrossSliceProject(): EventModelProject {
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
    stories: [
      {
        name: "Checkout",
        description: "",
        path: "event-model/stories/checkout.yaml",
        slices: ["event-model/features/checkout/start.slice.yaml", "event-model/features/checkout/status.slice.yaml"]
      }
    ],
    slices: [
      { title: "Start Checkout", path: "event-model/features/checkout/start.slice.yaml", storyName: "Checkout" },
      { title: "View Checkout Status", path: "event-model/features/checkout/status.slice.yaml", storyName: "Checkout" }
    ],
    nodes: [
      { id: "story_checkout", type: "story", label: "Checkout" },
      { id: "slice_start_checkout", type: "slice", label: "Start Checkout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "slice_view_checkout_status", type: "slice", label: "View Checkout Status", storyName: "Checkout", sliceTitle: "View Checkout Status" },
      { id: "command_start_checkout", type: "command", label: "StartCheckout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "query_checkout_status", type: "query", label: "CheckoutStatusForCustomer", storyName: "Checkout", sliceTitle: "View Checkout Status" },
      { id: "event_checkout_started", type: "event", label: "CheckoutStarted", storyName: "Checkout", sliceTitle: "Start Checkout" }
    ],
    edges: [
      { id: "command_event", kind: "command-event", source: "command_start_checkout", target: "event_checkout_started" },
      { id: "event_query", kind: "event-query", source: "event_checkout_started", target: "query_checkout_status" }
    ]
  };
}

describe("toFlow event-query routing", () => {
  it("keeps same-slice event reads compact inside the slice", () => {
    const project = sameSliceProject();
    const flow = toFlow(project);
    const edge = flow.edges.find((candidate) => candidate.data?.kind === "event-query");

    expect(edge).toBeDefined();
    expect(edge?.sourceHandle).toBe("top-source");
    expect(edge?.targetHandle).toBe("bottom-target");
    expect(edge?.data).toMatchObject({ route: "same-slice-read" });
  });

  it("routes cross-slice event reads into the side of the query facing the event", () => {
    const project = forwardCrossSliceProject();
    const flow = toFlow(project);
    const edge = flow.edges.find((candidate) => candidate.data?.kind === "event-query");

    expect(edge).toBeDefined();
    expect(edge?.sourceHandle).toBe("bottom-source");
    expect(edge?.targetHandle).toBe("left-target");
    expect(edge?.data).toMatchObject({ route: "event-read" });
  });
});
