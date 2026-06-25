import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
  Position
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { buildFieldFlows, fieldFlowEdgeIdsForField, parseFieldNames } from "./fieldFlow";
import { toFlow } from "./layout";
import type { EventModelProject, FieldFlow, GraphDiff, GraphDiffStatus, ProjectNode, ValidationFinding, ValidationReport } from "./types";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "@emviz/parser/browser";
import { validateEventModelProject as validateImportedProject } from "@emviz/validator/browser";

type StandalonePayload = {
  project: EventModelProject;
  report?: ValidationReport;
  diff?: GraphDiff;
  exportedAt: string;
};

declare global {
  interface Window {
    __EMVIZ_EXPORT__?: StandalonePayload;
  }
}

type CustomNodeData = {
  projectNode: ProjectNode;
  selected: boolean;
  connected: boolean;
  diffStatus?: GraphDiffStatus;
};

function NodeHandles() {
  return (
    <>
      <Handle id="top-target" type="target" position={Position.Top} style={{ left: "46%" }} />
      <Handle id="top-source" type="source" position={Position.Top} style={{ left: "54%" }} />
      <Handle id="bottom-target" type="target" position={Position.Bottom} style={{ left: "46%" }} />
      <Handle id="bottom-source" type="source" position={Position.Bottom} style={{ left: "54%" }} />
      <Handle id="left-target" type="target" position={Position.Left} style={{ top: "46%" }} />
      <Handle id="left-source" type="source" position={Position.Left} style={{ top: "54%" }} />
      <Handle id="right-target" type="target" position={Position.Right} style={{ top: "46%" }} />
      <Handle id="right-source" type="source" position={Position.Right} style={{ top: "54%" }} />
    </>
  );
}

function GwtStepList({ title, items }: { title: string; items?: ProjectNode["given"] }) {
  const visibleItems = items && items.length > 0 ? items : [{ type: "empty", name: "empty" }];

  return (
    <div className="gwt-step">
      <div className="gwt-step-title">{title}</div>
      <div className="gwt-step-items">
        {visibleItems.map((item, index) => (
          <div className={`gwt-step-item gwt-step-item-${item.type ?? "empty"}`} key={`${item.type ?? "empty"}-${item.name ?? index}`}>
            <span>{item.type ?? "empty"}</span>
            <strong>{item.name ?? "empty"}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventModelNode({ data }: NodeProps) {
  const nodeData = data as CustomNodeData;
  const node = nodeData.projectNode;
  const diffBadge = nodeData.diffStatus && nodeData.diffStatus !== "unchanged" ? <div className={`diff-badge diff-badge-${nodeData.diffStatus}`}>{nodeData.diffStatus}</div> : null;
  if (node.type === "gwt") {
    return (
      <div className={`em-node em-node-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.connected ? "connected" : ""} ${nodeData.diffStatus ? `diff-node-${nodeData.diffStatus}` : ""}`}>
        <NodeHandles />
        {diffBadge}
        <div className="node-type">GWT case</div>
        <div className="node-label">{node.label}</div>
        {node.description ? <div className="gwt-description">{node.description}</div> : null}
        <div className="gwt-steps">
          <GwtStepList title="Given" items={node.given} />
          <GwtStepList title="When" items={node.when} />
          <GwtStepList title="Then" items={node.then} />
        </div>
      </div>
    );
  }

  return (
    <div className={`em-node em-node-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.connected ? "connected" : ""} ${nodeData.diffStatus ? `diff-node-${nodeData.diffStatus}` : ""}`}>
      <NodeHandles />
      {diffBadge}
      <div className="node-type">{node.type}</div>
      <div className="node-label">{node.label}</div>
      {node.actors && node.actors.length > 0 ? (
        <div className="chips">{node.actors.map((actor) => <span key={actor}>{actor}</span>)}</div>
      ) : null}
    </div>
  );
}

function GroupNode({ data }: NodeProps) {
  const nodeData = data as CustomNodeData;
  const node = nodeData.projectNode;
  return (
    <div className={`group-node group-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.diffStatus ? `diff-node-${nodeData.diffStatus}` : ""}`}>
      {nodeData.diffStatus && nodeData.diffStatus !== "unchanged" ? <div className={`diff-badge diff-badge-${nodeData.diffStatus}`}>{nodeData.diffStatus}</div> : null}
      <div className="group-title">{node.label}</div>
      {node.description ? <div className="group-description">{node.description}</div> : null}
    </div>
  );
}

const nodeTypes = {
  eventModelNode: EventModelNode,
  groupNode: GroupNode
};

type EdgeRoute = {
  kind?: string;
  route?: "semantic" | "same-slice-read" | "event-read";
  active?: boolean;
  diffStatus?: GraphDiffStatus;
  fieldFlow?: FieldFlow;
  selectedFieldName?: string;
  onSelectField?: (fieldName: string) => void;
};

function positionVector(position: Position): { x: number; y: number } {
  if (position === Position.Top) return { x: 0, y: -1 };
  if (position === Position.Right) return { x: 1, y: 0 };
  if (position === Position.Bottom) return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

function eventModelPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data
}: EdgeProps): string {
  const route = data as EdgeRoute | undefined;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const verticalBend = Math.max(56, Math.min(180, Math.abs(dy) * 0.42));
  const horizontalBend = Math.max(70, Math.min(180, Math.abs(dx) * 0.38));
  const bend = Math.max(72, Math.min(180, Math.max(Math.abs(dx), Math.abs(dy)) * 0.38));

  if (route?.route === "same-slice-read") {
    const sourceDirection = sourcePosition === Position.Top ? -1 : 1;
    const targetDirection = targetPosition === Position.Bottom ? 1 : -1;
    const lift = Math.max(72, Math.min(150, Math.abs(dy) * 0.65));
    return `M ${sourceX},${sourceY} C ${sourceX},${sourceY + sourceDirection * lift} ${targetX},${targetY + targetDirection * lift} ${targetX},${targetY}`;
  }

  if (route?.route === "event-read") {
    const sourceVector = positionVector(sourcePosition);
    const targetVector = positionVector(targetPosition);
    return `M ${sourceX},${sourceY} C ${sourceX + sourceVector.x * bend},${sourceY + sourceVector.y * bend} ${targetX + targetVector.x * bend},${targetY + targetVector.y * bend} ${targetX},${targetY}`;
  }

  if (sourcePosition === Position.Bottom || sourcePosition === Position.Top) {
    const sourceDirection = sourcePosition === Position.Top ? -1 : 1;
    const targetDirection = targetPosition === Position.Top ? -1 : 1;
    return `M ${sourceX},${sourceY} C ${sourceX},${sourceY + sourceDirection * verticalBend} ${targetX},${targetY + targetDirection * verticalBend} ${targetX},${targetY}`;
  }

  const sourceDirection = sourcePosition === Position.Left ? -1 : 1;
  const targetDirection = targetPosition === Position.Left ? -1 : 1;
  return `M ${sourceX},${sourceY} C ${sourceX + sourceDirection * horizontalBend},${sourceY} ${targetX + targetDirection * horizontalBend},${targetY} ${targetX},${targetY}`;
}

function EventModelEdge(props: EdgeProps) {
  const route = props.data as EdgeRoute | undefined;
  const diffStroke = route?.diffStatus === "added" ? "#15803d" : route?.diffStatus === "removed" ? "#b91c1c" : route?.diffStatus === "changed" ? "#b45309" : undefined;
  const stroke = route?.active ? "#111827" : diffStroke ?? "#64748b";
  const flow = route?.fieldFlow;
  const selectedFieldInFlow = Boolean(
    route?.selectedFieldName &&
      (flow?.sharedFieldNames.includes(route.selectedFieldName) || flow?.derivedFieldNames.includes(route.selectedFieldName))
  );
  const labelX = (props.sourceX + props.targetX) / 2;
  const labelY = (props.sourceY + props.targetY) / 2;
  return (
    <>
      <BaseEdge
        path={eventModelPath(props)}
        markerEnd={props.markerEnd}
        style={{ ...props.style, stroke, strokeDasharray: route?.diffStatus === "removed" ? "7 5" : undefined, strokeWidth: route?.diffStatus && route.diffStatus !== "unchanged" ? 2.4 : undefined }}
        className={route?.active ? "edge-path-active" : "edge-path"}
      />
      {flow && flow.visibleFieldNames.length > 0 && (route?.active || selectedFieldInFlow) ? (
        <EdgeLabelRenderer>
          <div
            className={`edge-field-label nodrag nopan ${route?.active ? "active" : ""} ${selectedFieldInFlow ? "field-selected" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {flow.visibleFieldNames.map((fieldName) => (
              <button type="button" key={fieldName} onClick={() => route?.onSelectField?.(fieldName)}>
                {fieldName}
              </button>
            ))}
            {flow.remainingCount > 0 ? <span>+{flow.remainingCount}</span> : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const edgeTypes = {
  eventModelEdge: EventModelEdge
};

function CopyAction({
  label,
  description,
  value,
  copiedKey,
  onCopy
}: {
  label: string;
  description: string;
  value: string;
  copiedKey: string;
  onCopy: (key: string, value: string) => void;
}) {
  return (
    <button type="button" className="copy-action" onClick={() => onCopy(copiedKey, value)}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function isBehaviorConnection(edgeKind: string): boolean {
  return edgeKind === "query-screen" || edgeKind === "screen-command" || edgeKind === "command-event" || edgeKind === "event-query";
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function modelFileBaseName(project: EventModelProject): string {
  const name = project.graphSidecar?.model?.name ?? project.graphSidecar?.model?.id ?? "event-model";
  const cleanName = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleanName || "event-model";
}

async function fetchAssetText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function createStandaloneHtml(project: EventModelProject, report?: ValidationReport, diff?: GraphDiff): Promise<string> {
  const moduleScripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[type=\"module\"][src]"))
    .map((script) => new URL(script.src, window.location.href))
    .filter((url) => !url.pathname.includes("/@vite/") && !url.pathname.endsWith("/@react-refresh"));

  if (moduleScripts.length === 0 || moduleScripts.some((url) => url.pathname.includes("/src/") || url.pathname.endsWith(".tsx"))) {
    throw new Error("Standalone export requires a built emviz app. Run the packaged CLI or `pnpm --filter @emviz/app build` and open the built app.");
  }

  const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=\"stylesheet\"][href]"))
    .map((link) => new URL(link.href, window.location.href));
  const linkedCss = await Promise.all(stylesheetLinks.map((url) => fetchAssetText(url.href)));
  const inlineCss = Array.from(document.querySelectorAll<HTMLStyleElement>("style"))
    .map((style) => style.textContent ?? "")
    .filter(Boolean);
  const scripts = await Promise.all(moduleScripts.map((url) => fetchAssetText(url.href)));
  const payload: StandalonePayload = {
    project,
    report,
    diff,
    exportedAt: new Date().toISOString()
  };

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "  <head>",
    "    <meta charset=\"UTF-8\" />",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    `    <title>emviz - ${project.graphSidecar?.model?.name ?? "export"}</title>`,
    `    <style>${[...linkedCss, ...inlineCss].join("\n\n")}</style>`,
    "  </head>",
    "  <body>",
    "    <div id=\"root\"></div>",
    `    <script>window.__EMVIZ_EXPORT__ = ${jsonForScript(payload)};</script>`,
    `    <script type=\"module\">${scripts.join("\n\n")}</script>`,
    "  </body>",
    "</html>"
  ].join("\n");
}

type DiffFilter = "all" | "added" | "removed" | "changed";

function DiffPanel({
  diff,
  filter,
  onFilter,
  onSelect
}: {
  diff: GraphDiff;
  filter: DiffFilter;
  onFilter: (filter: DiffFilter) => void;
  onSelect: (nodeId: string) => void;
}) {
  const changedNodeEntries = Object.entries(diff.nodeStatus)
    .filter(([, status]) => status !== "unchanged")
    .slice(0, 80);

  return (
    <aside className="panel diff-panel">
      <h2>Diff</h2>
      <div className="diff-range">
        <code>{diff.base.label}</code>
        <span>to</span>
        <code>{diff.target.label}</code>
      </div>
      <div className="diff-counts">
        <button type="button" className={filter === "added" ? "active added" : "added"} onClick={() => onFilter(filter === "added" ? "all" : "added")}>
          <strong>{diff.summary.nodes.added}</strong>
          <span>Added</span>
        </button>
        <button type="button" className={filter === "removed" ? "active removed" : "removed"} onClick={() => onFilter(filter === "removed" ? "all" : "removed")}>
          <strong>{diff.summary.nodes.removed}</strong>
          <span>Removed</span>
        </button>
        <button type="button" className={filter === "changed" ? "active changed" : "changed"} onClick={() => onFilter(filter === "changed" ? "all" : "changed")}>
          <strong>{diff.summary.nodes.changed}</strong>
          <span>Changed</span>
        </button>
      </div>
      {filter !== "all" ? (
        <button type="button" className="clear-diff-filter" onClick={() => onFilter("all")}>Show full graph</button>
      ) : null}
      <h3>Changed Nodes</h3>
      <div className="diff-list">
        {changedNodeEntries.length === 0 ? <p className="muted">No node changes.</p> : changedNodeEntries.map(([nodeId, status]) => (
          <button type="button" className={`diff-list-item ${status}`} key={nodeId} onClick={() => onSelect(nodeId)}>
            <span>{nodeId}</span>
            <strong>{status}</strong>
          </button>
        ))}
      </div>
    </aside>
  );
}

function downloadTextFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function filesFromFileList(fileList: FileList): Promise<InMemoryEventModelFile[]> {
  const files = await Promise.all(
    Array.from(fileList)
      .filter((file) => /\.(ya?ml|json)$/i.test(file.name))
      .map(async (file) => ({
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        content: await file.text()
      }))
  );

  return files;
}

function graphSidecarFromFiles(files: InMemoryEventModelFile[]): EventModelProject["graphSidecar"] | undefined {
  const graphFile = files.find((file) => file.path === ".event-modeling/graph.json" || file.path.endsWith("/.event-modeling/graph.json"));
  if (!graphFile) return undefined;

  try {
    const parsed = JSON.parse(graphFile.content) as EventModelProject["graphSidecar"];
    return parsed;
  } catch {
    return undefined;
  }
}

function selectorForNode(node: ProjectNode): Record<string, string> {
  if (node.type === "story") return { name: node.label };
  if (node.type === "slice") return { slice: node.label };
  if (node.type === "screen" || node.type === "processor") return { slice: node.sliceTitle ?? node.label };
  if (node.type === "command" || node.type === "query") return { slice: node.sliceTitle ?? "", name: node.sourceName ?? node.label };
  return { name: node.sourceName ?? node.label };
}

function sidecarFindings(project: EventModelProject): ValidationFinding[] {
  const sidecarNodes = project.graphSidecar?.nodes;
  if (!sidecarNodes) return [];

  return Object.entries(sidecarNodes).flatMap(([nodeId, rawNode]) => {
    const sidecarNode = rawNode as { type?: string; selector?: Record<string, string> };
    const matches = project.nodes.filter((node) => {
      if (sidecarNode.type === "screen" && node.type !== "screen" && node.type !== "processor") return false;
      if (sidecarNode.type !== "screen" && sidecarNode.type !== node.type) return false;
      const selector = selectorForNode(node);
      return Object.entries(sidecarNode.selector ?? {}).every(([key, value]) => selector[key] === value);
    });
    if (matches.length === 0) {
      return [{
        id: `V1:.event-modeling/graph.json:${nodeId}`,
        severity: "warning" as const,
        check: "V1",
        message: `graph.json node "${nodeId}" selector does not resolve.`,
        path: ".event-modeling/graph.json",
        nodeId
      }];
    }
    if (matches.length > 1) {
      return [{
        id: `V2:.event-modeling/graph.json:${nodeId}`,
        severity: "warning" as const,
        check: "V2",
        message: `graph.json node "${nodeId}" selector resolves to ${matches.length} nodes.`,
        path: ".event-modeling/graph.json",
        nodeId
      }];
    }
    return [];
  });
}

function provenanceRows({
  edge,
  flow,
  selectedNode,
  peer
}: {
  edge: EventModelProject["edges"][number];
  flow?: FieldFlow;
  selectedNode: ProjectNode;
  peer?: ProjectNode;
}): { fieldName: string; source: string; kind: "field" | "event" }[] {
  if (!flow || !peer) return [];

  const incoming = edge.target === selectedNode.id;
  const source = incoming ? peer : selectedNode;
  return [
    ...flow.sharedFieldNames.map((fieldName) => ({
      fieldName,
      source: `${source.label}.${fieldName}`,
      kind: "field" as const
    })),
    ...flow.derivedFieldNames.map((fieldName) => ({
      fieldName,
      source: source.type === "event" ? `${source.label} occurred` : source.label,
      kind: "event" as const
    }))
  ];
}

function ImportPanel({
  onImport,
  error
}: {
  onImport: (files: FileList) => void;
  error?: string;
}) {
  return (
    <div className="import-panel">
      <div className="import-card">
        <h1>emviz</h1>
        <p>Import an Event Modeling project folder or select YAML/JSON files to visualize the model.</p>
        <div className="import-actions">
          <label>
            Import folder
            <input
              type="file"
              multiple
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => event.currentTarget.files && onImport(event.currentTarget.files)}
            />
          </label>
          <label>
            Import files
            <input
              type="file"
              multiple
              accept=".yaml,.yml,.json"
              onChange={(event) => event.currentTarget.files && onImport(event.currentTarget.files)}
            />
          </label>
        </div>
        {error ? <p className="import-error">{error}</p> : null}
      </div>
    </div>
  );
}

function SourcePanel({
  project,
  selectedNode,
  findings,
  fieldFlows,
  selectedFieldName,
  onSelect,
  onSelectField,
  onClearField,
  onPreviewConnection,
  onClearPreview
}: {
  project: EventModelProject;
  selectedNode?: ProjectNode;
  findings: ValidationFinding[];
  fieldFlows: Map<string, FieldFlow>;
  selectedFieldName?: string;
  onSelect: (nodeId: string) => void;
  onSelectField: (fieldName: string) => void;
  onClearField: () => void;
  onPreviewConnection: (edgeId: string) => void;
  onClearPreview: () => void;
}) {
  const [copied, setCopied] = useState<string>();

  const copyPanelText = useCallback((key: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? undefined : current), 1400);
    });
  }, []);

  if (!selectedNode) {
    return (
      <aside className="panel panel-right">
        <h2>Selection</h2>
        <p className="muted">Select a node to inspect source and connections.</p>
      </aside>
    );
  }

  const incoming = project.edges.filter((edge) => edge.target === selectedNode.id && isBehaviorConnection(edge.kind));
  const outgoing = project.edges.filter((edge) => edge.source === selectedNode.id && isBehaviorConnection(edge.kind));
  const fieldNames = parseFieldNames(selectedNode.fields);
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const modelId = project.graphSidecar?.model?.id ?? "event_model";
  const reference = `em://${modelId}/${selectedNode.id}`;
  const yaml = selectedNode.raw ?? selectedNode.fields ?? selectedNode.description ?? selectedNode.label;
  const connectedContext = [
    `Reference: ${reference}`,
    `Node: ${selectedNode.label} (${selectedNode.type})`,
    `Source: ${selectedNode.sourcePath ?? "unknown"}`,
    "",
    "Incoming:",
    ...(incoming.length === 0 ? ["- none"] : incoming.map((edge) => `- ${nodeById.get(edge.source)?.label ?? edge.source} -> ${selectedNode.label}`)),
    "",
    "Outgoing:",
    ...(outgoing.length === 0 ? ["- none"] : outgoing.map((edge) => `- ${selectedNode.label} -> ${nodeById.get(edge.target)?.label ?? edge.target}`)),
    "",
    "Source excerpt:",
    yaml
  ].join("\n");
  const prompt = `Please update this event model node.\n\nReference:\n${reference}\n\nSource path:\n${selectedNode.sourcePath ?? "unknown"}\n\nCurrent context:\n${yaml}\n\nGoal:\n`;

  return (
    <aside className="panel panel-right">
      <div className="panel-heading">
        <h2>{selectedNode.label}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={() => onSelect(selectedNode.id)}
          aria-label="Focus selected node"
          title="Focus selected node"
        >
          <span className="target-icon" aria-hidden="true" />
        </button>
      </div>
      <div className="meta-row"><span>Type</span><strong>{selectedNode.type}</strong></div>
      <div className="meta-row"><span>Reference</span><code>{reference}</code></div>
      {selectedNode.sourcePath ? <div className="meta-row"><span>Source</span><code>{selectedNode.sourcePath}</code></div> : null}
      <details className="copy-section">
        <summary>
          <span>Copy for LLM</span>
          {copied ? <strong className="copy-feedback" aria-live="polite">Copied {copied}</strong> : null}
        </summary>
        <div className="copy-actions">
          <CopyAction
            label="Reference"
            description="Stable em:// node handle"
            value={reference}
            copiedKey="reference"
            onCopy={copyPanelText}
          />
          <CopyAction
            label="YAML"
            description="Source excerpt for this node"
            value={yaml}
            copiedKey="YAML"
            onCopy={copyPanelText}
          />
          <CopyAction
            label="Context"
            description="Reference plus incoming/outgoing links"
            value={connectedContext}
            copiedKey="context"
            onCopy={copyPanelText}
          />
          <CopyAction
            label="Edit prompt"
            description="Prompt scaffold for asking an LLM to edit"
            value={prompt}
            copiedKey="prompt"
            onCopy={copyPanelText}
          />
        </div>
      </details>
      <h3>Connections</h3>
      <div className="connection-list">
        <strong>Incoming</strong>
        {incoming.length === 0 ? <p className="muted">None</p> : incoming.map((edge) => {
          const peer = nodeById.get(edge.source);
          const rows = provenanceRows({ edge, flow: fieldFlows.get(edge.id), selectedNode, peer });
          return (
            <button
              type="button"
              className="connection-button"
              key={edge.id}
              onClick={() => onSelect(edge.source)}
              onMouseEnter={() => onPreviewConnection(edge.id)}
              onMouseLeave={onClearPreview}
              onFocus={() => onPreviewConnection(edge.id)}
              onBlur={onClearPreview}
            >
              <span>{peer?.label ?? edge.source}</span>
              {rows.length > 0 ? (
                <span className="provenance-rows">
                  {rows.map((row) => (
                    <span className={selectedFieldName === row.fieldName ? "selected" : ""} key={`${edge.id}-${row.fieldName}-${row.source}`}>
                      <b>{row.fieldName}</b>
                      <span aria-hidden="true">←</span>
                      <em>{row.source}</em>
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
        <strong>Outgoing</strong>
        {outgoing.length === 0 ? <p className="muted">None</p> : outgoing.map((edge) => {
          const peer = nodeById.get(edge.target);
          const rows = provenanceRows({ edge, flow: fieldFlows.get(edge.id), selectedNode, peer });
          return (
            <button
              type="button"
              className="connection-button"
              key={edge.id}
              onClick={() => onSelect(edge.target)}
              onMouseEnter={() => onPreviewConnection(edge.id)}
              onMouseLeave={onClearPreview}
              onFocus={() => onPreviewConnection(edge.id)}
              onBlur={onClearPreview}
            >
              <span>{peer?.label ?? edge.target}</span>
              {rows.length > 0 ? (
                <span className="provenance-rows">
                  {rows.map((row) => (
                    <span className={selectedFieldName === row.fieldName ? "selected" : ""} key={`${edge.id}-${row.fieldName}-${row.source}`}>
                      <b>{row.fieldName}</b>
                      <span aria-hidden="true">←</span>
                      <em>{row.source}</em>
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {selectedNode.type === "command" || selectedNode.type === "event" || selectedNode.type === "query" ? (
        <>
          <h3>Fields</h3>
          <div className="field-panel">
            {fieldNames.length === 0 ? (
              <p className="field-empty">No fields documented.</p>
            ) : (
              <div className="field-list">
                {fieldNames.map((fieldName) => (
                  <button
                    type="button"
                    key={fieldName}
                    className={selectedFieldName === fieldName ? "selected" : ""}
                    onClick={() => onSelectField(fieldName)}
                  >
                    {fieldName}
                  </button>
                ))}
              </div>
            )}
            {selectedFieldName ? (
              <button type="button" className="clear-field" onClick={onClearField}>
                Clear field focus
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <h3>Findings</h3>
      {findings.length === 0 ? <p className="muted">No findings for this node.</p> : findings.map((finding) => (
        <div className={`finding finding-${finding.severity}`} key={finding.id}>
          <strong>{finding.check}</strong>
          <span>{finding.message}</span>
        </div>
      ))}
      <h3>Source</h3>
      <pre>{yaml}</pre>
    </aside>
  );
}

function ValidationPanel({
  report,
  onSelect,
  open,
  onOpen,
  onClose
}: {
  report?: ValidationReport;
  onSelect: (nodeId: string) => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const errors = report?.errors ?? 0;
  const warnings = report?.warnings ?? 0;
  const total = errors + warnings;

  return (
    <>
      <button
        type="button"
        className={`validation-fab ${errors > 0 ? "has-errors" : warnings > 0 ? "has-warnings" : ""}`}
        onClick={onOpen}
        aria-expanded={open}
        aria-controls="validation-panel"
        title="Open validation"
      >
        <span aria-hidden="true">!</span>
        {total > 0 ? <strong aria-label={`${total} validation findings`}>{total}</strong> : null}
      </button>
      {open ? (
        <aside className="panel validation-drawer" id="validation-panel">
          <div className="panel-heading">
            <h2>Validation</h2>
            <button type="button" className="panel-close" onClick={onClose} aria-label="Close validation">Close</button>
          </div>
          {!report ? <p className="muted">Loading validation...</p> : (
            <>
              <div className="status-row">
                <span className="status error">{report.errors} errors</span>
                <span className="status warning">{report.warnings} warnings</span>
              </div>
              <div className="findings-list">
                {report.findings.length === 0 ? <p className="muted">No validation findings.</p> : report.findings.map((finding) => (
                  <div className={`finding finding-${finding.severity}`} key={finding.id}>
                    <div className="finding-header">
                      <strong>{finding.check}</strong>
                      {finding.nodeId ? (
                        <button type="button" onClick={() => onSelect(finding.nodeId!)}>Focus</button>
                      ) : null}
                    </div>
                    <span>{finding.message}</span>
                    {finding.path ? <code>{finding.path}</code> : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      ) : null}
    </>
  );
}

function FlowWorkspace() {
  const [project, setProject] = useState<EventModelProject>();
  const [report, setReport] = useState<ValidationReport>();
  const [diff, setDiff] = useState<GraphDiff>();
  const [diffFilter, setDiffFilter] = useState<DiffFilter>("all");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "import">("loading");
  const [importError, setImportError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "exporting">("idle");
  const [exportError, setExportError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string>();
  const [selectedFieldName, setSelectedFieldName] = useState<string>();
  const [validationOpen, setValidationOpen] = useState(false);
  const { setCenter, fitView } = useReactFlow();

  useEffect(() => {
    if (window.__EMVIZ_EXPORT__?.project) {
      setProject(window.__EMVIZ_EXPORT__.project);
      setReport(window.__EMVIZ_EXPORT__.report);
      setDiff(window.__EMVIZ_EXPORT__.diff);
      setLoadState("ready");
      window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
      return;
    }

    void Promise.all([
      fetch("/api/model").then((res) => res.json()),
      fetch("/api/validation").then((res) => res.ok ? res.json() : undefined).catch(() => undefined),
      fetch("/api/diff").then((res) => res.ok ? res.json() : undefined).catch(() => undefined)
    ]).then(([model, validation, diffPayload]) => {
      setProject(model);
      setReport(validation);
      setDiff(diffPayload);
      setLoadState("ready");
      window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
    }).catch(() => {
      setLoadState("import");
    });
  }, [fitView]);

  const selectedNode = useMemo(() => project?.nodes.find((node) => node.id === selectedId), [project, selectedId]);
  const selectedFindings = useMemo(
    () => report?.findings.filter((finding) => finding.nodeId === selectedId) ?? [],
    [report, selectedId]
  );
  const fieldFlows = useMemo(() => project ? buildFieldFlows(project) : new Map<string, FieldFlow>(), [project]);
  const focusedEdgeIds = useMemo(() => {
    if (hoveredEdgeId) return new Set([hoveredEdgeId]);
    const fieldEdgeIds = fieldFlowEdgeIdsForField(fieldFlows, selectedFieldName);
    if (fieldEdgeIds) return fieldEdgeIds;
    if (!project || !selectedId) return undefined;
    const edgeIds = new Set<string>();
    for (const edge of project.edges) {
      if (isBehaviorConnection(edge.kind) && (edge.source === selectedId || edge.target === selectedId)) {
        edgeIds.add(edge.id);
      }
    }
    return edgeIds;
  }, [fieldFlows, hoveredEdgeId, project, selectedFieldName, selectedId]);
  const flow = useMemo(
    () => project ? toFlow(project, selectedId, {
      focusedEdgeIds,
      edgeFieldFlows: fieldFlows,
      selectedFieldName,
      onSelectField: setSelectedFieldName,
      diffNodeStatus: diff?.nodeStatus,
      diffEdgeStatus: diff?.edgeStatus,
      diffFilter
    }) : { nodes: [], edges: [] },
    [diff?.edgeStatus, diff?.nodeStatus, diffFilter, fieldFlows, focusedEdgeIds, project, selectedFieldName, selectedId]
  );
  const searchResults = useMemo(() => {
    if (!project || search.trim().length < 2) return [];
    const needle = search.trim().toLowerCase();
    return project.nodes.filter((node) => `${node.label} ${node.type} ${node.sourcePath ?? ""}`.toLowerCase().includes(needle)).slice(0, 8);
  }, [project, search]);

  const focusNode = useCallback((nodeId: string, recordHistory = true) => {
    const node = flow.nodes.find((candidate) => candidate.id === nodeId);
    setHoveredEdgeId(undefined);
    if (recordHistory && selectedId && selectedId !== nodeId) {
      setBackStack((stack) => [...stack, selectedId]);
      setForwardStack([]);
    }
    setSelectedId(nodeId);
    if (node) {
      void setCenter(node.position.x + 80, node.position.y + 60, { zoom: 1.2, duration: 350 });
    }
  }, [flow.nodes, selectedId, setCenter]);

  const clearFocus = useCallback(() => {
    setSelectedId(undefined);
    setHoveredEdgeId(undefined);
    setSelectedFieldName(undefined);
  }, []);

  const previewConnection = useCallback((edgeId: string) => {
    const edge = project?.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    setHoveredEdgeId(edgeId);
    const relatedNodes = flow.nodes.filter((node) => node.id === edge.source || node.id === edge.target);
    if (relatedNodes.length > 0) {
      void fitView({ nodes: relatedNodes, padding: 0.36, duration: 260, maxZoom: 1.25 });
    }
  }, [fitView, flow.nodes, project?.edges]);

  const clearPreviewConnection = useCallback(() => {
    setHoveredEdgeId(undefined);
  }, []);

  const exportStandalone = useCallback(() => {
    if (!project) return;
    setExportState("exporting");
    setExportError(undefined);
    setMenuOpen(false);
    void createStandaloneHtml(project, report, diff)
      .then((html) => {
        downloadTextFile(`${modelFileBaseName(project)}.emviz.html`, html);
      })
      .catch((error) => {
        setExportError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setExportState("idle"));
  }, [diff, project, report]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        clearFocus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearFocus]);

  const goBack = useCallback(() => {
    const previous = backStack.at(-1);
    if (!previous) return;
    setBackStack((stack) => stack.slice(0, -1));
    if (selectedId) setForwardStack((stack) => [...stack, selectedId]);
    focusNode(previous, false);
  }, [backStack, focusNode, selectedId]);

  const goForward = useCallback(() => {
    const next = forwardStack.at(-1);
    if (!next) return;
    setForwardStack((stack) => stack.slice(0, -1));
    if (selectedId) setBackStack((stack) => [...stack, selectedId]);
    focusNode(next, false);
  }, [focusNode, forwardStack, selectedId]);

  const importFiles = useCallback((fileList: FileList) => {
    void filesFromFileList(fileList).then((files) => {
      const parserProject = loadEventModelProjectFromFiles(files);
      const importedProject = parserProject as EventModelProject;
      importedProject.graphSidecar = graphSidecarFromFiles(files) ?? {
        model: {
          id: "browser_import",
          name: "Browser Import"
        }
      };
      setProject(importedProject);
      const baseReport = validateImportedProject(parserProject);
      const extraFindings = sidecarFindings(importedProject);
      setReport({
        errors: baseReport.errors,
        warnings: baseReport.warnings + extraFindings.filter((finding) => finding.severity === "warning").length,
        findings: [...baseReport.findings, ...extraFindings]
      });
      setDiff(undefined);
      setDiffFilter("all");
      setSelectedId(undefined);
      setHoveredEdgeId(undefined);
      setSelectedFieldName(undefined);
      setBackStack([]);
      setForwardStack([]);
      setLoadState("ready");
      setImportError(undefined);
      window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
    }).catch((error) => {
      setImportError(error instanceof Error ? error.message : String(error));
      setLoadState("import");
    });
  }, [fitView]);

  if (loadState === "import") {
    return <ImportPanel onImport={importFiles} error={importError} />;
  }

  if (!project) {
    return <div className="loading">Loading event model...</div>;
  }

  return (
    <div className={`app-shell ${diff ? "diff-mode" : ""}`}>
      <header className="toolbar">
        <div className="model-summary">
          <strong>emviz</strong>
          <span>{project.stories.length} stories</span>
          <span>{project.slices.length} slices</span>
          <span>{project.nodes.filter((node) => node.type === "event").length} events</span>
        </div>
        <div className="segmented toolbar-history" aria-label="Selection history">
          <button type="button" disabled={backStack.length === 0} onClick={goBack} aria-label="Back" title="Back">←</button>
          <button type="button" disabled={forwardStack.length === 0} onClick={goForward} aria-label="Forward" title="Forward">→</button>
        </div>
        <div className="search-box">
          <input aria-label="Search event model" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search nodes by name or type..." />
          {searchResults.length > 0 ? (
            <div className="search-results">
              {searchResults.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  onClick={() => {
                    focusNode(node.id);
                    setSearch("");
                  }}
                >
                  <span>{node.label}</span>
                  <small>{node.type}</small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="toolbar-menu">
          <button
            type="button"
            className="menu-trigger"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Open menu"
            title="Open menu"
          >
            ...
          </button>
          {menuOpen ? (
            <div className="menu-popover" role="menu">
              <button type="button" role="menuitem" onClick={exportStandalone} disabled={exportState === "exporting"}>
                {exportState === "exporting" ? "Exporting..." : "Export"}
              </button>
            </div>
          ) : null}
        </div>
        {exportError ? <div className="toolbar-error" role="alert">{exportError}</div> : null}
      </header>
      <ValidationPanel
        report={report}
        onSelect={focusNode}
        open={validationOpen}
        onOpen={() => setValidationOpen(true)}
        onClose={() => setValidationOpen(false)}
      />
      {diff ? (
        <DiffPanel
          diff={diff}
          filter={diffFilter}
          onFilter={setDiffFilter}
          onSelect={focusNode}
        />
      ) : null}
      <SourcePanel
        project={project}
        selectedNode={selectedNode}
        findings={selectedFindings}
        fieldFlows={fieldFlows}
        selectedFieldName={selectedFieldName}
        onSelect={focusNode}
        onSelectField={setSelectedFieldName}
        onClearField={() => setSelectedFieldName(undefined)}
        onPreviewConnection={previewConnection}
        onClearPreview={clearPreviewConnection}
      />
      <main className="canvas">
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, node) => focusNode(node.id)}
          fitView
          minZoom={0.2}
          maxZoom={1.8}
          nodesDraggable={false}
          colorMode="light"
        >
          <Background gap={18} size={1} />
          <Controls />
        </ReactFlow>
      </main>
    </div>
  );
}

function App() {
  return (
    <ReactFlowProvider>
      <FlowWorkspace />
    </ReactFlowProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
