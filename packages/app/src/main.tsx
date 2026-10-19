import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { apiFetch } from "./api";
import { buildFieldFlows, fieldFlowEdgeIdsForField, parseFieldNames } from "./fieldFlow";
import { toFlow } from "./layout";
import { actorOptions, pruneActorFilter, screenActors, type ActorFilter } from "./actors";
import { AgentPanel, useFeedbackSession, type SessionController } from "./feedback";
import { emptyFeedbackWorkspace, reconcileFeedbackQueue, restoreFeedbackWorkspace, serializeFeedbackWorkspace, type FeedbackQueue, type FeedbackWorkspace } from "./feedbackQueue";
import { connectionsAfter, connectionsBefore, feedbackDraftKey, previousNodeFor, resolveSelection, selectionForNode, updateFeedbackDraft, type FeedbackView, type NodeSelection } from "./feedbackState";
import type { EventModelProject, FieldFlow, GraphDiff, GraphDiffStatus, ProjectNode, ValidationFinding, ValidationReport } from "./types";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "@emviz/parser/browser";
import { validateEventModelProject as validateImportedProject } from "@emviz/validator/browser";

type StandalonePayload = {
  project: EventModelProject;
  report?: ValidationReport;
  diff?: GraphDiff;
  exportedAt: string;
  timelineId?: string;
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
  actorRelated?: boolean;
  diffStatus?: GraphDiffStatus;
  scenarios?: ProjectNode[];
  scenarioStatus?: Record<string, GraphDiffStatus>;
  selectedScenarioId?: string;
};

const GwtActions = React.createContext<{ open: (id: string) => void; list: (id: string) => void }>({ open: () => {}, list: () => {} });

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
          <div className={`gwt-step-item gwt-step-item-${item.type ?? "empty"}`} key={`${index}-${item.type ?? "empty"}-${item.name ?? ""}`}>
            <span>{item.type ?? "empty"}</span>
            <div className="gwt-item-content">
              <strong>{item.name ?? "empty"}</strong>
              {item.fields ? <pre>{item.fields}</pre> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GwtSummary({ nodeData }: { nodeData: CustomNodeData }) {
  const actions = React.useContext(GwtActions);
  const scenarios = nodeData.scenarios ?? [];
  return (
    <div className={`em-node em-node-gwt ${nodeData.selected ? "selected" : ""} ${nodeData.diffStatus ? `diff-node-${nodeData.diffStatus}` : ""}`}>
      <NodeHandles />
      <div className="node-type">GWT · {scenarios.length} cases</div>
      {nodeData.scenarioStatus ? <div className="gwt-diff-counts">{(["added", "removed", "changed"] as const).map((status) => `${status}: ${scenarios.filter((scenario) => nodeData.scenarioStatus?.[scenario.id] === status).length}`).join(" · ")}</div> : null}
      <div className="gwt-summary nodrag nopan nowheel">
        {scenarios.slice(0, 3).map((scenario) => (
          <button type="button" key={scenario.id} aria-current={nodeData.selectedScenarioId === scenario.id ? "true" : undefined} onClick={(event) => { event.stopPropagation(); actions.open(scenario.id); }}><span className="gwt-scenario-name">{scenario.label}</span>{nodeData.scenarioStatus ? <span className="gwt-scenario-status">{` · ${nodeData.scenarioStatus[scenario.id] ?? "unchanged"}`}</span> : null}</button>
        ))}
      </div>
      <div className="gwt-more nodrag nopan nowheel">
        {scenarios.length > 3 ? <button type="button" onClick={(event) => { event.stopPropagation(); actions.list(nodeData.projectNode.id); }}>+{scenarios.length - 3} more</button> : null}
      </div>
    </div>
  );
}

function ActorChips({ node }: { node: ProjectNode }) {
  const actors = screenActors(node);
  if (actors.length === 0) return null;
  return <div className="chips actor-chips nodrag nopan nowheel" aria-label="Actors">
    {actors.map((actor) => <span className="actor-chip" data-actor-id={actor.id} key={actor.id} title={actor.name + " (" + actor.id + ")"} style={{ borderColor: actor.color }}>
      <i className="actor-swatch" aria-hidden="true" style={{ backgroundColor: actor.color }} />
      <span className="actor-name">{actor.name}</span>
    </span>)}
  </div>;
}

function EventModelNode({ data }: NodeProps) {
  const nodeData = data as CustomNodeData;
  const node = nodeData.projectNode;
  const diffBadge = nodeData.diffStatus && nodeData.diffStatus !== "unchanged" ? <div className={`diff-badge diff-badge-${nodeData.diffStatus}`}>{nodeData.diffStatus}</div> : null;
  if (node.type === "gwt") return <GwtSummary nodeData={nodeData} />;

  return (
    <div className={`em-node em-node-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.connected ? "connected" : ""} ${nodeData.diffStatus ? `diff-node-${nodeData.diffStatus}` : ""}`}>
      <NodeHandles />
      {diffBadge}
      <div className="node-type">{node.type}</div>
      <div className="node-label">{node.label}</div>
      <ActorChips node={node} />
    </div>
  );
}

function GroupNode({ data }: NodeProps) {
  const nodeData = data as CustomNodeData;
  const node = nodeData.projectNode;
  return (
    <div className={`group-node group-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.diffStatus ? `diff-node-${nodeData.diffStatus}` : ""}`}>
      {nodeData.diffStatus && nodeData.diffStatus !== "unchanged" ? <div className={`diff-badge diff-badge-${nodeData.diffStatus}`}>{nodeData.diffStatus}</div> : null}
      <div className="group-title">{node.label}{node.type === "slice" && nodeData.actorRelated ? <span className="actor-related-badge">Related</span> : null}</div>
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

async function createStandaloneHtml(project: EventModelProject, report?: ValidationReport, diff?: GraphDiff, timelineId?: string): Promise<string> {
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
    timelineId,
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
      <p>All stories are shown in diff views so removed items remain accessible.</p>
      {diff.timelinesChanged ? <p role="status">Timeline layout changed. Ordering does not add event dependencies.</p> : null}
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

type InspectorTab = "details" | "agent";

function InspectorTabs({ tab, onTab }: { tab: InspectorTab; onTab: (tab: InspectorTab) => void }) {
  return <div className="inspector-tabs" role="tablist" aria-label="Inspector">
    {(["details", "agent"] as const).map((name) => <button type="button" key={name}
      id={"inspector-tab-" + name} role="tab" aria-selected={tab === name}
      aria-controls={"inspector-" + name} tabIndex={tab === name ? 0 : -1}
      onClick={() => onTab(name)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "details" : event.key === "End" ? "agent" : name === "details" ? "agent" : "details";
        onTab(next);
        requestAnimationFrame(() => document.getElementById("inspector-tab-" + next)?.focus());
      }}>{name === "details" ? "Details" : "Agent"}</button>)}
  </div>;
}

function SourcePanel({
  project,
  selectedNode: currentNode,
  diff,
  findings,
  selectedFieldName,
  onSelect,
  onSelectField,
  onClearField,
  onPreviewConnection,
  onClearPreview,
  gwtList,
  onGwtList,
  onClose,
  onFocusNode,
  tab,
  onTab,
  agentPanel,
  oldVersionId,
  onVersion
}: {
  project: EventModelProject;
  selectedNode?: ProjectNode;
  diff?: GraphDiff;
  findings: ValidationFinding[];
  selectedFieldName?: string;
  onSelect: (nodeId: string) => void;
  onSelectField: (fieldName: string) => void;
  onClearField: () => void;
  onPreviewConnection: (edgeId: string) => void;
  onClearPreview: () => void;
  gwtList?: ProjectNode[];
  onGwtList: (id: string) => void;
  onClose: () => void;
  onFocusNode: (id: string) => void;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  agentPanel: React.ReactNode;
  oldVersionId?: string;
  onVersion: (nodeId: string | undefined) => void;
}) {
  const previousNode = previousNodeFor(diff, currentNode);
  const selectedNode = currentNode && previousNode && oldVersionId === currentNode?.id ? { ...previousNode, id: currentNode.id } : currentNode;
  const [copied, setCopied] = useState<string>();
  const [nameFilter, setNameFilter] = useState("");
  const listPanel = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const showingList = Boolean(gwtList);
  useLayoutEffect(() => {
    if (showingList && listPanel.current) listPanel.current.scrollTop = listScroll.current;
  }, [showingList, tab]);
  const stopPanelKeys = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape") event.stopPropagation();
  };

  const copyPanelText = useCallback((key: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? undefined : current), 1400);
    });
  }, []);

  const tabs = <InspectorTabs tab={tab} onTab={onTab} />;
  if (tab === "agent") {
    return <aside id="inspector-agent" className="panel panel-right agent-panel" aria-label="Agent" onKeyDown={stopPanelKeys} onKeyUp={stopPanelKeys}>
      {tabs}
      {agentPanel}
    </aside>;
  }

  if (gwtList) {
    const needle = nameFilter.trim().toLowerCase();
    const results = gwtList.filter((scenario) => scenario.label.toLowerCase().includes(needle));
    return <aside ref={listPanel} id="inspector-details" className="panel panel-right gwt-panel" aria-label="GWT scenarios" onKeyDown={stopPanelKeys} onKeyUp={stopPanelKeys} onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop; }}>
      {tabs}
      <button type="button" onClick={onClose}>Close</button>
      <h2>{gwtList[0]?.sliceTitle} · All scenarios ({gwtList.length})</h2>
      <div className="gwt-filter">
        <label htmlFor="gwt-name-filter">Filter by scenario name</label>
        <input id="gwt-name-filter" type="search" value={nameFilter} onChange={(event) => {
          setNameFilter(event.target.value);
          listScroll.current = 0;
          if (listPanel.current) listPanel.current.scrollTop = 0;
        }} />
        <button type="button" disabled={!nameFilter} onClick={() => {
          setNameFilter("");
          listScroll.current = 0;
          if (listPanel.current) listPanel.current.scrollTop = 0;
          listPanel.current?.querySelector("input")?.focus({ preventScroll: true });
        }}>Clear filter</button>
      </div>
      <p role="status">{results.length ? `${results.length} of ${gwtList.length} scenarios` : "No scenarios match this name."}</p>
      <div className="gwt-all-list">{results.map((scenario) => <button type="button" key={scenario.id} aria-current={selectedNode?.id === scenario.id ? "true" : undefined} onClick={() => {
        // Focus can scroll the list before the browser delivers its scroll event.
        listScroll.current = listPanel.current?.scrollTop ?? listScroll.current;
        onSelect(scenario.id);
      }}>{scenario.label}{diff ? ` · ${diff.nodeStatus[scenario.id] ?? "unchanged"}` : ""}</button>)}</div>
    </aside>;
  }

  if (!selectedNode) {
    return (
      <aside id="inspector-details" className="panel panel-right" aria-label="Node details">
        {tabs}
        <h2>Selection</h2>
        <p className="muted">Select a node to inspect source and connections.</p>
      </aside>
    );
  }

  const showingBefore = Boolean(previousNode && oldVersionId === currentNode?.id) || diff?.nodeStatus[selectedNode.id] === "removed";
  const detailsProject = showingBefore ? connectionsBefore(project, diff) : connectionsAfter(project, diff);
  const nodeById = new Map(detailsProject.nodes.map((node) => [node.id, node]));
  const connections = detailsProject.edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    return isBehaviorConnection(edge.kind) && source && target && source.type !== "gwt" && target.type !== "gwt";
  });
  const incoming = connections.filter((edge) => edge.target === selectedNode.id);
  const outgoing = connections.filter((edge) => edge.source === selectedNode.id);
  const fieldNames = parseFieldNames(selectedNode.fields);
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
    <aside id="inspector-details" className={`panel panel-right ${selectedNode.type === "gwt" ? "gwt-panel" : ""}`} aria-label="Node details" onKeyDown={stopPanelKeys} onKeyUp={stopPanelKeys}>
      {tabs}
      {selectedNode.type === "gwt" ? <div className="gwt-panel-actions"><button type="button" onClick={() => onGwtList(selectedNode.id)}>All scenarios</button><button type="button" onClick={onClose}>Close</button></div> : null}
      <div className="panel-heading">
        <h2>{selectedNode.label}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={() => onFocusNode(selectedNode.id)}
          aria-label="Focus selected node"
          title="Focus selected node"
        >
          <span className="target-icon" aria-hidden="true" />
        </button>
      </div>
      {diff && currentNode ? <p>{diff.nodeStatus[currentNode.id]} · {showingBefore ? "Old version" : "New version"}</p> : null}
      {previousNode ? <div className="gwt-panel-actions" role="group" aria-label="Node version"><button type="button" aria-pressed={oldVersionId !== currentNode?.id} onClick={() => onVersion(undefined)}>New version</button><button type="button" aria-pressed={oldVersionId === currentNode?.id} onClick={() => onVersion(currentNode?.id)}>Old version</button></div> : null}
      {selectedNode.type === "gwt" ? <section aria-label="Scenario details">
        {selectedNode.description ? <p>{selectedNode.description}</p> : null}
        <GwtStepList title="Given" items={selectedNode.given} />
        <GwtStepList title="When" items={selectedNode.when} />
        <GwtStepList title="Then" items={selectedNode.then} />
        <p className="muted">YAML below is the source slice, not an individual scenario excerpt.</p>
      </section> : null}
      <div className="meta-row"><span>Type</span><strong>{selectedNode.type}</strong></div>
      <ActorChips node={selectedNode} />
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
            description={selectedNode.type === "gwt" ? "Source YAML for the whole slice" : "Source excerpt for this node"}
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
        {incoming.length === 0 ? <p className="muted">None</p> : incoming.map((edge) => (
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
            <span>{nodeById.get(edge.source)?.label ?? edge.source}</span>
          </button>
        ))}
        <strong>Outgoing</strong>
        {outgoing.length === 0 ? <p className="muted">None</p> : outgoing.map((edge) => (
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
            <span>{nodeById.get(edge.target)?.label ?? edge.target}</span>
          </button>
        ))}
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
      <h3>{selectedNode.type === "gwt" ? "Source slice YAML" : "Source"}</h3>
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
  const [timelineId, setTimelineId] = useState<string | undefined>(() => window.__EMVIZ_EXPORT__?.timelineId);
  const [diffFilter, setDiffFilter] = useState<DiffFilter>("all");
  const [actorFilter, setActorFilter] = useState<ActorFilter>({ actorIds: [], includeUnassigned: false });
  const actorProjectRoot = useRef<string | undefined>(undefined);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "import">("loading");
  const [sourceMode, setSourceMode] = useState<"remote" | "local">("remote");
  const [importError, setImportError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "exporting">("idle");
  const [exportError, setExportError] = useState<string>();
  const [feedbackWorkspace, setFeedbackWorkspace] = useState<FeedbackWorkspace>(() => {
    try {
      return restoreFeedbackWorkspace(sessionStorage.getItem("emviz:feedback-workspace:v1"));
    } catch {
      return emptyFeedbackWorkspace();
    }
  });
  const { drafts, queue } = feedbackWorkspace;
  const [storageWarning, setStorageWarning] = useState<string>();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [oldVersionId, setOldVersionId] = useState<string>();
  const setQueue = useCallback<React.Dispatch<React.SetStateAction<FeedbackQueue>>>((update) => {
    setFeedbackWorkspace((current) => {
      const next = typeof update === "function" ? update(current.queue) : update;
      return next === current.queue ? current : { ...current, queue: next };
    });
  }, []);
  useEffect(() => {
    if (feedbackWorkspace.recoveryWarning) {
      setStorageWarning(feedbackWorkspace.recoveryWarning);
      return;
    }
    try {
      sessionStorage.setItem("emviz:feedback-workspace:v1", serializeFeedbackWorkspace(feedbackWorkspace));
      setStorageWarning(undefined);
    } catch {
      setStorageWarning("Browser storage is unavailable. Your drafts and Queue are kept in this tab, but reloading the page may lose them.");
    }
  }, [feedbackWorkspace]);
  const [selection, setSelection] = useState<NodeSelection>();
  const [gwtListSelection, setGwtListSelection] = useState<NodeSelection>();
  const selectedId = resolveSelection(project, selection)?.id;
  const gwtListId = resolveSelection(project, gwtListSelection)?.id;
  const gwtOpener = useRef<HTMLElement | null>(null);
  const [backStack, setBackStack] = useState<NodeSelection[]>([]);
  const [forwardStack, setForwardStack] = useState<NodeSelection[]>([]);
  const [search, setSearch] = useState("");
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string>();
  const [selectedFieldName, setSelectedFieldName] = useState<string>();
  const [validationOpen, setValidationOpen] = useState(false);
  const { setCenter, fitView } = useReactFlow();
  const [view, setView] = useState<FeedbackView>("current");
  const session = useFeedbackSession(!window.__EMVIZ_EXPORT__ && sourceMode === "remote" && loadState !== "import", view);
  useEffect(() => {
    if (session.snapshot) setQueue((current) => reconcileFeedbackQueue(current, session.snapshot!));
  }, [session.snapshot, setQueue]);
  const appliedSnapshot = useRef<{ key: string; sessionId: string } | undefined>(undefined);
  const snapshotKey = session.snapshot ? JSON.stringify([session.snapshot.sessionId, session.snapshot.revision, view, session.snapshot.feedback.request?.id, session.snapshot.feedback.status]) : undefined;
  const displayedSession: SessionController = {
    ...session,
    connection: sourceMode !== "remote" || window.__EMVIZ_EXPORT__ ? "unavailable" : session.connection === "live" && snapshotKey && appliedSnapshot.current?.key !== snapshotKey ? "checking" : session.connection
  };

  useEffect(() => {
    if (window.__EMVIZ_EXPORT__?.project) {
      setProject(window.__EMVIZ_EXPORT__.project);
      setReport(window.__EMVIZ_EXPORT__.report);
      setDiff(window.__EMVIZ_EXPORT__.diff);
      setLoadState("ready");
      window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
      return;
    }

    if (sourceMode === "local" || session.connection !== "unavailable") return;
    let cancelled = false;
    void Promise.all([
      apiFetch("/api/model").then((res) => res.json()),
      apiFetch("/api/validation").then((res) => res.ok ? res.json() : undefined).catch(() => undefined),
      apiFetch("/api/diff").then((res) => res.ok ? res.json() : undefined).catch(() => undefined)
    ]).then(([model, validation, diffPayload]) => {
      if (cancelled) return;
      if (!model || !Array.isArray(model.nodes) || !Array.isArray(model.edges)) throw new Error("No project server is available.");
      setProject(model);
      setReport(validation);
      setDiff(diffPayload);
      setLoadState("ready");
      window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
    }).catch(() => {
      if (!cancelled) setLoadState("import");
    });
    return () => { cancelled = true; };
  }, [fitView, session.connection, sourceMode]);

  useEffect(() => {
    const snapshot = session.snapshot;
    if (!snapshot || session.snapshotView !== view) return;
    const key = snapshotKey!;
    if (appliedSnapshot.current?.key === key) return;
    const firstSnapshot = !appliedSnapshot.current;
    if (appliedSnapshot.current && appliedSnapshot.current.sessionId !== snapshot.sessionId) {
      setSelection(undefined);
      setGwtListSelection(undefined);
      setActorFilter({ actorIds: [], includeUnassigned: false });
      setBackStack([]);
      setForwardStack([]);
      setSelectedFieldName(undefined);
    }
    appliedSnapshot.current = { key, sessionId: snapshot.sessionId };
    setProject(snapshot.project);
    setReport(snapshot.validation);
    setDiff(snapshot.diff);
    setLoadState("ready");
    setHoveredEdgeId(undefined);
    if (firstSnapshot) window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
  }, [fitView, session.snapshot, session.snapshotView, snapshotKey, view]);

  const availableActors = useMemo(() => project ? actorOptions(project, diff?.previousNodes) : [], [project, diff?.previousNodes]);
  const hasUnassigned = Boolean(project?.nodes.some((node) => node.type === "screen" && !node.actors?.length) ||
    Object.values(diff?.previousNodes ?? {}).some((node) => node.type === "screen" && !node.actors?.length));
  useEffect(() => {
    if (!project) return;
    const newRoot = actorProjectRoot.current !== project.root;
    actorProjectRoot.current = project.root;
    setActorFilter((current) => newRoot ? { actorIds: [], includeUnassigned: false } : pruneActorFilter(project, current, diff?.previousNodes));
  }, [project, diff?.previousNodes]);

  useEffect(() => {
    if (!project) return;
    if (selection && !resolveSelection(project, selection)) setSelection(undefined);
    if (gwtListSelection && !resolveSelection(project, gwtListSelection)) setGwtListSelection(undefined);
    setBackStack((stack) => stack.filter((item) => resolveSelection(project, item)));
    setForwardStack((stack) => stack.filter((item) => resolveSelection(project, item)));
  }, [project, selection, gwtListSelection]);

  const selectedNode = useMemo(() => project?.nodes.find((node) => node.id === selectedId), [project, selectedId]);
  const draftSessionId = session.snapshot?.sessionId;
  const draftKey = draftSessionId && selectedNode ? feedbackDraftKey(draftSessionId, selectedNode) : undefined;
  useEffect(() => setOldVersionId(undefined), [draftKey]);
  const changeDraft = (message: string, expectedMessage?: string) => {
    if (!draftSessionId || !selectedNode) return;
    setFeedbackWorkspace((current) => ({ ...current, drafts: updateFeedbackDraft(current.drafts, draftSessionId, selectedNode, message, expectedMessage) }));
  };
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
      timelineId: diff ? undefined : timelineId,
      focusedEdgeIds,
      edgeFieldFlows: fieldFlows,
      selectedFieldName,
      onSelectField: setSelectedFieldName,
      diffNodeStatus: diff?.nodeStatus,
      diffEdgeStatus: diff?.edgeStatus,
      diffFilter,
      actorFilter,
      previousNodes: diff?.previousNodes
    }) : { nodes: [], edges: [] },
    [timelineId, actorFilter, diff?.previousNodes, diff?.edgeStatus, diff?.nodeStatus, diffFilter, fieldFlows, focusedEdgeIds, project, selectedFieldName, selectedId]
  );
  useEffect(() => {
    if (timelineId && project && !project.timelines?.some((item) => item.id === timelineId)) setTimelineId(undefined);
  }, [project, timelineId]);
  useEffect(() => {
    if (!timelineId || diff) return;
    const present = new Set(flow.nodes.map((node) => node.id));
    if (selectedId && !present.has(selectedId)) setSelection(undefined);
    if (gwtListId && !present.has(gwtListId)) setGwtListSelection(undefined);
  }, [flow.nodes, timelineId, selectedId, gwtListId, diff]);
  const searchResults = useMemo(() => {
    if (!project || search.trim().length < 2) return [];
    const needle = search.trim().toLowerCase();
    const present = new Set(flow.nodes.map((node) => node.id));
    return project.nodes.filter((node) => present.has(node.id) && `${node.label} ${node.type} ${node.sourcePath ?? ""}`.toLowerCase().includes(needle)).slice(0, 8);
  }, [project, search, flow.nodes]);

  const focusNode = useCallback((nodeId: string, recordHistory = true, moveToNode = false) => {
    let node = flow.nodes.find((candidate) => candidate.id === nodeId);
    const leaveTimeline = Boolean(!node && timelineId && project?.nodes.some((candidate) => candidate.id === nodeId));
    if (leaveTimeline && project) {
      setTimelineId(undefined);
      node = toFlow(project).nodes.find((candidate) => candidate.id === nodeId);
    }
    setHoveredEdgeId(undefined);
    if (recordHistory && selectedId && selectedId !== nodeId) {
      if (selection) setBackStack((stack) => [...stack, selection]);
      setForwardStack([]);
    }
    const isGwt = node?.data.projectNode.type === "gwt";
    if (isGwt && !gwtOpener.current) {
      const active = document.activeElement;
      gwtOpener.current = active?.closest(".search-results") ? document.querySelector<HTMLInputElement>(".search-box input") : active instanceof HTMLElement ? active : null;
    }
    if (!isGwt) gwtOpener.current = null;
    setGwtListSelection(undefined);
    if (project) setSelection(selectionForNode(project, nodeId));
    if (node && (!isGwt || moveToNode)) {
      const center = { x: node.position.x + 80, y: node.position.y + 60 };
      if (leaveTimeline) window.setTimeout(() => void setCenter(center.x, center.y, { zoom: 1.2, duration: 350 }), 50);
      else void setCenter(center.x, center.y, { zoom: 1.2, duration: 350 });
    }
  }, [flow.nodes, project, selection, selectedId, setCenter, timelineId]);

  const clearFocus = useCallback(() => {
    setSelection(undefined);
    setHoveredEdgeId(undefined);
    setSelectedFieldName(undefined);
    setGwtListSelection(undefined);
    const opener = gwtOpener.current;
    gwtOpener.current = null;
    if (!opener) return;
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>(".canvas")?.focus({ preventScroll: true });
    });
  }, []);

  const showGwtList = useCallback((id: string) => {
    if (!gwtOpener.current) gwtOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (project) setGwtListSelection(selectionForNode(project, id));
  }, [project]);
  const gwtActions = useMemo(() => ({ open: focusNode, list: showGwtList }), [focusNode, showGwtList]);
  const gwtListNode = project?.nodes.find((node) => node.id === gwtListId);
  const gwtList = gwtListNode ? project?.nodes.filter((node) => node.type === "gwt" && (gwtListNode.sourcePath ? node.sourcePath === gwtListNode.sourcePath : node.sliceTitle === gwtListNode.sliceTitle)).filter((node) => !diff || diffFilter === "all" || diff.nodeStatus[node.id] === diffFilter) : undefined;
  useEffect(() => {
    if (gwtListId || selectedNode?.type === "gwt") {
      const selectedResult = gwtListId ? document.querySelector<HTMLElement>(".gwt-all-list button[aria-current]") : null;
      (selectedResult ?? document.querySelector<HTMLElement>('.gwt-panel button:not([role="tab"])'))?.focus({ preventScroll: true });
    }
  }, [gwtListId, selectedNode?.id, selectedNode?.type]);

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
    void createStandaloneHtml(project, report, diff, timelineId)
      .then((html) => {
        downloadTextFile(`${modelFileBaseName(project)}.emviz.html`, html);
      })
      .catch((error) => {
        setExportError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setExportState("idle"));
  }, [diff, project, report, timelineId]);

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
    if (selection) setForwardStack((stack) => [...stack, selection]);
    const node = resolveSelection(project, previous);
    if (node) focusNode(node.id, false);
  }, [backStack, focusNode, project, selection]);

  const goForward = useCallback(() => {
    const next = forwardStack.at(-1);
    if (!next) return;
    setForwardStack((stack) => stack.slice(0, -1));
    if (selection) setBackStack((stack) => [...stack, selection]);
    const node = resolveSelection(project, next);
    if (node) focusNode(node.id, false);
  }, [focusNode, forwardStack, project, selection]);

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
      setTimelineId(undefined);
      setSourceMode("local");
      setProject(importedProject);
      const baseReport = validateImportedProject(parserProject);
      const extraFindings = sidecarFindings(importedProject);
      setReport({
        errors: baseReport.errors,
        warnings: baseReport.warnings + extraFindings.filter((finding) => finding.severity === "warning").length,
        findings: [...baseReport.findings, ...extraFindings]
      });
      setDiff(undefined);
      setGwtListSelection(undefined);
      setDiffFilter("all");
      setActorFilter({ actorIds: [], includeUnassigned: false });
      setSelection(undefined);
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
    return <div className="loading"><div>{session.error ? <><p role="alert">{session.error}</p><button type="button" onClick={session.refresh}>Retry connection</button></> : "Loading event model..."}</div></div>;
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
        {Boolean(project.timelines?.length) ? <label className="timeline-picker">
          <span>Timeline</span>
          <select aria-label="Timeline" disabled={Boolean(diff)} title={diff ? "Diff shows all stories, including removed items." : undefined} value={diff ? "" : timelineId ?? ""} onChange={(event) => {
            setTimelineId(event.target.value || undefined);
            setSelection(undefined);
            setGwtListSelection(undefined);
            setBackStack([]);
            setForwardStack([]);
            setHoveredEdgeId(undefined);
            setSelectedFieldName(undefined);
            window.setTimeout(() => void fitView({ padding: 0.18, duration: 300 }), 50);
          }}>
            <option value="">All stories</option>
            {project.timelines?.map((timeline) => <option key={timeline.id} value={timeline.id}>{timeline.name} · {timeline.path}</option>)}
          </select>
        </label> : null}
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
        <details className="actor-filter" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}>
          <summary>Actors · {actorFilter.actorIds.length + Number(actorFilter.includeUnassigned) || "All"}</summary>
          <div className="actor-filter-popover">
            <p>Match any selected actor. Related system steps stay visible.</p>
            <div className="actor-filter-options" role="group" aria-label="Filter by actor">
              {availableActors.map((actor) => <label key={actor.id}>
                <input type="checkbox" aria-label={actor.name === actor.id ? actor.name : actor.name + " (" + actor.id + ")"} checked={actorFilter.actorIds.includes(actor.id)} onChange={(event) => {
                  const checked = event.target.checked;
                  setActorFilter((current) => ({ ...current, actorIds: checked ? [...current.actorIds, actor.id] : current.actorIds.filter((id) => id !== actor.id) }));
                }} />
                <i className="actor-swatch" aria-hidden="true" style={{ backgroundColor: actor.color }} />
                <span>{actor.name}{actor.name !== actor.id ? <small>{actor.id}</small> : null}</span>
              </label>)}
              {hasUnassigned ? <label><input type="checkbox" aria-label="Unassigned screens" checked={actorFilter.includeUnassigned} onChange={(event) => {
                const checked = event.target.checked;
                setActorFilter((current) => ({ ...current, includeUnassigned: checked }));
              }} /><span>Unassigned screens</span></label> : null}
            </div>
            <button type="button" disabled={actorFilter.actorIds.length === 0 && !actorFilter.includeUnassigned} onClick={() => setActorFilter({ actorIds: [], includeUnassigned: false })}>Clear actors</button>
          </div>
        </details>
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
        key={(gwtListNode ?? selectedNode)?.type === "gwt" ? `gwt:${(gwtListNode ?? selectedNode)?.sourcePath ?? (gwtListNode ?? selectedNode)?.sliceTitle}` : "selection"}
        diff={diff}
        tab={inspectorTab}
        onTab={setInspectorTab}
        oldVersionId={oldVersionId}
        onVersion={setOldVersionId}
        agentPanel={<>
          {storageWarning ? <div className="feedback-storage-warning"><p className="feedback-warning" role="alert">{storageWarning}</p>
            {feedbackWorkspace.recoveryWarning ? <button type="button" onClick={() => setFeedbackWorkspace((current) => ({ ...current, recoveryWarning: undefined }))}>Replace damaged saved feedback</button> : null}
          </div> : null}
          <AgentPanel session={displayedSession} drafts={Object.values(drafts)} view={view}
            onView={(next) => { setView(next); setDiffFilter("all"); }}
            node={selectedNode} diff={diff}
            showingBefore={Boolean(previousNodeFor(diff, selectedNode) && oldVersionId === selectedNode?.id) || Boolean(selectedNode && diff?.nodeStatus[selectedNode.id] === "removed")}
            message={draftKey ? drafts[draftKey]?.message ?? "" : ""}
            onMessageChange={changeDraft}
            onAdded={(message) => changeDraft("", message)}
            queue={queue} onQueueChange={setQueue} storageNeedsReview={Boolean(feedbackWorkspace.recoveryWarning)} />
        </>}
        gwtList={gwtList}
        onGwtList={showGwtList}
        onClose={clearFocus}
        onFocusNode={(id) => focusNode(id, true, true)}
        project={project}
        selectedNode={selectedNode}
        findings={selectedFindings}
        selectedFieldName={selectedFieldName}
        onSelect={focusNode}
        onSelectField={setSelectedFieldName}
        onClearField={() => setSelectedFieldName(undefined)}
        onPreviewConnection={previewConnection}
        onClearPreview={clearPreviewConnection}
      />
      <main className="canvas" tabIndex={-1} aria-label="Event model diagram">
        {(actorFilter.actorIds.length > 0 || actorFilter.includeUnassigned) && !flow.nodes.some((node) => !node.hidden && node.data.projectNode.type !== "story" && node.data.projectNode.type !== "slice") ? <div className="actor-empty" role="status">No screens match the selected actors and current filters.</div> : null}
        <GwtActions.Provider value={gwtActions}>
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
        </GwtActions.Provider>
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
