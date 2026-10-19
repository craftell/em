export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasPoint = { x: number; y: number };
export type CanvasSize = { width: number; height: number };
export type CanvasWheel = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export const CANVAS_MIN_ZOOM = 0.2;
export const CANVAS_MAX_ZOOM = 1.8;
const LINE_HEIGHT = 16;
const ZOOM_SPEED = 0.0025;

export function normalizeWheelDelta(wheel: CanvasWheel, size: CanvasSize): CanvasPoint {
  const xUnit = wheel.deltaMode === 1 ? LINE_HEIGHT : wheel.deltaMode === 2 ? size.width : 1;
  const yUnit = wheel.deltaMode === 1 ? LINE_HEIGHT : wheel.deltaMode === 2 ? size.height : 1;
  return { x: wheel.deltaX * xUnit, y: wheel.deltaY * yUnit };
}

// Viewport translations are screen pixels, so panning must not be divided by zoom.
export function panCanvasViewport(viewport: CanvasViewport, delta: CanvasPoint): CanvasViewport {
  return { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y };
}

export function zoomCanvasViewport(viewport: CanvasViewport, anchor: CanvasPoint, requestedZoom: number): CanvasViewport {
  if (Number.isNaN(requestedZoom) || viewport.zoom <= 0) return viewport;
  const zoom = Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, requestedZoom));
  const ratio = zoom / viewport.zoom;
  return {
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio,
    zoom
  };
}

export function wheelCanvasViewport(viewport: CanvasViewport, wheel: CanvasWheel, size: CanvasSize, anchor: CanvasPoint): CanvasViewport {
  const delta = normalizeWheelDelta(wheel, size);
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return viewport;
  // Browsers also encode trackpad pinch as Ctrl+wheel on macOS.
  if (wheel.metaKey || wheel.ctrlKey) {
    const amount = Math.max(-1000, Math.min(1000, delta.y || delta.x));
    return zoomCanvasViewport(viewport, anchor, viewport.zoom * Math.exp(-amount * ZOOM_SPEED));
  }
  // Some browsers already convert Shift+wheel to deltaX; don't convert it twice.
  const x = wheel.shiftKey ? delta.x || delta.y : delta.x;
  const y = wheel.shiftKey ? 0 : delta.y;
  return panCanvasViewport(viewport, { x: -x, y: -y });
}
