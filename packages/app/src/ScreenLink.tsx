import { safeScreenUrl } from "@emviz/parser/browser";
import type { ProjectNode } from "./types";

export function ScreenLink({ node, compact = false }: { node: ProjectNode; compact?: boolean }) {
  if (node.type !== "screen" || node.screenType === "system") return null;
  const url = safeScreenUrl(node.url);
  if (!url) return null;
  return <a className={compact ? "screen-link screen-link-compact nodrag nopan" : "screen-link screen-link-details"}
    href={url} target="_blank" rel="noopener noreferrer" data-canvas-navigation-ignore
    aria-label={`Open reference for ${node.label} in a new tab`} title={`Open reference in new tab: ${url}`}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M11 3h6v6M17 3l-9 9M8 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4" />
    </svg>
    {compact ? null : <span>Open reference · {new URL(url).hostname}</span>}
  </a>;
}
