import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GizmoDomain,
  hasGizmoPickers,
  stageGizmoHandleAt,
  stageWorldRect,
  subscribeGizmoPickers,
} from "../../engine/gizmoRegistry";
import { cameraOverrideHeld, pointerNdc, routeLayerPointer, routePointer } from "./gizmoRouting";
import { modifierSnapshot, useModifierKeys } from "./modifierKeys";

/** Lets a full-frame tool surface stand down while a 3D gizmo handle is under the pointer: drei's TransformControls listens on the canvas, which sits BELOW the tool surface, so the surface must go `pointer-events: none` for real events to reach it. Listeners go on `window` in the capture phase because an inert overlay stops receiving its own pointer events, so hover tracking has to live above it. Hover is re-tested at the parked pointer whenever the surface arms or the pickable set changes, since neither fires a pointermove. `enabled` is the surface's own render condition, `dragging` whether its own drag is in flight; `gizmoClaimedPointer` reads the latch synchronously, so a surface that is still live can decline a pointer-down the router already handed to a handle. */
export function useGizmoYield(
  enabled: boolean,
  dragging: boolean,
): { inert: boolean; gizmoClaimedPointer: () => boolean } {
  const mods = useModifierKeys();
  const [overHandle, setOverHandle] = useState(false);
  const [gizmoLatched, setGizmoLatched] = useState(false);
  const latched = useRef(false);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);

  // Tracked whether or not the surface is armed: a tool arms from a window keydown, with the pointer wherever it was left.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerAt.current = { x: e.clientX, y: e.clientY };
    };
    const opts = { capture: true } as const;
    window.addEventListener("pointermove", onMove, opts);
    return () => window.removeEventListener("pointermove", onMove, opts);
  }, []);

  useEffect(() => {
    if (!enabled) {
      latched.current = false;
      setOverHandle(false);
      setGizmoLatched(false);
      return;
    }
    // The handles live in the stage, so a hit test is a round trip: hover keeps the last answer current, and a press reads it rather than waiting (the pointer moved there first).
    let over = false;
    let testSeq = 0;
    const hitAt = (clientX: number, clientY: number, claim: boolean) => {
      if (!hasGizmoPickers()) return Promise.resolve(null);
      const rect = stageWorldRect();
      if (!rect) return Promise.resolve(null);
      const ndc = pointerNdc(clientX, clientY, rect);
      return ndc ? stageGizmoHandleAt(ndc.x, ndc.y, claim) : Promise.resolve(null);
    };
    const test = (clientX: number, clientY: number) => {
      const seq = ++testSeq;
      void hitAt(clientX, clientY, false).then((hit) => {
        if (seq !== testSeq) return;
        over = hit !== null;
        setOverHandle(over);
      });
    };
    const retest = () => {
      const at = pointerAt.current;
      if (at) test(at.x, at.y);
      else setOverHandle(false);
    };
    retest();
    const onMove = (e: PointerEvent) => test(e.clientX, e.clientY);
    // The latch holds until pointer-up, so a modifier pressed mid-drag can never yank an in-flight handle drag away.
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!over) return;
      const owner = routePointer({
        cameraArmed: true,
        overHandle: true,
        overrideHeld: cameraOverrideHeld(modifierSnapshot()),
        gizmoLatched: false,
        cameraLatched: false,
      });
      if (owner !== "gizmo") return;
      latched.current = true;
      setGizmoLatched(true);
      void hitAt(e.clientX, e.clientY, true);
    };
    const onUp = () => {
      latched.current = false;
      setGizmoLatched(false);
    };
    const opts = { capture: true } as const;
    const unsubscribe = subscribeGizmoPickers(retest);
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onUp, opts);
    return () => {
      unsubscribe();
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onUp, opts);
    };
  }, [enabled]);

  const gizmoClaimedPointer = useCallback(() => latched.current, []);
  const inert =
    enabled &&
    routePointer({
      cameraArmed: true,
      overHandle,
      overrideHeld: cameraOverrideHeld(mods),
      gizmoLatched,
      cameraLatched: dragging,
    }) === "gizmo";
  return { inert, gizmoClaimedPointer };
}

/** The hit test the layer yield hangs off: a same-domain 3D handle under these client coordinates, asked of the stage. */
function sceneHandleAt(clientX: number, clientY: number, domain: GizmoDomain): Promise<boolean> {
  if (!hasGizmoPickers(domain)) return Promise.resolve(false);
  const rect = stageWorldRect();
  if (!rect) return Promise.resolve(false);
  const ndc = pointerNdc(clientX, clientY, rect);
  return ndc === null
    ? Promise.resolve(false)
    : stageGizmoHandleAt(ndc.x, ndc.y, false, domain).then((hit) => hit !== null);
}

/** `useGizmoYield` mirrored for a 2D layer, which sits ABOVE the canvas rather than below it: while a 3D gizmo of the layer's OWN domain has a handle under the pointer, the layer's hit elements stand down so the press reaches `TransformControls`. Hover rides `window` in the capture phase and is re-tested whenever the pickable set changes, since a gizmo mounts from the inspector with the pointer parked. `atPointer` is the synchronous backstop the DOM cannot give: a stale hover then drops that press instead of hijacking it into a 2D selection. */
export function useSceneGizmoYield(
  domain: GizmoDomain,
  dragging: boolean,
): { yielded: boolean; atPointer: (clientX: number, clientY: number) => boolean } {
  const [overHandle, setOverHandle] = useState(false);

  const over = useRef(false);
  useEffect(() => {
    let parked: { x: number; y: number } | null = null;
    let seq = 0;
    const test = (x: number, y: number) => {
      const mine = ++seq;
      void sceneHandleAt(x, y, domain).then((hit) => {
        if (mine !== seq) return;
        over.current = hit;
        setOverHandle(hit);
      });
    };
    const onMove = (e: PointerEvent) => {
      parked = { x: e.clientX, y: e.clientY };
      test(e.clientX, e.clientY);
    };
    const retest = () => {
      if (parked) test(parked.x, parked.y);
    };
    const opts = { capture: true } as const;
    const unsubscribe = subscribeGizmoPickers(retest);
    window.addEventListener("pointermove", onMove, opts);
    return () => {
      unsubscribe();
      window.removeEventListener("pointermove", onMove, opts);
    };
  }, [domain]);

  // A press reads the hover answer the stage last gave for this pointer; the next test is already in flight.
  const atPointer = useCallback(() => over.current, []);
  const yielded =
    routeLayerPointer({ overSceneHandle: overHandle, layerDragging: dragging }) === "scene-gizmo";
  return { yielded, atPointer };
}
