import { describe, expect, it } from "vitest";
import { buildFieldFlows } from "./fieldFlow";
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

function denseSliceProject(): EventModelProject {
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
      { id: "query_customer", type: "query", label: "CustomerForCheckout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "command_start_checkout", type: "command", label: "StartCheckout", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "command_apply_coupon", type: "command", label: "ApplyCoupon", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "event_checkout_started", type: "event", label: "CheckoutStarted", storyName: "Checkout", sliceTitle: "Start Checkout" },
      { id: "event_coupon_applied", type: "event", label: "CouponApplied", storyName: "Checkout", sliceTitle: "Start Checkout" },
      {
        id: "gwt_invalid_coupon",
        type: "gwt",
        label: "Invalid coupon",
        storyName: "Checkout",
        sliceTitle: "Start Checkout",
        given: [{ type: "event", name: "CheckoutStarted" }],
        when: [{ type: "command", name: "ApplyCoupon" }],
        then: [{ type: "error", name: "CouponRejected" }]
      },
      {
        id: "gwt_empty_checkout",
        type: "gwt",
        label: "Empty checkout",
        storyName: "Checkout",
        sliceTitle: "Start Checkout",
        given: [],
        when: [],
        then: [{ type: "event", name: "CheckoutAbandoned" }]
      }
    ],
    edges: [
      { id: "command_event_start", kind: "command-event", source: "command_start_checkout", target: "event_checkout_started" },
      { id: "command_event_coupon", kind: "command-event", source: "command_apply_coupon", target: "event_coupon_applied" }
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

describe("toFlow slice row layout", () => {
  it("places multiple queries and commands on horizontal rows without overlap", () => {
    const flow = toFlow(denseSliceProject());
    const queryPositions = ["query_checkout", "query_customer"].map((id) => flow.nodes.find((node) => node.id === id)?.position);
    const commandPositions = ["command_start_checkout", "command_apply_coupon"].map((id) => flow.nodes.find((node) => node.id === id)?.position);

    expect(queryPositions[0]?.y).toBe(queryPositions[1]?.y);
    expect(commandPositions[0]?.y).toBe(commandPositions[1]?.y);
    expect(Math.abs((queryPositions[1]?.x ?? 0) - (queryPositions[0]?.x ?? 0))).toBeGreaterThanOrEqual(196);
    expect(Math.abs((commandPositions[1]?.x ?? 0) - (commandPositions[0]?.x ?? 0))).toBeGreaterThanOrEqual(196);
  });

  it("renders one GWT summary at the bottom while retaining all scenario targets", () => {
    const flow = toFlow(denseSliceProject());
    const slice = flow.nodes.find((node) => node.id === "slice_start_checkout");
    const event = flow.nodes.find((node) => node.id === "event_checkout_started");
    const gwtCases = ["gwt_invalid_coupon", "gwt_empty_checkout"].map((id) => flow.nodes.find((node) => node.id === id));

    expect(gwtCases[0]?.position.y).toBe(gwtCases[1]?.position.y);
    expect(gwtCases[0]?.position.y ?? 0).toBeGreaterThan(event?.position.y ?? 0);
    expect((gwtCases[0]?.position.y ?? 0) + 170).toBeLessThanOrEqual((slice?.position.y ?? 0) + Number(slice?.style?.height ?? 0));
    expect(gwtCases[0]?.hidden).toBe(false);
    expect(gwtCases[1]?.hidden).toBe(true);
    expect(gwtCases[0]?.position).toEqual(gwtCases[1]?.position);
    expect(gwtCases[0]?.data.scenarios?.map((node) => node.id)).toEqual(["gwt_invalid_coupon", "gwt_empty_checkout"]);
  });
});

describe("compact GWT layout", () => {
  function withCases(count: number) {
    const project = forwardCrossSliceProject();
    project.nodes.push(...Array.from({ length: count }, (_, index) => ({
      id: `case_${index}`, type: "gwt" as const, label: `Case ${index}`,
      sliceTitle: "Start Checkout", storyName: "Checkout", sourcePath: project.slices[0].path
    })));
    return project;
  }

  it("keeps all surrounding coordinates and sizes fixed for 1, 3, 4 and 100 cases", () => {
    const shape = (count: number) => toFlow(withCases(count)).nodes.filter((node) => !node.hidden).map((node) => ({ id: node.id, position: node.position, style: node.style }));
    for (const count of [3, 4, 100]) expect(shape(count)).toEqual(shape(1));
    const project = withCases(100);
    expect(toFlow(project, "case_99").nodes.map(({ position }) => position)).toEqual(toFlow(project).nodes.map(({ position }) => position));
    expect(project.nodes.filter((node) => node.type === "gwt")).toHaveLength(100);
  });

  it("omits a summary for zero cases", () => {
    expect(toFlow(withCases(0)).nodes.filter((node) => node.data.projectNode.type === "gwt")).toHaveLength(0);
  });

  it("separates same-named slices and scenarios using source paths", () => {
    const project = withCases(4);
    project.slices[1].title = project.slices[0].title;
    project.nodes.push({ ...project.nodes.at(-1)!, id: "other_case", sourcePath: project.slices[1].path });
    const flow = toFlow(project);
    const summaries = flow.nodes.filter((node) => node.data.scenarios && !node.hidden);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((node) => node.data.scenarios?.length)).toEqual([4, 1]);
    expect(summaries[0].position.x).not.toBe(summaries[1].position.x);
  });
});

describe("toFlow field flow edge data", () => {
  it("passes field flow data through command-event edges", () => {
    const project = forwardCrossSliceProject();
    const command = project.nodes.find((node) => node.id === "command_start_checkout");
    const event = project.nodes.find((node) => node.id === "event_checkout_started");
    if (command) command.fields = "customerId: string\nplanId: string";
    if (event) event.fields = "customerId: string\nstatus: string";

    const fieldFlows = buildFieldFlows(project);
    const flow = toFlow(project, undefined, { edgeFieldFlows: fieldFlows });
    const edge = flow.edges.find((candidate) => candidate.id === "command_event");

    expect(edge?.data?.fieldFlow).toMatchObject({
      sharedFieldNames: ["customerId"],
      visibleFieldNames: ["customerId"],
      remainingCount: 0
    });
  });
});
