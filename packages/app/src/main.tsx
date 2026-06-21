import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BaseEdge,
  Controls,
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
import { toFlow } from "./layout";
import type { EventModelProject, ProjectNode, ValidationFinding, ValidationReport } from "./types";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "@emviz/parser/browser";
import { validateEventModelProject as validateImportedProject } from "@emviz/validator/browser";

type CustomNodeData = {
  projectNode: ProjectNode;
  selected: boolean;
  connected: boolean;
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
  if (node.type === "gwt") {
    return (
      <div className={`em-node em-node-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.connected ? "connected" : ""}`}>
        <NodeHandles />
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
    <div className={`em-node em-node-${node.type} ${nodeData.selected ? "selected" : ""} ${nodeData.connected ? "connected" : ""}`}>
      <NodeHandles />
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
    <div className={`group-node group-${node.type} ${nodeData.selected ? "selected" : ""}`}>
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
  const stroke = route?.active ? "#111827" : "#64748b";
  return (
    <BaseEdge
      path={eventModelPath(props)}
      markerEnd={props.markerEnd}
      style={{ ...props.style, stroke }}
      className={route?.active ? "edge-path-active" : "edge-path"}
    />
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

function SourcePanel({
  project,
  selectedNode,
  findings,
  onSelect,
  onPreviewConnection,
  onClearPreview
}: {
  project: EventModelProject;
  selectedNode?: ProjectNode;
  findings: ValidationFinding[];
  onSelect: (nodeId: string) => void;
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
      <h2>{selectedNode.label}</h2>
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
            {nodeById.get(edge.source)?.label ?? edge.source}
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
            {nodeById.get(edge.target)?.label ?? edge.target}
          </button>
        ))}
      </div>
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
  onSelect
}: {
  report?: ValidationReport;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <aside className="panel panel-left">
      <h2>Validation</h2>
      {!report ? <p className="muted">Loading validation...</p> : (
        <>
          <div className="status-row">
            <span className="status error">{report.errors} errors</span>
            <span className="status warning">{report.warnings} warnings</span>
          </div>
          <div className="findings-list">
            {report.findings.length === 0 ? <p className="muted">No validation findings.</p> : report.findings.map((finding) => (
              <button type="button" className={`finding finding-${finding.severity}`} key={finding.id} onClick={() => finding.nodeId && onSelect(finding.nodeId)}>
                <strong>{finding.check}</strong>
                <span>{finding.message}</span>
                {finding.path ? <code>{finding.path}</code> : null}
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function FlowWorkspace() {
  const [project, setProject] = useState<EventModelProject>();
  const [report, setReport] = useState<ValidationReport>();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "import">("loading");
  const [importError, setImportError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string>();
  const { setCenter, fitView } = useReactFlow();

  useEffect(() => {
    void Promise.all([
      fetch("/api/model").then((res) => res.json()),
      fetch("/api/validation").then((res) => res.json())
    ]).then(([model, validation]) => {
      setProject(model);
      setReport(validation);
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
  const focusedEdgeIds = useMemo(() => {
    if (hoveredEdgeId) return new Set([hoveredEdgeId]);
    if (!project || !selectedId) return undefined;
    return new Set(project.edges.filter((edge) => isBehaviorConnection(edge.kind) && (edge.source === selectedId || edge.target === selectedId)).map((edge) => edge.id));
  }, [hoveredEdgeId, project, selectedId]);
  const flow = useMemo(
    () => project ? toFlow(project, selectedId, { focusedEdgeIds }) : { nodes: [], edges: [] },
    [focusedEdgeIds, project, selectedId]
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
      setSelectedId(undefined);
      setHoveredEdgeId(undefined);
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
    <div className="app-shell">
      <header className="toolbar">
        <div className="model-summary">
          <strong>emviz</strong>
          <span>{project.stories.length} stories</span>
          <span>{project.slices.length} slices</span>
          <span>{project.nodes.filter((node) => node.type === "event").length} events</span>
        </div>
        <div className="segmented toolbar-history" aria-label="Selection history">
          <button type="button" disabled={backStack.length === 0} onClick={goBack}>Back</button>
          <button type="button" disabled={forwardStack.length === 0} onClick={goForward}>Forward</button>
        </div>
        <div className="search-box">
          <input aria-label="Search event model" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search nodes by name or type..." />
          {searchResults.length > 0 ? (
            <div className="search-results">
              {searchResults.map((node) => (
                <button type="button" key={node.id} onClick={() => focusNode(node.id)}>
                  <span>{node.label}</span>
                  <small>{node.type}</small>
                </button>
              ))}
            </div>
          ) : null}
          </div>
      </header>
      <ValidationPanel report={report} onSelect={focusNode} />
      <SourcePanel
        project={project}
        selectedNode={selectedNode}
        findings={selectedFindings}
        onSelect={focusNode}
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
