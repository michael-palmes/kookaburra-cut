import { useContext, useEffect, useRef } from "react";
import type { Group } from "three";
import { useDeviceEditStore } from "../../engine/deviceEditStore";
import { SceneGizmo } from "../../engine/SceneGizmo";
import { SceneDocContext } from "../../engine/sceneContext";
import type { V3 } from "../types";
import { type DevicePose, deviceGizmoCommit } from "./gizmoCommit";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const poseKey = (p: DevicePose) => `${p.position.join()}|${p.rotationDeg.join()}|${p.scale}`;

/** The device gizmo: no group inside `Device` carries the whole placement pose (float, spin and the intro presets ride between them), so the control attaches to an invisible proxy that does, mounted as a SIBLING of the device's root group so it shares that space without double-counting the drag. The drag feeds back through `onDrag`, and pointer-up posts the sidecar write the Position sliders would make. Editor-only: it mounts only while the device store holds this selection, which `exportPreamble` clears. */
export function DeviceGizmo({
  deviceId,
  sceneIndex,
  committed,
  rendered,
  onDrag,
}: {
  deviceId: string;
  sceneIndex: number;
  /** The committed placement itself: the re-sync signal, since a ground clamp can absorb a whole drag and leave `rendered` unchanged, which would strand the proxy at the dragged pose and compound the next drag. */
  committed: DevicePose;
  /** The pose the render is using from the COMMITTED placement (ground clamp applied), never the live drag. */
  rendered: DevicePose;
  onDrag: (pose: DevicePose | null) => void;
}) {
  const proxyRef = useRef<Group>(null);
  const doc = useContext(SceneDocContext);
  const mode = useDeviceEditStore((s) => s.gizmoMode);
  const dragging = useRef(false);
  const synced = useRef<string | null>(null);

  // No dep array and no transform props: React never touches the proxy, so a re-render mid-drag (the clock ticks every frame) cannot stomp the control. Only a NEW committed pose re-syncs it, so the handles hold the drag across the async doc write instead of snapping back for it.
  useEffect(() => {
    const p = proxyRef.current;
    if (!p || dragging.current) return;
    const key = poseKey(committed);
    if (key === synced.current) return;
    synced.current = key;
    p.position.set(rendered.position[0], rendered.position[1], rendered.position[2]);
    p.rotation.set(
      rendered.rotationDeg[0] * DEG2RAD,
      rendered.rotationDeg[1] * DEG2RAD,
      rendered.rotationDeg[2] * DEG2RAD,
    );
    p.scale.setScalar(rendered.scale);
  });

  const readProxy = (): DevicePose | null => {
    const p = proxyRef.current;
    if (!p) return null;
    return {
      position: [p.position.x, p.position.y, p.position.z] as V3,
      rotationDeg: [p.rotation.x * RAD2DEG, p.rotation.y * RAD2DEG, p.rotation.z * RAD2DEG] as V3,
      scale: p.scale.x,
    };
  };

  // Uniform scale only (the staged-object rule): snap all three axes to the furthest-moved one.
  const uniformiseScale = (p: Group) => {
    const base = rendered.scale;
    if (base <= 1e-6) return;
    let u = 1;
    for (const ratio of [p.scale.x / base, p.scale.y / base, p.scale.z / base]) {
      if (Math.abs(Math.log(Math.max(1e-3, Math.abs(ratio)))) > Math.abs(Math.log(Math.abs(u)))) {
        u = ratio;
      }
    }
    const next = Math.max(0.01 * base, Math.abs(u) * base);
    p.scale.set(next, next, next);
  };

  const change = () => {
    const p = proxyRef.current;
    if (!p) return;
    dragging.current = true;
    if (mode === "scale") uniformiseScale(p);
    onDrag(readProxy());
  };

  const commit = () => {
    // A press that never moved a handle is not an edit, so it costs no history entry.
    if (!dragging.current) return;
    dragging.current = false;
    const dragged = readProxy();
    if (!dragged) return;
    const authored = doc?.devices?.find((d) => d.id === deviceId)?.placement ?? {};
    useDeviceEditStore.getState().requestCommit(
      deviceGizmoCommit({
        deviceId,
        sceneIndex,
        dragged,
        rendered,
        authored,
        // A live block is the branch the sliders take, delta entry or not.
        delta: doc?.deviceLayout ? (doc.deviceLayout.devices?.[deviceId] ?? {}) : undefined,
      }),
    );
  };

  return (
    <>
      <group ref={proxyRef} />
      <SceneGizmo
        object={proxyRef}
        mode={mode}
        domain="devices"
        itemId={deviceId}
        sceneIndex={sceneIndex}
        onObjectChange={change}
        onMouseUp={commit}
      />
    </>
  );
}
