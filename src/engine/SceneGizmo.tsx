import { TransformControls } from "@react-three/drei";
import { type ComponentRef, useEffect, useId, useLayoutEffect, useRef } from "react";
import type { Object3D } from "three";
import type { GizmoMode } from "./gizmoMode";
import {
  type GizmoDomain,
  registerGizmoPicker,
  transformControlsPicker,
  unregisterGizmoPicker,
} from "./gizmoRegistry";
import { GIZMO_SIZE, restyleTransformControls } from "./gizmoTokens";

/** The one TransformControls seam: every 3D gizmo host (staged objects, staged charts) mounts this instead of drei's control directly, so they cannot drift on size, palette or pointer routing. Editor-only by construction: it mounts only while its domain store holds the selection, and `exportPreamble` clears every selection. Registering the ACTIVE mode's picker group lets the camera tool overlay stand down when the pointer is over a handle (`useGizmoYield`). */
export function SceneGizmo({
  object,
  mode,
  domain,
  itemId,
  sceneIndex,
  onObjectChange,
  onMouseUp,
  claim,
}: {
  object: React.RefObject<Object3D | null>;
  mode: GizmoMode;
  domain: GizmoDomain;
  itemId: string;
  sceneIndex: number;
  onObjectChange?: () => void;
  onMouseUp?: () => void;
  claim?: () => void;
}) {
  const ref = useRef<ComponentRef<typeof TransformControls>>(null);
  const key = useId();

  useEffect(() => {
    registerGizmoPicker(key, {
      domain,
      itemId,
      sceneIndex,
      pickers: () => transformControlsPicker(ref.current, mode),
      root: () => ref.current,
      claim,
    });
    return () => unregisterGizmoPicker(key);
  }, [key, domain, itemId, sceneIndex, mode, claim]);

  // three-stdlib builds every mode's materials at construction, so one pass at mount recolours the lot.
  useLayoutEffect(() => {
    restyleTransformControls(ref.current);
  }, []);

  return (
    <TransformControls
      ref={ref}
      object={object as React.RefObject<Object3D>}
      mode={mode}
      size={GIZMO_SIZE}
      onObjectChange={onObjectChange}
      onMouseUp={onMouseUp}
    />
  );
}
