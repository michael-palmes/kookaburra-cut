import { type ThreeEvent, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { DoubleSide, type LineSegments, type Mesh, type Object3D } from "three";
import { outlineBracketSegments } from "./gizmoOutline";
import { type GizmoDomain, gizmoHandleAt } from "./gizmoRegistry";
import { useGizmoSectionOpen } from "./gizmoSections";
import { GIZMO_COLOURS, GIZMO_OUTLINE_OPACITY } from "./gizmoTokens";
import { HELPER_LAYER } from "./lightEditStore";

/** The section-scoped selection outline every 3D gizmo host mounts: corner brackets around an item while its inspector section is open, plus an invisible hit box that makes the item click-to-select. Editor-only by the light-helper contract: the brackets sit on HELPER_LAYER (disabled on the export camera for the whole run) and the hit box is `visible={false}`, which `WebGLRenderer.projectObject` returns on, so it is never in a render list at all. */
export function SceneOutline({
  size,
  domain,
  selected,
  onSelect,
}: {
  /** The item's local-space box, in the units of the group this mounts inside; a zero depth draws a flat rectangle. */
  size: readonly [number, number, number];
  domain: GizmoDomain;
  selected: boolean;
  onSelect: () => void;
}) {
  const open = useGizmoSectionOpen(domain);
  const gl = useThree((s) => s.gl);
  const linesRef = useRef<LineSegments>(null);
  const hitRef = useRef<Mesh>(null);
  const [hover, setHover] = useState(false);
  const [sx, sy, sz] = size;
  const positions = useMemo(() => outlineBracketSegments([sx, sy, sz]), [sx, sy, sz]);

  // Layer assignment must reach every child (three layers don't inherit).
  useEffect(() => {
    linesRef.current?.traverse((obj) => obj.layers.set(HELPER_LAYER));
  });
  // The cursor is shared chrome, and a closing section drops the hit mesh without an out event, so hand it back on every close and on unmount.
  useEffect(() => {
    if (!open) setHover(false);
    return () => {
      gl.domElement.style.cursor = "";
    };
  }, [open, gl]);

  if (!open) return null;

  const colour = selected ? GIZMO_COLOURS.selected : GIZMO_COLOURS.outline;
  const opacity = selected
    ? GIZMO_OUTLINE_OPACITY.selected
    : hover
      ? GIZMO_OUTLINE_OPACITY.hover
      : GIZMO_OUTLINE_OPACITY.idle;

  const setCursor = (on: boolean) => {
    setHover(on);
    gl.domElement.style.cursor = on ? "pointer" : "";
  };

  // Only a drawn box claims the shared cursor, and only the box that claimed it hands it back: an off-playhead scene's box is raycastable too, so it would otherwise advertise a click that pointer-down refuses, and clear the cursor out from under the box you are actually over.
  const onPointerOver = () => {
    if (drawn(hitRef.current)) setCursor(true);
  };
  const onPointerOut = () => {
    if (hover) setCursor(false);
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Every scene mounts at once and the compositor gates them by group visibility, which three's raycaster ignores.
    if (!drawn(hitRef.current)) return;
    if (gizmoHandleAt(e.pointer.x, e.pointer.y)) return;
    e.stopPropagation();
    onSelect();
  };

  return (
    <>
      <lineSegments ref={linesRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[positions, 3]}
            count={positions.length / 3}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color={colour} transparent opacity={opacity} toneMapped={false} />
      </lineSegments>
      <mesh
        ref={hitRef}
        visible={false}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
        onPointerDown={onPointerDown}
      >
        {sz === 0 ? (
          <planeGeometry args={[Math.abs(sx), Math.abs(sy)]} />
        ) : (
          <boxGeometry args={[Math.abs(sx), Math.abs(sy), Math.abs(sz)]} />
        )}
        <meshBasicMaterial side={DoubleSide} />
      </mesh>
    </>
  );
}

/** True while every ancestor is visible: an off-playhead scene is still raycastable, so without this a click on empty space could select an item from another scene. */
function drawn(object: Object3D | null): boolean {
  if (!object) return false;
  for (let o = object.parent; o; o = o.parent) if (!o.visible) return false;
  return true;
}
