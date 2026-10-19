import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  normalizeWheelDelta,
  panCanvasViewport,
  wheelCanvasViewport,
  zoomCanvasViewport,
  type CanvasWheel
} from "./canvasViewport";

const viewport = { x: 100, y: 200, zoom: 0.8 };
const size = { width: 900, height: 600 };
const anchor = { x: 350, y: 240 };
const wheel = (overrides: Partial<CanvasWheel> = {}): CanvasWheel => ({
  deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...overrides
});

describe("canvas wheel navigation", () => {
  it("pans vertically without changing zoom", () => {
    expect(wheelCanvasViewport(viewport, wheel({ deltaY: 60 }), size, anchor)).toEqual({ x: 100, y: 140, zoom: 0.8 });
  });

  it("keeps both trackpad axes, including fractional deltas", () => {
    expect(wheelCanvasViewport(viewport, wheel({ deltaX: 12.5, deltaY: -4.25 }), size, anchor))
      .toEqual({ x: 87.5, y: 204.25, zoom: 0.8 });
  });

  it("turns vertical Shift+wheel into horizontal pan", () => {
    expect(wheelCanvasViewport(viewport, wheel({ deltaY: 60, shiftKey: true }), size, anchor))
      .toEqual({ x: 40, y: 200, zoom: 0.8 });
  });

  it("does not convert already-horizontal Shift events twice", () => {
    expect(wheelCanvasViewport(viewport, wheel({ deltaX: -30, shiftKey: true }), size, anchor))
      .toEqual({ x: 130, y: 200, zoom: 0.8 });
    expect(wheelCanvasViewport(viewport, wheel({ deltaX: 15, deltaY: 30, shiftKey: true }), size, anchor))
      .toEqual({ x: 85, y: 200, zoom: 0.8 });
  });

  it("normalizes line and page modes", () => {
    expect(normalizeWheelDelta(wheel({ deltaX: 2, deltaY: 3, deltaMode: 1 }), size)).toEqual({ x: 32, y: 48 });
    expect(normalizeWheelDelta(wheel({ deltaX: 1, deltaY: -1, deltaMode: 2 }), size)).toEqual({ x: 900, y: -600 });
  });

  for (const modifier of ["metaKey", "ctrlKey"] as const) {
    it(`zooms at the cursor for ${modifier}, including Ctrl-wheel pinch`, () => {
      const next = wheelCanvasViewport(viewport, wheel({ deltaY: -100, [modifier]: true }), size, anchor);
      expect(next.zoom).toBeGreaterThan(viewport.zoom);
      expect((anchor.x - next.x) / next.zoom).toBeCloseTo((anchor.x - viewport.x) / viewport.zoom, 12);
      expect((anchor.y - next.y) / next.zoom).toBeCloseTo((anchor.y - viewport.y) / viewport.zoom, 12);
    });
  }

  it("gives zoom modifiers priority over Shift pan", () => {
    const next = wheelCanvasViewport(viewport, wheel({ deltaY: 40, shiftKey: true, metaKey: true }), size, anchor);
    expect(next.zoom).toBeLessThan(viewport.zoom);
  });

  it("honors the same zoom limits for wheel and native gesture input", () => {
    const large = wheelCanvasViewport(viewport, wheel({ deltaY: -1e9, ctrlKey: true }), size, anchor);
    const small = wheelCanvasViewport(viewport, wheel({ deltaY: 1e9, metaKey: true }), size, anchor);
    expect(large.zoom).toBe(CANVAS_MAX_ZOOM);
    expect(small.zoom).toBe(CANVAS_MIN_ZOOM);
    expect(zoomCanvasViewport(viewport, anchor, Infinity).zoom).toBe(CANVAS_MAX_ZOOM);
    expect(zoomCanvasViewport(viewport, anchor, 0).zoom).toBe(CANVAS_MIN_ZOOM);
  });

  it("does not drift when continuing to zoom at a limit", () => {
    const maximum = { ...viewport, zoom: CANVAS_MAX_ZOOM };
    const minimum = { ...viewport, zoom: CANVAS_MIN_ZOOM };
    expect(wheelCanvasViewport(maximum, wheel({ deltaY: -100, ctrlKey: true }), size, anchor)).toEqual(maximum);
    expect(wheelCanvasViewport(minimum, wheel({ deltaY: 100, metaKey: true }), size, anchor)).toEqual(minimum);
  });

  it("ignores nonfinite wheel deltas and invalid native gesture zoom", () => {
    expect(wheelCanvasViewport(viewport, wheel({ deltaY: NaN }), size, anchor)).toBe(viewport);
    expect(wheelCanvasViewport(viewport, wheel({ deltaX: Infinity }), size, anchor)).toBe(viewport);
    expect(zoomCanvasViewport(viewport, anchor, NaN)).toBe(viewport);
  });

  it("leaves a zero-delta event unchanged", () => {
    expect(wheelCanvasViewport(viewport, wheel(), size, anchor)).toEqual(viewport);
    expect(wheelCanvasViewport(viewport, wheel({ ctrlKey: true }), size, anchor)).toEqual(viewport);
  });
});

describe("space drag and cursor anchoring", () => {
  it("pans by screen pixels at every zoom without mutating input", () => {
    for (const zoom of [CANVAS_MIN_ZOOM, 1, CANVAS_MAX_ZOOM]) {
      const initial = { ...viewport, zoom };
      expect(panCanvasViewport(initial, { x: 45, y: -18 })).toEqual({ x: 145, y: 182, zoom });
      expect(initial).toEqual({ ...viewport, zoom });
    }
  });

  it("keeps an offset canvas anchor stable at native gesture scale", () => {
    const next = zoomCanvasViewport(viewport, anchor, 1.4);
    expect((anchor.x - next.x) / next.zoom).toBeCloseTo((anchor.x - viewport.x) / viewport.zoom, 12);
    expect((anchor.y - next.y) / next.zoom).toBeCloseTo((anchor.y - viewport.y) / viewport.zoom, 12);
  });
});
