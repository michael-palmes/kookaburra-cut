import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StagePointerEvent, StageRole } from "../engine/stageProtocol";
import type { FrameRect } from "../toolkit/frame/frameLayout";
import { StageClient } from "./stageClient";

/** The stage as a window mounts it: one canvas the stage worker draws into, sized by its container, with pointer events forwarded to the worker's raycaster and the cursor the worker asks for. Replaces the editor's `<Canvas>`; the chrome around it is untouched. The canvas element is made inside the mount effect, since a canvas whose control was transferred cannot be transferred again (StrictMode mounts twice, and a Retry needs a fresh one). */
export function StageView({
  stageRole,
  attempt = 0,
  frameloop = "demand",
  dpr,
  cutout = null,
  className,
  style,
  onClient,
}: {
  stageRole: StageRole;
  /** Bumped by a host's Retry: the worker is terminated and a fresh canvas and worker take its place, with a fresh ready window. */
  attempt?: number;
  frameloop?: "demand" | "never";
  /** The preview pixel ratio, clamped to the device's. */
  dpr: number | [number, number];
  cutout?: FrameRect | null;
  className?: string;
  style?: CSSProperties;
  onClient?: (client: StageClient | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<StageClient | null>(null);
  const [cursor, setCursor] = useState("");
  const dprRef = useRef(dpr);
  const frameloopRef = useRef(frameloop);
  const onClientRef = useRef(onClient);
  onClientRef.current = onClient;

  useLayoutEffect(() => {
    // A new attempt rebuilds the canvas and worker with otherwise-identical inputs.
    void attempt;
    const host = container.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(canvas);
    const size = measure(canvas, dprRef.current);
    const next = new StageClient(canvas, stageRole, size, frameloopRef.current, {
      onCursor: setCursor,
    });
    setClient(next);
    onClientRef.current?.(next);
    const observer = new ResizeObserver(() => {
      void next.configure(measure(canvas, dprRef.current), frameloopRef.current);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      onClientRef.current?.(null);
      next.dispose();
      canvas.remove();
      setClient(null);
    };
  }, [stageRole, attempt]);

  useEffect(() => {
    dprRef.current = dpr;
    frameloopRef.current = frameloop;
    if (client) void client.configure(measure(client.element, dpr), frameloop);
  }, [client, dpr, frameloop]);

  useEffect(() => {
    client?.setCutout(cutout);
  }, [client, cutout]);

  useEffect(() => {
    if (client) client.element.style.cursor = cursor;
  }, [client, cursor]);

  useEffect(() => {
    if (!client) return;
    const canvas = client.element;
    const forward =
      (kind: StagePointerEvent["kind"]) => (e: PointerEvent | MouseEvent | WheelEvent) => {
        const rect = canvas.getBoundingClientRect();
        client.pointer({
          kind,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          button: e.button,
          buttons: e.buttons,
          pointerId: "pointerId" in e ? e.pointerId : 1,
          pointerType: "pointerType" in e ? e.pointerType : "mouse",
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          ...(e instanceof WheelEvent ? { deltaX: e.deltaX, deltaY: e.deltaY } : {}),
        });
      };
    // A press on the canvas starts a drag the window follows wherever the pointer goes, as the document did for a real canvas; moves, ups and cancels are forwarded once each, from the window.
    const pressed = new Set<number>();
    const down = forward("pointerdown");
    const onDown = (e: PointerEvent) => {
      pressed.add(e.pointerId);
      down(e);
    };
    const entries: [keyof HTMLElementEventMap, (e: never) => void][] = [
      ["pointerdown", onDown],
      ["pointerleave", forward("pointerleave")],
      ["click", forward("click")],
      ["dblclick", forward("dblclick")],
      ["contextmenu", forward("contextmenu")],
      ["wheel", forward("wheel")],
    ];
    for (const [name, fn] of entries) {
      canvas.addEventListener(name, fn as EventListener, { passive: true });
    }
    const tracked = (kind: "pointermove" | "pointerup" | "pointercancel") => {
      const send = forward(kind);
      return (e: PointerEvent) => {
        const dragging = pressed.has(e.pointerId);
        if (!dragging && e.target !== canvas) return;
        if (kind !== "pointermove") pressed.delete(e.pointerId);
        send(e);
      };
    };
    const windowEntries: [keyof WindowEventMap, (e: PointerEvent) => void][] = [
      ["pointermove", tracked("pointermove")],
      ["pointerup", tracked("pointerup")],
      ["pointercancel", tracked("pointercancel")],
    ];
    for (const [name, fn] of windowEntries) {
      window.addEventListener(name, fn as EventListener, { passive: true });
    }
    return () => {
      for (const [name, fn] of entries) canvas.removeEventListener(name, fn as EventListener);
      for (const [name, fn] of windowEntries) window.removeEventListener(name, fn as EventListener);
    };
  }, [client]);

  return (
    <div
      ref={container}
      className={className}
      style={{ position: "absolute", inset: 0, ...style }}
    />
  );
}

function measure(canvas: HTMLCanvasElement, dpr: number | [number, number]) {
  const rect = canvas.getBoundingClientRect();
  const device = window.devicePixelRatio || 1;
  const ratio = Array.isArray(dpr) ? Math.min(dpr[1], Math.max(dpr[0], device)) : dpr;
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: ratio };
}
