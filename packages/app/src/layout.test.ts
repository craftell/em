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
    const flow = toFlow(project, undefined, { edgeVisibility: "all" });
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

describe("actor filters in layout", () => {
  it("keeps Slice contents and GWT summaries at their full-graph coordinates", () => {
    const project = denseSliceProject();
    for (const node of project.nodes) {
      if (node.type !== "story" && node.type !== "event") node.sourcePath = project.slices[0].path;
    }
    project.nodes.find((node) => node.type === "screen")!.actors = ["customer"];
    const full = toFlow(project);
    const filtered = toFlow(project, "gwt_empty_checkout", { actorFilter: { actorIds: ["customer"], includeUnassigned: false } });
    expect(filtered.nodes.map(({ id, position }) => ({ id, position }))).toEqual(full.nodes.map(({ id, position }) => ({ id, position })));
    const summary = filtered.nodes.find((node) => node.id === "gwt_invalid_coupon")!;
    expect(summary.hidden).toBe(false);
    expect(summary.data.scenarios?.map((node) => node.id)).toEqual(["gwt_invalid_coupon", "gwt_empty_checkout"]);
    expect(summary.data.selected).toBe(true);
    expect(filtered.nodes.find((node) => node.id === "gwt_empty_checkout")?.hidden).toBe(true);
  });

  it("intersects actor, story and diff filters and drops every edge with a hidden endpoint", () => {
    const project = denseSliceProject();
    for (const node of project.nodes) {
      if (node.type !== "story" && node.type !== "event") node.sourcePath = project.slices[0].path;
    }
    project.nodes.find((node) => node.type === "screen")!.actors = ["customer"];
    const actorFilter = { actorIds: ["customer"], includeUnassigned: false };
    const hiddenStory = toFlow(project, undefined, { actorFilter, scope: "story", focusedStory: "Other" });
    expect(hiddenStory.nodes.filter((node) => !node.hidden && node.data.projectNode.type !== "story")).toEqual([]);
    expect(hiddenStory.edges).toEqual([]);
    const diff = toFlow(project, undefined, {
      actorFilter,
      diffFilter: "changed",
      diffNodeStatus: { command_start_checkout: "changed", event_checkout_started: "changed", event_coupon_applied: "changed", gwt_empty_checkout: "changed" },
      diffEdgeStatus: { command_event_start: "changed", command_event_coupon: "changed" }
    });
    expect(diff.edges.map((edge) => edge.id)).toEqual(["command_event_start"]);
    const visibleIds = new Set(diff.nodes.filter((node) => !node.hidden).map((node) => node.id));
    expect(diff.edges.every((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))).toBe(true);
    expect(diff.nodes.find((node) => node.id === "gwt_empty_checkout")?.hidden).toBe(false);
    expect(diff.nodes.find((node) => node.id === "gwt_invalid_coupon")?.hidden).toBe(true);
  });

  it("retains an actor's previous diff membership without changing displayed metadata", () => {
    const project = denseSliceProject();
    for (const node of project.nodes) {
      if (node.type !== "story" && node.type !== "event") node.sourcePath = project.slices[0].path;
    }
    const screen = project.nodes.find((node) => node.type === "screen")!;
    screen.actors = ["new"];
    screen.actorDefinitions = [{ id: "new", name: "New actor", color: "#abcdef" }];
    const flow = toFlow(project, undefined, {
      actorFilter: { actorIds: ["old"], includeUnassigned: false },
      previousNodes: { [screen.id]: { ...screen, actors: ["old"], actorDefinitions: [{ id: "old", name: "Old actor", color: "#123456" }] } }
    });
    expect(flow.nodes.find((node) => node.id === screen.id)?.hidden).toBe(false);
    expect(flow.nodes.find((node) => node.id === screen.id)?.data.projectNode.actorDefinitions).toEqual(screen.actorDefinitions);
  });
});

describe("canvas edge visibility", () => {
  function ids(project: EventModelProject, selected?: string, edgeVisibility?: "auto" | "intra-slice" | "all") {
    return toFlow(project, selected, { edgeVisibility }).edges.map((edge) => edge.id);
  }

  it("defaults to local edges and reveals only selected-node cross edges", () => {
    const project = forwardCrossSliceProject();
    project.nodes.push({ id: "other_query", type: "query", label: "Other", sourcePath: project.slices[1].path, sliceTitle: project.slices[1].title });
    project.edges.push({ id: "other_read", kind: "event-query", source: "event_checkout_started", target: "other_query" });
    expect(ids(project)).toEqual(["command_event"]);
    expect(ids(project, "query_checkout_status")).toEqual(["command_event", "event_query"]);
    expect(ids(project, "event_checkout_started")).toEqual(["command_event", "event_query", "other_read"]);
    expect(ids(project, "command_start_checkout")).toEqual(["command_event"]);
    expect(ids(project, "query_checkout_status", "intra-slice")).toEqual(["command_event"]);
    expect(ids(project, undefined, "all")).toEqual(["command_event", "event_query", "other_read"]);
  });

  it("reveals incoming and outgoing cross edges for either selected slice", () => {
    const project = forwardCrossSliceProject();
    expect(ids(project, "slice_start_checkout")).toEqual(["command_event", "event_query"]);
    expect(ids(project, "slice_view_checkout_status")).toEqual(["command_event", "event_query"]);
    expect(ids(project, "story_checkout")).toEqual(["command_event"]);
  });

  it("uses producer source paths when events share a definitions file and slice labels collide", () => {
    const project = forwardCrossSliceProject();
    for (const node of project.nodes) {
      if (node.type !== "story" && node.type !== "event") {
        node.sourcePath = node.sliceTitle === project.slices[0].title ? project.slices[0].path : project.slices[1].path;
      }
    }
    for (const slice of project.slices) slice.title = "Same";
    for (const node of project.nodes) if (node.type !== "story") node.sliceTitle = "Same";
    project.nodes.find((node) => node.type === "event")!.sourcePath = "events.yaml";
    expect(ids(project)).toEqual(["command_event"]);
    const cross = toFlow(project, "query_checkout_status").edges.find((edge) => edge.id === "event_query");
    expect(cross?.data?.route).toBe("event-read");
  });

  it("does not reveal edges hidden by actor or diff filters", () => {
    const project = forwardCrossSliceProject();
    expect(toFlow(project, "query_checkout_status", {
      actorFilter: { actorIds: ["missing"], includeUnassigned: false }, edgeVisibility: "all"
    }).edges).toEqual([]);
    const flow = toFlow(project, "query_checkout_status", {
      diffFilter: "changed", diffNodeStatus: { command_start_checkout: "changed", event_checkout_started: "changed" },
      diffEdgeStatus: { command_event: "changed", event_query: "changed" }, edgeVisibility: "all"
    });
    expect(flow.edges.map((edge) => edge.id)).toEqual(["command_event"]);
  });
});

describe("collapsed story projection", () => {
  function projectWithTwoStories() {
    const project = forwardCrossSliceProject();
    const targetPath = project.slices[1].path;
    project.stories[0].id = "checkout";
    project.stories[0].slices = [project.slices[0].path];
    project.stories.push({ id: "status", name: "Status", description: "", path: "status.feature.yaml", slices: [targetPath] });
    project.slices[0].storyId = "checkout";
    project.slices[1].storyId = "status";
    project.slices[1].storyName = "Status";
    for (const node of project.nodes) {
      node.storyId = node.sliceTitle === project.slices[1].title ? "status" : "checkout";
      if (node.type !== "story" && node.type !== "event") node.sourcePath = node.storyId === "status" ? targetPath : project.slices[0].path;
    }
    project.nodes.push({ id: "story_status", type: "story", storyId: "status", label: "Status" });
    return project;
  }

  it("keeps canonical nodes and edges while projecting cross-story endpoints onto headers", () => {
    const project = projectWithTwoStories();
    const before = JSON.stringify(project);
    const expanded = toFlow(project, undefined, { edgeVisibility: "all" });
    const collapsed = toFlow(project, undefined, { edgeVisibility: "all", collapsedStoryIds: new Set(["checkout"]) });
    const header = collapsed.nodes.find((node) => node.id === "story_checkout")!;
    expect(header.data).toMatchObject({ collapsed: true, storyId: "checkout", sliceCount: 1 });
    expect(header.style?.height).toBe(92);
    expect(header.hidden).toBe(false);
    expect(collapsed.nodes.find((node) => node.id === "event_checkout_started")?.hidden).toBe(true);
    expect(collapsed.nodes.find((node) => node.id === "command_start_checkout")?.data.storyId).toBe("checkout");
    expect(collapsed.edges.map((edge) => edge.id)).toEqual(["event_query"]);
    expect(collapsed.edges[0]).toMatchObject({
      source: "story_checkout", target: "query_checkout_status",
      data: { kind: "event-query", sourceNodeId: "event_checkout_started", targetNodeId: "query_checkout_status", proxy: true }
    });
    expect(JSON.stringify(project)).toBe(before);
    expect(toFlow(project, undefined, { edgeVisibility: "all" })).toEqual(expanded);
  });

  it("does not synthesize domain edges from timeline ordering or collapse", () => {
    const project = projectWithTwoStories();
    project.timelines = [{ id: "journey", name: "Journey", path: "timeline.yaml", steps: [
      { id: "one", storyId: "checkout", after: [] }, { id: "two", storyId: "status", after: ["one"] }
    ] }];
    const flow = toFlow(project, undefined, {
      timelineId: "journey", edgeVisibility: "all", collapsedStoryIds: new Set(["checkout", "status"])
    });
    expect(flow.edges).toHaveLength(1);
    expect(flow.edges[0]).toMatchObject({ id: "event_query", source: "story_checkout", target: "story_status", data: { kind: "event-query" } });
    project.edges = [];
    expect(toFlow(project, undefined, { timelineId: "journey", edgeVisibility: "all", collapsedStoryIds: new Set(["checkout", "status"]) }).edges).toEqual([]);
  });

  it("keeps Auto and Intra-slice visibility rules when endpoints are collapsed", () => {
    const project = projectWithTwoStories();
    const collapsedStoryIds = new Set(["checkout"]);
    expect(toFlow(project, undefined, { collapsedStoryIds }).edges).toEqual([]);
    expect(toFlow(project, "query_checkout_status", { collapsedStoryIds }).edges.map((edge) => edge.id)).toEqual(["event_query"]);
    expect(toFlow(project, "query_checkout_status", { collapsedStoryIds, edgeVisibility: "intra-slice" }).edges).toEqual([]);
  });

  it("keeps collapsed headers visible for matching diff descendants without leaking other edges", () => {
    const project = projectWithTwoStories();
    const flow = toFlow(project, undefined, {
      collapsedStoryIds: new Set(["checkout"]), edgeVisibility: "all",
      diffFilter: "changed", diffNodeStatus: { event_checkout_started: "changed", query_checkout_status: "changed" },
      diffEdgeStatus: { event_query: "changed" }
    });
    expect(flow.nodes.find((node) => node.id === "story_checkout")?.hidden).toBe(false);
    expect(flow.edges.map((edge) => edge.id)).toEqual(["event_query"]);
  });

  it("selection changes do not alter the collapsed layout", () => {
    const project = projectWithTwoStories();
    const options = { collapsedStoryIds: new Set(["checkout"]) };
    const positions = (selected?: string) => toFlow(project, selected, options).nodes.map(({ id, position, style }) => ({ id, position, style }));
    expect(positions("query_checkout_status")).toEqual(positions());
    expect(positions("event_checkout_started")).toEqual(positions());
  });

  it("counts each existing story slice reference even when another story owns its rendering", () => {
    const project = projectWithTwoStories();
    const sharedPath = project.slices[0].path;
    project.stories[1].slices.push(sharedPath, sharedPath, "missing.slice.yaml");
    project.timelines = [
      { id: "checkout-only", name: "Checkout", path: "checkout.timeline.yaml", steps: [{ id: "one", storyId: "checkout", after: [] }] },
      { id: "status-only", name: "Status", path: "status.timeline.yaml", steps: [{ id: "one", storyId: "status", after: [] }] }
    ];
    const before = JSON.stringify(project);
    for (const collapsedStoryIds of [new Set<string>(), new Set(["checkout", "status"])]) {
      const flow = toFlow(project, undefined, { collapsedStoryIds });
      expect(flow.nodes.find((node) => node.id === "story_checkout")?.data.sliceCount).toBe(1);
      expect(flow.nodes.find((node) => node.id === "story_status")?.data.sliceCount).toBe(2);
      expect(flow.nodes.filter((node) => node.id === "slice_start_checkout")).toHaveLength(1);
      expect(flow.nodes.find((node) => node.id === "slice_start_checkout")?.data.storyId).toBe("checkout");
    }
    const statusTimeline = toFlow(project, undefined, { timelineId: "status-only", collapsedStoryIds: new Set(["status"]) });
    expect(statusTimeline.nodes.find((node) => node.id === "story_status")?.data.sliceCount).toBe(2);
    expect(statusTimeline.nodes.find((node) => node.id === "slice_start_checkout")?.data.storyId).toBe("status");
    expect(toFlow(project, undefined, { timelineId: "checkout-only" }).nodes.find((node) => node.id === "story_checkout")?.data.sliceCount).toBe(1);
    expect(JSON.stringify(project)).toBe(before);
  });

  function legacyStoriesWithDuplicateNames() {
    const project = projectWithTwoStories();
    for (const story of project.stories) {
      delete story.id;
      story.name = "Same";
    }
    for (const slice of project.slices) {
      delete slice.storyId;
      slice.storyName = "Same";
    }
    for (const node of project.nodes) {
      delete node.storyId;
      node.storyName = "Same";
      if (node.type === "story") {
        node.label = "Same";
        node.sourcePath = project.stories[node.id === "story_checkout" ? 0 : 1].path;
      }
    }
    return project;
  }

  it("keeps same-named legacy stories independently positioned and collapsible by source path", () => {
    const project = legacyStoriesWithDuplicateNames();
    const firstId = project.stories[0].path;
    const secondId = project.stories[1].path;
    const expanded = toFlow(project, undefined, { edgeVisibility: "all" });
    const firstHeader = expanded.nodes.find((node) => node.id === "story_checkout")!;
    const secondHeader = expanded.nodes.find((node) => node.id === "story_status")!;
    expect(firstHeader.data).toMatchObject({ storyId: firstId, collapsed: false, sliceCount: 1 });
    expect(secondHeader.data).toMatchObject({ storyId: secondId, collapsed: false, sliceCount: 1 });
    expect(secondHeader.position.y).toBeGreaterThan(firstHeader.position.y + Number(firstHeader.style?.height));
    for (const [collapsedId, hiddenId, visibleId, source, target] of [
      [firstId, "command_start_checkout", "query_checkout_status", "story_checkout", "query_checkout_status"],
      [secondId, "query_checkout_status", "command_start_checkout", "event_checkout_started", "story_status"]
    ]) {
      const flow = toFlow(project, undefined, { edgeVisibility: "all", collapsedStoryIds: new Set([collapsedId]) });
      expect(flow.nodes.find((node) => node.id === hiddenId)?.hidden).toBe(true);
      expect(flow.nodes.find((node) => node.id === visibleId)?.hidden).toBe(false);
      expect(flow.nodes.find((node) => node.id === "story_checkout")?.data.collapsed).toBe(collapsedId === firstId);
      expect(flow.nodes.find((node) => node.id === "story_status")?.data.collapsed).toBe(collapsedId === secondId);
      expect(flow.edges.find((edge) => edge.id === "event_query")).toMatchObject({ source, target, data: { proxy: true } });
    }
    const collapsed = toFlow(project, undefined, { edgeVisibility: "all", collapsedStoryIds: new Set([firstId, secondId]) });
    expect(collapsed.edges).toHaveLength(1);
    expect(collapsed.edges[0]).toMatchObject({ id: "event_query", source: "story_checkout", target: "story_status" });
  });

  it("keeps legacy collapse ownership stable after reordering and label changes", () => {
    const project = legacyStoriesWithDuplicateNames();
    const firstId = project.stories[0].path;
    project.stories.reverse();
    project.nodes.reverse();
    for (const story of project.stories) story.name = "Renamed";
    for (const slice of project.slices) slice.storyName = "Renamed";
    for (const node of project.nodes) {
      node.storyName = "Renamed";
      if (node.type === "story") node.label = "Renamed";
    }
    const before = JSON.stringify(project);
    const flow = toFlow(project, undefined, { edgeVisibility: "all", collapsedStoryIds: new Set([firstId]) });
    expect(flow.nodes.find((node) => node.id === "story_checkout")?.data).toMatchObject({ storyId: firstId, collapsed: true });
    expect(flow.nodes.find((node) => node.id === "story_status")?.data.collapsed).toBe(false);
    expect(flow.nodes.find((node) => node.id === "event_checkout_started")?.hidden).toBe(true);
    expect(flow.nodes.find((node) => node.id === "query_checkout_status")?.hidden).toBe(false);
    expect(flow.edges.find((edge) => edge.id === "event_query")).toMatchObject({ source: "story_checkout", target: "query_checkout_status" });
    expect(JSON.stringify(project)).toBe(before);
  });

  it("keeps actor, scope and diff filtering ahead of legacy collapsed proxies", () => {
    const project = legacyStoriesWithDuplicateNames();
    const collapsedStoryIds = new Set(project.stories.map((story) => story.path));
    expect(toFlow(project, undefined, {
      collapsedStoryIds, edgeVisibility: "all", actorFilter: { actorIds: ["missing"], includeUnassigned: false }
    }).edges).toEqual([]);
    expect(toFlow(project, undefined, {
      collapsedStoryIds, edgeVisibility: "all", scope: "story", focusedStory: "Other"
    }).edges).toEqual([]);
    const flow = toFlow(project, undefined, {
      collapsedStoryIds, edgeVisibility: "all", diffFilter: "changed",
      diffNodeStatus: { event_checkout_started: "changed", query_checkout_status: "changed" },
      diffEdgeStatus: { event_query: "changed" }
    });
    expect(flow.edges).toHaveLength(1);
    expect(flow.edges[0]).toMatchObject({ id: "event_query", source: "story_checkout", target: "story_status" });
  });

});
