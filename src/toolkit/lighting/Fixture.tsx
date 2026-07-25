import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  DoubleSide,
  Euler,
  type Group,
  type InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { FixturePlanEntry } from "../../engine/fixtures";
import { registerLightingAnimatable } from "../../engine/lightingAnimation";
import { registerRelativeLight } from "../../engine/lightingState";
import { placementPosition } from "../../engine/orbit";
import { useSceneContext } from "../../engine/sceneContext";
import { resolveLightingColour } from "../../engine/sceneLighting";
import type { FixtureSpec, Theme } from "../../theme/tokens";

/** Emissive light fixtures (v9 · PR 4): visible geometry that reads as the light source plus a paired REAL light, stacked (the standard practice: the rect-area light supplies illumination and soft falloff but emits nothing visible; the emissive mesh with `toneMapped: false` supplies the visible glow that bloom picks up but lights nothing). Geometry instances when the repeat runs long (`InstancedMesh` + `instanceColor` for per-instance emissive jitter); paired lights cannot instance and arrive pre-thinned by the fixture plan. Rect-area lights reach Standard/Physical materials only: the device lights up, troika text and shader backgrounds ignore them. */

const DEG2RAD = Math.PI / 180;
/** Emissive meshes instance above this count; below it, plain meshes keep the graph simple. */
const INSTANCE_THRESHOLD = 4;

function fixtureGeometry(spec: FixtureSpec): BufferGeometry {
  const [a, b] = spec.size;
  switch (spec.form) {
    case "tube": {
      // Capsule along X (the corridor axis default); the capsule param is the mid-section length.
      const geometry = new CapsuleGeometry(b / 2, Math.max(0.01, a - b), 4, 16);
      geometry.rotateZ(Math.PI / 2);
      return geometry;
    }
    case "panel":
      return new PlaneGeometry(a, b);
    case "ring":
      return new TorusGeometry(a / 2, Math.max(0.005, b / 2), 12, 48);
    case "strip":
      return new BoxGeometry(a, b, b);
    case "bulb":
      return new SphereGeometry(a / 2, 24, 16);
  }
}

/** The paired light type per form: rect-area for the long emitters, point for the round ones. */
const PAIRED_POINT: FixtureSpec["form"][] = ["ring", "bulb"];

function PairedLight({ spec, colors }: { spec: FixtureSpec; colors: Theme["colors"] }) {
  const color = resolveLightingColour(spec, colors);
  if (PAIRED_POINT.includes(spec.form)) {
    return <pointLight intensity={spec.lightIntensity} color={color} decay={2} />;
  }
  return (
    <rectAreaLight
      intensity={spec.lightIntensity}
      color={color}
      width={spec.size[0]}
      height={spec.form === "panel" ? spec.size[1] : spec.size[1] * 2}
    />
  );
}

export function Fixture({ entry, colors }: { entry: FixturePlanEntry; colors: Theme["colors"] }) {
  const { spec, instances, lights } = entry;
  const key = useId();
  const groupRef = useRef<Group>(null);
  const relative = (spec.space ?? "world") !== "world";
  const basePosition = placementPosition(spec.placement);
  const rotation = (spec.rotationDeg ?? [0, 0, 0]).map((d) => d * DEG2RAD) as [
    number,
    number,
    number,
  ];

  // The visible-glow colour: the resolved fixture colour scaled by `emissive` (above 1.0 crosses the bloom threshold; `toneMapped: false` keeps it out of ACES range compression).
  const baseColor = useMemo(() => new Color(resolveLightingColour(spec, colors)), [spec, colors]);
  const geometry = useMemo(() => fixtureGeometry(spec), [spec]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        toneMapped: false,
        side: spec.form === "panel" ? DoubleSide : undefined,
      }),
    [spec.form],
  );
  useEffect(() => () => material.dispose(), [material]);

  const instanced = instances.length > INSTANCE_THRESHOLD;
  const instancedRef = useRef<InstancedMesh>(null);

  // Per-instance matrices + emissive-jitter colours (instanceColor, never per-instance materials).
  useLayoutEffect(() => {
    if (!instanced) return;
    const mesh = instancedRef.current;
    if (!mesh) return;
    const m = new Matrix4();
    const c = new Color();
    const euler = new Euler(rotation[0], rotation[1], rotation[2]);
    instances.forEach((inst, i) => {
      m.makeRotationFromEuler(euler);
      m.setPosition(inst.offset[0], inst.offset[1], inst.offset[2]);
      mesh.setMatrixAt(i, m);
      c.copy(baseColor).multiplyScalar(spec.emissive * inst.emissiveScale);
      mesh.setColorAt(i, c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  useEffect(() => {
    if (!relative || !groupRef.current) return;
    return registerRelativeLight(key, {
      object: groupRef.current,
      targetObject: null,
      aimSelf: false,
      orient: true,
      spec: {
        space: (spec.space ?? "world") as "camera" | "subject",
        placement: spec.placement,
        target: [0, 0, 0],
      },
    });
  }, [key, relative, spec]);

  // Keyframe apply-seam registration (emissive/lightIntensity per fixture id): the traversal snapshots the mounted meshes and paired lights in scene-graph (= instance) order.
  const sceneIndex = useSceneContext()?.index;
  useEffect(() => {
    const group = groupRef.current;
    if (!group || sceneIndex === undefined) return;
    const meshes: import("three").Mesh[] = [];
    const pairedLights: import("three").Light[] = [];
    group.traverse((obj) => {
      const light = obj as import("three").Light;
      if (light.isLight) {
        pairedLights.push(light);
        return;
      }
      const mesh = obj as import("three").Mesh;
      if (mesh.isMesh && !(mesh as InstancedMesh).isInstancedMesh) meshes.push(mesh);
    });
    return registerLightingAnimatable(`${key}:anim`, {
      kind: "fixture",
      sceneIndex,
      id: spec.id,
      base: spec,
      baseColor: resolveLightingColour(spec, colors),
      instances,
      meshes,
      instanced: instancedRef.current,
      pairedLights,
    });
  }, [key, spec, colors, instances, sceneIndex]);

  return (
    <group ref={groupRef} position={relative ? undefined : basePosition}>
      {instanced ? (
        <instancedMesh ref={instancedRef} args={[geometry, material, instances.length]} />
      ) : (
        instances.map((inst, i) => (
          <mesh
            // Instances are a pure function of the spec; index identity is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: derived static list
            key={i}
            geometry={geometry}
            position={inst.offset}
            rotation={rotation}
          >
            <meshBasicMaterial
              toneMapped={false}
              side={spec.form === "panel" ? DoubleSide : undefined}
              color={baseColor.clone().multiplyScalar(spec.emissive * inst.emissiveScale)}
            />
          </mesh>
        ))
      )}
      {instances.map((inst, i) =>
        lights[i] ? (
          <group
            // biome-ignore lint/suspicious/noArrayIndexKey: derived static list
            key={`l${i}`}
            position={inst.offset}
            rotation={rotation}
          >
            <PairedLight spec={spec} colors={colors} />
          </group>
        ) : null,
      )}
    </group>
  );
}

export function StageFixtures({
  entries,
  colors,
}: {
  entries: FixturePlanEntry[];
  colors: Theme["colors"];
}) {
  return (
    <>
      {entries.map((entry) => (
        <Fixture key={entry.spec.id} entry={entry} colors={colors} />
      ))}
    </>
  );
}
