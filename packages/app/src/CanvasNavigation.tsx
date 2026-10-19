import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReactFlow } from "@xyflow/react";
import { panCanvasViewport, wheelCanvasViewport, zoomCanvasViewport } from "./canvasViewport";

type NavigationMode = "idle" | "ready" | "dragging";
type Drag = { pointerId: number; x: number; y: number };
type Gesture = Event & { scale?: number; clientX?: number; clientY?: number };

function elementTarget(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function editableTarget(target: EventTarget | null): boolean {
  const element = elementTarget(target);
  return Boolean(element?.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])'));
}

function canvasControl(target: EventTarget | null): boolean {
  return Boolean(elementTarget(target)?.closest(".react-flow__controls, .react-flow__panel, [data-canvas-navigation-ignore]"));
}

function keyboardControl(target: EventTarget | null): boolean {
  const control = elementTarget(target)?.closest('button, a[href], summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]');
  return editableTarget(target) || Boolean(control && !control.classList.contains("react-flow__node"));
}

function isSpace(event: KeyboardEvent): boolean {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

export function CanvasNavigation({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<NavigationMode>("idle");
  const { getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let spacePressed = false;
    let drag: Drag | null = null;
    let suppressClick = false;
    let gestureStartZoom: number | null = null;

    const stopDrag = () => {
      const pointerId = drag?.pointerId;
      drag = null;
      if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      setMode(spacePressed ? "ready" : "idle");
    };
    const reset = () => {
      spacePressed = false;
      gestureStartZoom = null;
      stopDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        reset();
        return;
      }
      if (!isSpace(event) || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || keyboardControl(event.target)) return;
      const target = elementTarget(event.target);
      if (target && target !== document.body && target !== document.documentElement && !canvas.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      spacePressed = true;
      if (!drag) setMode("ready");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isSpace(event)) return;
      if (spacePressed) event.preventDefault();
      reset();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!canvas.contains(elementTarget(event.target)) || keyboardControl(event.target)) reset();
    };
    const onVisibility = () => { if (document.hidden) reset(); };
    const onPointerDown = (event: PointerEvent) => {
      if (!drag) suppressClick = false;
      if (!spacePressed || drag || event.button !== 0 || event.isPrimary === false || event.pointerType === "touch" || editableTarget(event.target) || canvasControl(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      suppressClick = true;
      setMode("dragging");
      // Window listeners still end the gesture if capture is unavailable or lost.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* Detached/synthetic pointers cannot be captured. */ }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if ((event.buttons & 1) === 0) { stopDrag(); return; }
      const delta = { x: event.clientX - drag.x, y: event.clientY - drag.y };
      drag.x = event.clientX;
      drag.y = event.clientY;
      void setViewport(panCanvasViewport(getViewport(), delta));
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stopDrag();
    };
    const onLostCapture = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) stopDrag();
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onWheel = (event: WheelEvent) => {
      if (editableTarget(event.target) || canvasControl(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Safari may emit wheel events during its separate native gesture sequence.
      if (gestureStartZoom !== null) return;
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      void setViewport(wheelCanvasViewport(getViewport(), event, rect, anchor));
    };
    const onGestureStart = (event: Event) => {
      if (editableTarget(event.target) || canvasControl(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      gestureStartZoom = getViewport().zoom;
    };
    const onGestureChange = (event: Event) => {
      if (gestureStartZoom === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const gesture = event as Gesture;
      if (!Number.isFinite(gesture.scale) || !gesture.scale || gesture.scale <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const anchor = {
        x: typeof gesture.clientX === "number" ? gesture.clientX - rect.left : rect.width / 2,
        y: typeof gesture.clientY === "number" ? gesture.clientY - rect.top : rect.height / 2
      };
      void setViewport(zoomCanvasViewport(getViewport(), anchor, gestureStartZoom * gesture.scale));
    };
    const onGestureEnd = (event: Event) => {
      if (gestureStartZoom === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      gestureStartZoom = null;
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    window.addEventListener("focusin", onFocusIn);
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    canvas.addEventListener("lostpointercapture", onLostCapture);
    canvas.addEventListener("click", onClick, true);
    canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });
    canvas.addEventListener("gesturestart", onGestureStart, { capture: true, passive: false });
    canvas.addEventListener("gesturechange", onGestureChange, { capture: true, passive: false });
    canvas.addEventListener("gestureend", onGestureEnd, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      canvas.removeEventListener("lostpointercapture", onLostCapture);
      canvas.removeEventListener("click", onClick, true);
      canvas.removeEventListener("wheel", onWheel, true);
      canvas.removeEventListener("gesturestart", onGestureStart, true);
      canvas.removeEventListener("gesturechange", onGestureChange, true);
      canvas.removeEventListener("gestureend", onGestureEnd, true);
      const pointerId = drag?.pointerId;
      drag = null;
      if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    };
  }, [getViewport, setViewport]);

  return (
    <main ref={canvasRef} className="canvas" tabIndex={-1} aria-label="Event model diagram" aria-description="Hold Space and drag to pan. Scroll to pan, Shift scroll to pan horizontally, Command on Mac or Control on Windows and Linux with scroll to zoom. Pinch to zoom." data-navigation-mode={mode}>
      {children}
      <div className="canvas-navigation-help" aria-hidden="true">Space + drag to pan · Scroll to pan · Shift to pan sideways · ⌘/Ctrl + scroll to zoom</div>
    </main>
  );
}
