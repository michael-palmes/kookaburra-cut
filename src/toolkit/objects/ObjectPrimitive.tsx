import { useContext, useMemo, useRef } from "react";
import { Box3, type Group, type Object3D, Vector3 } from "three";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { useObjectEditStore } from "../../engine/objectEditStore";
import { useSceneConsumesObjects } from "../../engine/objectRegistry";
import { SceneGizmo } from "../../engine/SceneGizmo";
import { SceneOutline } from "../../engine/SceneOutline";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import type { SceneDocObjectSpec } from "../../engine/sceneDocSchema";
import { useStageFloorY } from "../stage/context";
import type { V3 } from "../types";
import { readObjectGltf } from "./preload";
import { readObjectAsset } from "./registry";

/** World height an object auto-fits to when its manifest carries no `fitHeight` (a phone fits 2.6). */
const DEFAULT_OBJECT_HEIGHT = 1;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
/** Keeps the fitted base a hair above the floor so coplanar faces never z-fight. */
const GROUND_EPSILON = 0.002;

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** One staged library object: `readObjectAsset` suspends until the manifest + URLs land (unknown ids degrade to nothing), then `LoadedObject` suspends on the glb through the objects' own gltf cache (both pre-warmed by the export preamble and the option-preview capture). */
export function StagedObject({ spec }: { spec: SceneDocObjectSpec }) {
  const asset = readObjectAsset(spec.objectId);
  if (!asset) return null;
  return <LoadedObject spec={spec} asset={asset} />;
}

/** The HeroObject treatment: clone, recentre, auto-fit to the manifest's height, apply the sidecar placement on ONE group so the gizmo can attach to it. The gizmo is a TransformControls ATTACHED to that group (never wrapping it): it stays centred on the object and follows every drag, mounts only for the inspector-selected object, and `exportPreamble` clears that selection, so exports render the bare transform. Scale mode keeps every handle but snaps all three axes to the furthest-moved one live, so resizing is always even (no stretching); rotate mode's screen-space ring and free sphere stay usable when the camera is front on and the per-axis rings go edge on. */
function LoadedObject({
  spec,
  asset,
}: {
  spec: SceneDocObjectSpec;
  asset: NonNullable<ReturnType<typeof readObjectAsset>>;
}) {
  const ctx = useSceneContext();
  const sceneIndex = ctx?.index;
  // What a click selects, or null on a comparison's B side: it mounts the same object at the same index, so a write from here would land on the A doc.
  const editTarget =
    sceneIndex !== undefined && ctx?.side === undefined ? { sceneIndex, objectId: spec.id } : null;
  const stageFloorY = useStageFloorY();
  const selected = useObjectEditStore((s) => s.selected);
  const gizmoMode = useObjectEditStore((s) => s.gizmoMode);
  const sectionOpen = useGizmoSectionOpen("objects");
  const groupRef = useRef<Group>(null);
  const { scene } = readObjectGltf(asset.glbUrl);

  // Clone once per model (drei's cache is shared, never mutate it), recentre on the origin and auto-fit to the manifest height (the HeroObject treatment).
  const { root, fit, fittedHeight, size } = useMemo(() => {
    const clone = scene.clone(true);
    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    clone.position.sub(center);
    const target = asset.manifest.fitHeight ?? DEFAULT_OBJECT_HEIGHT;
    const fit = size.y > 1e-6 ? target / size.y : 1;
    return {
      root: clone as Object3D,
      fit,
      fittedHeight: size.y * fit,
      size: [size.x, size.y, size.z] as V3,
    };
  }, [scene, asset]);

  const placement = spec.placement ?? {};
  const { position = [0, 0, 0], rotationDeg = [0, 0, 0], scale = 1, ground = false } = placement;
  const groupPosition: V3 =
    ground && stageFloorY !== null
      ? [position[0], stageFloorY + (fittedHeight / 2) * scale + GROUND_EPSILON, position[2]]
      : position;
  const rotation: V3 = [
    rotationDeg[0] * DEG2RAD,
    rotationDeg[1] * DEG2RAD,
    rotationDeg[2] * DEG2RAD,
  ];

  const isSelected =
    editTarget !== null &&
    sectionOpen &&
    selected !== null &&
    selected.sceneIndex === editTarget.sceneIndex &&
    selected.objectId === editTarget.objectId;

  // The control mutates the group live; the commit reads the group back, so the doc lands exactly what is on screen and nothing snaps. A drag pins an explicit transform, so `ground` drops (the y just chosen wins).
  const dragging = useRef(false);
  const change = () => {
    dragging.current = true;
    uniformiseScale();
  };
  const commitDrag = () => {
    // A press that never moved a handle is not an edit, so it costs no write or history entry.
    if (!dragging.current) return;
    dragging.current = false;
    const group = groupRef.current;
    if (!group || sceneIndex === undefined) return;
    useObjectEditStore.getState().requestCommit({
      sceneIndex,
      objectId: spec.id,
      placement: {
        position: [
          round(group.position.x, 3),
          round(group.position.y, 3),
          round(group.position.z, 3),
        ],
        rotationDeg: [
          round(group.rotation.x * RAD2DEG, 1),
          round(group.rotation.y * RAD2DEG, 1),
          round(group.rotation.z * RAD2DEG, 1),
        ],
        scale: round(group.scale.x / fit, 3),
      },
    });
  };

  // Uniform scale only: an axis-cube drag stretches one axis, so snap all three to the furthest-moved axis every change (the centre cube is uniform already). Hiding the axis cubes instead hides the WHOLE scale gizmo: three names its centre handle "XYZ", so showX/Y/Z false blanks it too.
  const uniformiseScale = () => {
    const group = groupRef.current;
    if (gizmoMode !== "scale" || !group) return;
    const base = scale * fit;
    if (base <= 1e-6) return;
    let u = 1;
    for (const ratio of [group.scale.x / base, group.scale.y / base, group.scale.z / base]) {
      if (Math.abs(Math.log(Math.max(1e-3, Math.abs(ratio)))) > Math.abs(Math.log(Math.abs(u)))) {
        u = ratio;
      }
    }
    const next = Math.max(0.01 * base, Math.abs(u) * base);
    group.scale.set(next, next, next);
  };

  return (
    <>
      <group ref={groupRef} position={groupPosition} rotation={rotation} scale={scale * fit}>
        <primitive object={root} />
        {editTarget && (
          <SceneOutline
            size={size}
            domain="objects"
            selected={isSelected}
            onSelect={() => useObjectEditStore.getState().select(editTarget)}
          />
        )}
      </group>
      {isSelected && sceneIndex !== undefined && (
        <SceneGizmo
          object={groupRef}
          mode={gizmoMode}
          domain="objects"
          itemId={spec.id}
          sceneIndex={sceneIndex}
          onObjectChange={change}
          onMouseUp={commitDrag}
        />
      )}
    </>
  );
}

/** Host-side objects for scenes whose TSX never wires `useSceneObjects` (mounted by App's SceneHost, never scene TSX): reads the doc directly so it can't register as a consumer itself, the DevicesFallback pattern. */
export function ObjectsFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesObjects(sceneIndex);
  const objects = doc?.objects ?? [];
  if (consumed || objects.length === 0) return null;
  return (
    <>
      {objects.map((spec) => (
        <StagedObject key={spec.id} spec={spec} />
      ))}
    </>
  );
}
