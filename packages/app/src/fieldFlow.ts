import type { EventModelProject, FieldFlow, ProjectNode } from "./types";

const FIELD_LABEL_LIMIT = 3;
const FIELD_FLOW_EDGE_KINDS = new Set(["command-event", "event-query"]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function fieldLabel(flow: Pick<FieldFlow, "visibleFieldNames" | "remainingCount">): string {
  const base = flow.visibleFieldNames.join(", ");
  return flow.remainingCount > 0 ? `${base} +${flow.remainingCount}` : base;
}

export function fieldDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((fieldName) => !rightSet.has(fieldName));
}

export function parseFieldNames(fields?: string): string[] {
  if (!fields?.trim()) return [];

  return unique(
    fields
      .split(/\r?\n/)
      .map((line) => fieldNameFromLine(line))
      .filter((name): name is string => Boolean(name))
  );
}

function fieldNameFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const withoutBullet = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
  const match = withoutBullet.match(/^`?([A-Za-z_][A-Za-z0-9_.-]*)`?(?=\s*(?::|-|=|\(|,|$))/);
  return match?.[1];
}

export function buildFieldFlows(project: EventModelProject): Map<string, FieldFlow> {
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const fieldNamesByNodeId = new Map(project.nodes.map((node) => [node.id, parseFieldNames(node.fields)]));
  const flows = new Map<string, FieldFlow>();

  for (const edge of project.edges) {
    if (!FIELD_FLOW_EDGE_KINDS.has(edge.kind)) continue;

    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!isFieldNode(source) || !isFieldNode(target)) continue;

    const sourceFieldNames = fieldNamesByNodeId.get(edge.source) ?? [];
    const targetFieldNames = fieldNamesByNodeId.get(edge.target) ?? [];
    const targetSet = new Set(targetFieldNames);
    const sharedFieldNames = sourceFieldNames.filter((fieldName) => targetSet.has(fieldName));
    const derivedFieldNames = edge.kind === "event-query" ? derivedFieldsForEvent(source, targetFieldNames, sharedFieldNames) : [];
    const labelFieldNames = unique([...sharedFieldNames, ...derivedFieldNames]);

    flows.set(edge.id, {
      sourceFieldNames,
      targetFieldNames,
      sharedFieldNames,
      derivedFieldNames,
      visibleFieldNames: labelFieldNames.slice(0, FIELD_LABEL_LIMIT),
      remainingCount: Math.max(0, labelFieldNames.length - FIELD_LABEL_LIMIT),
      sourceMissingFields: sourceFieldNames.length === 0,
      targetMissingFields: targetFieldNames.length === 0
    });
  }

  return flows;
}

export function fieldFlowEdgeIdsForField(flows: Map<string, FieldFlow>, fieldName?: string): Set<string> | undefined {
  if (!fieldName) return undefined;
  const edgeIds = [...flows.entries()]
    .filter(([, flow]) => flow.sharedFieldNames.includes(fieldName) || flow.derivedFieldNames.includes(fieldName))
    .map(([edgeId]) => edgeId);
  return edgeIds.length > 0 ? new Set(edgeIds) : undefined;
}

function isFieldNode(node?: ProjectNode): node is ProjectNode {
  return node?.type === "command" || node?.type === "event" || node?.type === "query";
}

function derivedFieldsForEvent(eventNode: ProjectNode, targetFieldNames: string[], sharedFieldNames: string[]): string[] {
  const eventKey = normalizeFieldProvenanceKey(eventNode.label);
  const shared = new Set(sharedFieldNames);
  return targetFieldNames.filter((fieldName) => !shared.has(fieldName) && normalizeFieldProvenanceKey(fieldName).includes(eventKey));
}

function normalizeFieldProvenanceKey(value: string): string {
  return value
    .replace(/^(has|is|was|were)/i, "")
    .replace(/been/gi, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}
