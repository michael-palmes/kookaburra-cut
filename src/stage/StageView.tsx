import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StagePointerEvent, StageRole } from "../engine/stageProtocol";
import type { FrameRect } from "../toolkit/frame/frameLayout";
import { StageClient } from "./stageClient";

/** The stage as a window mounts it: one canvas the stage worker draws into, sized by its container, with pointer events forwarded to the worker's raycaster and the cursor the worker asks for. Replaces the editor's `<Canvas>`; the chrome around it is untouched. */
export function StageView({
  stageRole,
  frameloop = "demand",
  dpr,
  cutout = null,
  className,
  style,
  onClient,
}: {
  stageRole: StageRole;
  frameloop?: "demand" | "never";
  /** The preview pixel ratio, clamped to the device's. */
  dpr: number | [number, number];
  cutout?: FrameRect | null;
  className?: string;
  style?: CSSProperties;
  onClient?: (client: StageClient | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [client, setClient] = useState<StageClient | null>(null);
  const [cursor, setCursor] = useState("");
  // A canvas whose control was transferred cannot be transferred again, so the client lives as long as the element; the props it needs later are read through refs.
  const dprRef = useRef(dpr);
  const frameloopRef = useRef(frameloop);
  const onClientRef = useRef(onClient);
  onClientRef.current = onClient;

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
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
      setClient(null);
    };
  }, [stageRole]);

  useEffect(() => {
    dprRef.current = dpr;
    frameloopRef.current = frameloop;
    const canvas = ref.current;
    if (client && canvas) void client.configure(measure(canvas, dpr), frameloop);
  }, [client, dpr, frameloop]);

  useEffect(() => {
    client?.setCutout(cutout);
  }, [client, cutout]);

  useEffect(() => {
    const canvas = ref.current;
    if (!client || !canvas) return;
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
    const entries: [keyof HTMLElementEventMap, (e: never) => void][] = [
      ["pointerdown", forward("pointerdown")],
      ["pointermove", forward("pointermove")],
      ["pointerup", forward("pointerup")],
      ["pointercancel", forward("pointercancel")],
      ["pointerleave", forward("pointerleave")],
      ["click", forward("click")],
      ["dblclick", forward("dblclick")],
      ["contextmenu", forward("contextmenu")],
      ["wheel", forward("wheel")],
    ];
    for (const [name, fn] of entries)
      canvas.addEventListener(name, fn as EventListener, { passive: true });
    // A drag that leaves the canvas still ends: window-level up and cancel reach the worker too.
    const up = forward("pointerup");
    const cancel = forward("pointercancel");
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      for (const [name, fn] of entries) canvas.removeEventListener(name, fn as EventListener);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [client]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        cursor: cursor || undefined,
        ...style,
      }}
    />
  );
}

function measure(canvas: HTMLCanvasElement, dpr: number | [number, number]) {
  const rect = canvas.getBoundingClientRect();
  const device = window.devicePixelRatio || 1;
  const ratio = Array.isArray(dpr) ? Math.min(dpr[1], Math.max(dpr[0], device)) : dpr;
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: ratio };
}
