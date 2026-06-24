import fs from "node:fs";
import path from "node:path";
import type { EventModelProject } from "@emviz/parser";
import { readGraphSidecar, resolveSidecarNode } from "@emviz/graph";

export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationFinding = {
  id: string;
  severity: ValidationSeverity;
  check: string;
  message: string;
  path?: string;
  nodeId?: string;
};

export type ValidationReport = {
  errors: number;
  warnings: number;
  findings: ValidationFinding[];
};

function finding(
  severity: ValidationSeverity,
  check: string,
  message: string,
  pathValue?: string,
  nodeId?: string
): ValidationFinding {
  return {
    id: `${check}:${pathValue ?? "project"}:${message}`,
    severity,
    check,
    message,
    path: pathValue,
    nodeId
  };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) duplicate.add(value);
    seen.add(normalized);
  }

  return [...duplicate];
}

const pastTenseTokens = new Set([
  "sent",
  "built",
  "made",
  "paid",
  "booked",
  "cancelled",
  "canceled",
  "submitted",
  "recorded",
  "created",
  "updated",
  "deleted",
  "placed",
  "notified"
]);

function pascalCaseTokens(name: string): string[] {
  return name.match(/[A-Z]+(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|\d+/g) ?? [name];
}

function looksLikePastTenseToken(token: string): boolean {
  const normalized = token.toLowerCase();
  return pastTenseTokens.has(normalized) || /(ed|en|d)$/i.test(token);
}

function looksLikePastTenseEvent(name: string): boolean {
  return pascalCaseTokens(name).some(looksLikePastTenseToken);
}

function isDispatchEvent(name: string): boolean {
  return /(Requested|Triggered|Scheduled|Enqueued|Dispatched|Required)$/.test(name);
}

function redFlagVerb(name: string): string | undefined {
  return [
    "Selected",
    "Shown",
    "Viewed",
    "Clicked",
    "Opened",
    "Closed",
    "Ticked",
    "Incremented",
    "Reached",
    "Displayed",
    "Navigated"
  ].find((verb) => name.includes(verb));
}

function connectedComponentCount(project: EventModelProject): number {
  const nodeIds = new Set(project.nodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, new Set());
  for (const edge of project.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  let components = 0;
  const visited = new Set<string>();
  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) continue;
    components += 1;
    const queue = [nodeId];
    visited.add(nodeId);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return components;
}

export function validateEventModelProject(project: EventModelProject): ValidationReport {
  const findings: ValidationFinding[] = [];
  const eventNames = new Set(project.events.map((event) => event.name));
  const produced = new Map<string, string[]>();
  const consumed = new Map<string, string[]>();

  for (const story of project.stories) {
    if (story.slices.length > 15) {
      findings.push(
        finding("warning", "S4", `Story "${story.name}" has ${story.slices.length} slices; consider splitting it.`, story.path)
      );
    }
    for (const slicePath of story.slices) {
      if (!fs.existsSync(path.join(project.root, slicePath))) {
        findings.push(finding("error", "S2", `Story "${story.name}" lists missing slice "${slicePath}".`, story.path));
      }
    }
  }

  for (const event of project.events) {
    if (!event.fields?.trim()) {
      findings.push(finding("error", "C4", `Event "${event.name}" has no fields block.`, event.sourcePath));
    }
    if (!looksLikePastTenseEvent(event.name) && !isDispatchEvent(event.name)) {
      findings.push(
        finding("warning", "C3", `Event "${event.name}" does not obviously read as a past-tense domain event.`, event.sourcePath)
      );
    }
    const verb = redFlagVerb(event.name);
    if (verb) {
      findings.push(
        finding("warning", "D1", `Event "${event.name}" contains red-flag verb "${verb}"; confirm this is persisted domain state.`, event.sourcePath)
      );
    }
  }

  for (const slice of project.slices) {
    const commandNames = slice.commands.map((command) => command.name);
    const queryNames = slice.queries.map((query) => query.name);

    for (const name of duplicates(commandNames)) {
      findings.push(finding("error", "L9", `Command "${name}" is duplicated within slice "${slice.title}".`, slice.path));
    }
    for (const name of duplicates(queryNames)) {
      findings.push(finding("error", "L9", `Query "${name}" is duplicated within slice "${slice.title}".`, slice.path));
    }
    for (const name of duplicates(slice.screen.reads)) {
      findings.push(finding("error", "L9", `screen.reads lists "${name}" more than once.`, slice.path));
    }
    for (const name of duplicates(slice.screen.executes)) {
      findings.push(finding("error", "L9", `screen.executes lists "${name}" more than once.`, slice.path));
    }

    for (const name of slice.screen.reads) {
      if (!queryNames.includes(name)) {
        findings.push(finding("error", "W2", `screen.reads references missing local query "${name}".`, slice.path));
      }
    }
    for (const name of slice.screen.executes) {
      if (!commandNames.includes(name)) {
        findings.push(finding("error", "W1", `screen.executes references missing local command "${name}".`, slice.path));
      }
    }

    if (slice.screen.type === "system" && slice.screen.actors.length > 0) {
      findings.push(finding("error", "L5", `System slice "${slice.title}" must not declare screen.actors.`, slice.path));
    }
    if (!slice.storyName) {
      findings.push(finding("warning", "M2", `Slice "${slice.title}" is not listed by any story.`, slice.path));
    }
    if (slice.commands.length > 0 && slice.gwt.length === 0) {
      findings.push(finding("warning", "M1", `Command slice "${slice.title}" has no GWT scenarios.`, slice.path));
    }

    for (const command of slice.commands) {
      if (!command.fields?.trim()) {
        findings.push(finding("warning", "L6", `Command "${command.name}" has no fields block.`, slice.path));
      }
      for (const eventName of command.produces) {
        if (!eventNames.has(eventName)) {
          findings.push(finding("error", "G1", `Command "${command.name}" produces unregistered event "${eventName}".`, slice.path));
        }
        produced.set(eventName, [...(produced.get(eventName) ?? []), `${slice.title}.${command.name}`]);
      }
    }

    for (const query of slice.queries) {
      if (!query.fields?.trim()) {
        findings.push(finding("warning", "L7", `Query "${query.name}" has no fields block.`, slice.path));
      }
      if (!query.name.includes("For")) {
        findings.push(finding("warning", "N1", `Query "${query.name}" should use a descriptive <Thing>For<UseCaseOrScreen> name.`, slice.path));
      }
      for (const eventName of query.fromEvents) {
        if (!eventNames.has(eventName)) {
          findings.push(finding("error", "G2", `Query "${query.name}" reads unregistered event "${eventName}".`, slice.path));
        }
        consumed.set(eventName, [...(consumed.get(eventName) ?? []), `${slice.title}.${query.name}`]);
      }
    }

    for (const scenario of slice.gwt) {
      for (const item of [...scenario.given, ...scenario.when, ...scenario.then]) {
        if (!item.type || !["event", "command", "query", "error"].includes(item.type)) {
          findings.push(finding("error", "L8", `GWT scenario "${scenario.name ?? "Unnamed"}" has invalid item type "${item.type ?? ""}".`, slice.path));
        }
        if (!item.name) {
          findings.push(finding("error", "L8", `GWT scenario "${scenario.name ?? "Unnamed"}" has an item without a name.`, slice.path));
        }
      }
    }
  }

  for (const eventName of eventNames) {
    const producers = produced.get(eventName) ?? [];
    const consumers = consumed.get(eventName) ?? [];

    if (producers.length === 0) {
      findings.push(finding("error", "G3", `Event "${eventName}" is registered but no command produces it.`));
    }
    if (producers.length > 1) {
      findings.push(finding("warning", "G8", `Event "${eventName}" has multiple producers: ${producers.join(", ")}.`));
    }
    if (producers.length > 0 && consumers.length === 0) {
      findings.push(
        finding(
          "warning",
          isDispatchEvent(eventName) ? "G4b" : "G4a",
          `Event "${eventName}" is produced but no query consumes it.`
        )
      );
    }
  }

  for (const [eventName, consumers] of consumed.entries()) {
    if ((produced.get(eventName) ?? []).length === 0) {
      findings.push(finding("error", "G3", `Event "${eventName}" is read by ${consumers.join(", ")} but no command produces it.`));
    }
  }

  for (const name of duplicates(project.slices.flatMap((slice) => slice.commands.map((command) => command.name)))) {
    findings.push(finding("warning", "M5", `Command name "${name}" is used in multiple slices; command names should be globally unique.`));
  }

  for (const name of duplicates(project.slices.flatMap((slice) => slice.queries.map((query) => query.name)))) {
    findings.push(finding("warning", "G7", `Query name "${name}" is used in multiple slices; query names should be globally unique.`));
  }

  const commandSliceCount = project.slices.filter((slice) => slice.commands.length > 0).length;
  if (commandSliceCount > 0 && project.events.length / commandSliceCount > 2) {
    findings.push(finding("warning", "M4", `The model has ${(project.events.length / commandSliceCount).toFixed(1)} events per command slice; check for UI/runtime events leaking into the model.`));
  }

  const sidecar = readGraphSidecar(project.root);
  if (sidecar) {
    for (const [nodeId, sidecarNode] of Object.entries(sidecar.nodes)) {
      const matches = resolveSidecarNode(project, sidecarNode);
      if (matches.length === 0) {
        findings.push(finding("warning", "V1", `graph.json node "${nodeId}" selector does not resolve.`, ".event-modeling/graph.json", nodeId));
      }
      if (matches.length > 1) {
        findings.push(
          finding("warning", "V2", `graph.json node "${nodeId}" selector resolves to ${matches.length} nodes.`, ".event-modeling/graph.json", nodeId)
        );
      }
    }
  }

  const islandCount = connectedComponentCount(project);
  if (islandCount > 1) {
    findings.push(finding("info", "I3", `The graph has ${islandCount} disconnected islands.`));
  }

  return {
    errors: findings.filter((item) => item.severity === "error").length,
    warnings: findings.filter((item) => item.severity === "warning").length,
    findings
  };
}
