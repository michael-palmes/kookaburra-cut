import { PivotControls, useGLTF } from "@react-three/drei";
import { useContext, useMemo, useRef } from "react";
import { Box3, Euler, Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import { useObjectEditStore } from "../../engine/objectEditStore";
import { useSceneConsumesObjects } from "../../engine/objectRegistry";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import type { SceneDocObjectSpec } from "../../engine/sceneDocSchema";
import { useStageFloorY } from "../stage/context";
import type { V3 } from "../types";
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

/** One staged library object: `readObjectAsset` suspends until the manifest + URLs land (unknown ids degrade to nothing), then `LoadedObject` suspends on the glb (both pre-warmed by the export preamble). */
export function StagedObject({ spec }: { spec: SceneDocObjectSpec }) {
  const asset = readObjectAsset(spec.objectId);
  if (!asset) return null;
  return <LoadedObject spec={spec} asset={asset} />;
}

/** The HeroObject treatment: clone, recentre, auto-fit to the manifest's height, apply the sidecar placement. The wrapping PivotControls is UI-only: enabled and visible only for the inspector-selected object, and `exportPreamble` clears that selection, so exports render the bare transform. */
function LoadedObject({
  spec,
  asset,
}: {
  spec: SceneDocObjectSpec;
  asset: NonNullable<ReturnType<typeof readObjectAsset>>;
}) {
  const sceneIndex = useSceneContext()?.index;
  const stageFloorY = useStageFloorY();
  const selected = useObjectEditStore((s) => s.selected);
  const pivotMatrix = useRef(new Matrix4());
  const { scene } = useGLTF(asset.glbUrl);

  // Clone once per model (drei's cache is shared, never mutate it), recentre on the origin and auto-fit to the manifest height (the HeroObject treatment).
  const { root, fit, fittedHeight } = useMemo(() => {
    const clone = scene.clone(true);
    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    clone.position.sub(center);
    const target = asset.manifest.fitHeight ?? DEFAULT_OBJECT_HEIGHT;
    const fit = size.y > 1e-6 ? target / size.y : 1;
    return { root: clone as Object3D, fit, fittedHeight: size.y * fit };
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
    selected !== null && selected.sceneIndex === sceneIndex && selected.objectId === spec.id;

  const commitDrag = () => {
    if (sceneIndex === undefined) return;
    // Bake the pivot's offset into the placement: decompose pivot * child so the doc carries the final transform and the pivot resets to identity.
    const child = new Matrix4().compose(
      new Vector3(...groupPosition),
      new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")),
      new Vector3(scale * fit, scale * fit, scale * fit),
    );
    const combined = new Matrix4().multiplyMatrices(pivotMatrix.current, child);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    combined.decompose(pos, quat, scl);
    const euler = new Euler().setFromQuaternion(quat, "XYZ");
    pivotMatrix.current.identity();
    useObjectEditStore.getState().requestCommit({
      sceneIndex,
      objectId: spec.id,
      // A drag pins an explicit transform, so `ground` drops (the y just chosen wins).
      placement: {
        position: [round(pos.x, 3), round(pos.y, 3), round(pos.z, 3)],
        rotationDeg: [
          round(euler.x * RAD2DEG, 1),
          round(euler.y * RAD2DEG, 1),
          round(euler.z * RAD2DEG, 1),
        ],
        scale: round(scl.x / fit, 3),
      },
    });
  };

  return (
    <PivotControls
      enabled={isSelected}
      visible={isSelected}
      matrix={pivotMatrix.current}
      depthTest={false}
      annotations={false}
      scale={0.8}
      onDragEnd={commitDrag}
    >
      <group position={groupPosition} rotation={rotation}>
        <group scale={scale * fit}>
          <primitive object={root} />
        </group>
      </group>
    </PivotControls>
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
