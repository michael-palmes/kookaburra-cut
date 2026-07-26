import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CurvePath,
  DoubleSide,
  Euler,
  type Group,
  type InstancedMesh,
  LineCurve3,
  type Material,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import type { FixturePlanEntry } from "../../engine/fixtures";
import { registerLightingAnimatable } from "../../engine/lightingAnimation";
import { registerRelativeLight } from "../../engine/lightingState";
import { placementPosition } from "../../engine/orbit";
import { useSceneContext } from "../../engine/sceneContext";
import { resolveLightingColour } from "../../engine/sceneLighting";
import type { FixtureSpec, Theme } from "../../theme/tokens";
import { useStageMapShadows } from "../stage/context";

/** Emissive light fixtures (v9 · PR 4): visible geometry that reads as the light source plus a paired REAL light, stacked (the standard practice: the rect-area light supplies illumination and soft falloff but emits nothing visible; the emissive mesh with `toneMapped: false` supplies the visible glow that bloom picks up but lights nothing). Geometry instances when the repeat runs long (`InstancedMesh` + `instanceColor` for per-instance emissive jitter); paired lights cannot instance and arrive pre-thinned by the fixture plan. Rect-area lights reach Standard/Physical materials only: the device lights up, troika text and shader backgrounds ignore them. */

const DEG2RAD = Math.PI / 180;
/** Emissive meshes instance above this count; below it, plain meshes keep the graph simple. */
const INSTANCE_THRESHOLD = 4;

/** A rounded-rectangle tube path for the neon-sign "rect" shape. */
function roundedRectPath(w: number, h: number): CurvePath<Vector3> {
  const r = Math.min(w, h) * 0.22;
  const hw = w / 2;
  const hh = h / 2;
  const path = new CurvePath<Vector3>();
  const line = (a: [number, number], b: [number, number]) =>
    path.add(new LineCurve3(new Vector3(a[0], a[1], 0), new Vector3(b[0], b[1], 0)));
  const arc = (cx: number, cy: number, from: number, to: number) => {
    const points: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = from + ((to - from) * i) / 6;
      points.push(new Vector3(cx + r * Math.cos(t), cy + r * Math.sin(t), 0));
    }
    path.add(new CatmullRomCurve3(points));
  };
  line([-hw + r, hh], [hw - r, hh]);
  arc(hw - r, hh - r, Math.PI / 2, 0);
  line([hw, hh - r], [hw, -hh + r]);
  arc(hw - r, -hh + r, 0, -Math.PI / 2);
  line([hw - r, -hh], [-hw + r, -hh]);
  arc(-hw + r, -hh + r, -Math.PI / 2, -Math.PI);
  line([-hw, -hh + r], [-hw, hh - r]);
  arc(-hw + r, hh - r, Math.PI, Math.PI / 2);
  return path;
}

function fixtureGeometry(spec: FixtureSpec): BufferGeometry {
  const [a, b] = spec.size;
  switch (spec.form) {
    case "tube":
    case "tube-stand": {
      // Capsule along X (the corridor axis default); the capsule param is the mid-section length.
      const geometry = new CapsuleGeometry(b / 2, Math.max(0.01, a - b), 4, 16);
      geometry.rotateZ(Math.PI / 2);
      return geometry;
    }
    case "panel":
      return new PlaneGeometry(a, b);
    case "ring":
    case "ring-light":
      return new TorusGeometry(a / 2, Math.max(0.005, b / 2), 12, 48);
    case "strip":
    case "led-strip":
      return new BoxGeometry(a, b, b);
    case "bulb":
      return new SphereGeometry(a / 2, 24, 16);
    case "neon-sign": {
      const shape = spec.shape ?? "line";
      if (shape === "circle") return new TorusGeometry(a / 2, Math.max(0.005, b / 2), 12, 48);
      if (shape === "rect") {
        return new TubeGeometry(roundedRectPath(a, a * 0.6), 96, Math.max(0.005, b / 2), 10, true);
      }
      const geometry = new CapsuleGeometry(b / 2, Math.max(0.01, a - b), 4, 16);
      geometry.rotateZ(Math.PI / 2);
      return geometry;
    }
  }
}

/** Fixed dark-neutral housing material values, so housings sit in any theme. */
const HOUSING = { color: "#2a2d33", roughness: 0.55, metalness: 0.35 } as const;

/** Simple procedural housing per practical form (v9 · PR 10): extrusions, stands and channels around the same emissive core; housings cast/receive real shadows under a map-shadowed stage like any staged mesh. */
function Housing({ spec, mapShadows }: { spec: FixtureSpec; mapShadows: boolean }) {
  const [a, b] = spec.size;
  const shadowProps = { castShadow: mapShadows, receiveShadow: mapShadows };
  switch (spec.form) {
    case "neon-sign": {
      const wide = (spec.shape ?? "line") !== "line";
      return (
        <mesh {...shadowProps} position={[0, 0, -b * 2]}>
          <boxGeometry args={[a * 1.2, wide ? a * 0.8 : Math.max(0.3, a * 0.24), b]} />
          <meshStandardMaterial {...HOUSING} />
        </mesh>
      );
    }
    case "tube-stand":
      return (
        <group {...shadowProps}>
          {[-1, 1].map((side) => (
            <mesh key={side} {...shadowProps} position={[(side * a) / 2, 0, 0]}>
              <cylinderGeometry args={[b * 1.4, b * 1.4, b * 3, 12]} />
              <meshStandardMaterial {...HOUSING} />
            </mesh>
          ))}
          <mesh {...shadowProps} position={[0, -a * 0.35, 0]}>
            <cylinderGeometry args={[b * 0.7, b * 0.7, a * 0.7, 10]} />
            <meshStandardMaterial {...HOUSING} />
          </mesh>
          <mesh {...shadowProps} position={[0, -a * 0.7, 0]}>
            <cylinderGeometry args={[a * 0.18, a * 0.22, b * 1.5, 20]} />
            <meshStandardMaterial {...HOUSING} />
          </mesh>
        </group>
      );
    case "ring-light":
      return (
        <group>
          <mesh {...shadowProps} rotation={[0, 0, 0]}>
            <torusGeometry args={[a / 2 + b * 1.6, b * 1.2, 10, 48]} />
            <meshStandardMaterial {...HOUSING} />
          </mesh>
          <mesh {...shadowProps} position={[0, -a * 0.45, 0]}>
            <cylinderGeometry args={[b * 0.8, b * 0.8, a * 0.4, 10]} />
            <meshStandardMaterial {...HOUSING} />
          </mesh>
          <mesh {...shadowProps} position={[0, -a * 0.68, 0]}>
            <cylinderGeometry args={[a * 0.16, a * 0.2, b * 1.6, 20]} />
            <meshStandardMaterial {...HOUSING} />
          </mesh>
        </group>
      );
    case "led-strip":
      return (
        <group>
          <mesh {...shadowProps} position={[0, 0, -b]}>
            <boxGeometry args={[a * 1.02, b * 3, b]} />
            <meshStandardMaterial {...HOUSING} />
          </mesh>
          {[-1, 1].map((side) => (
            <mesh key={side} {...shadowProps} position={[0, side * b * 1.5, -b * 0.25]}>
              <boxGeometry args={[a * 1.02, b, b * 2.5]} />
              <meshStandardMaterial {...HOUSING} />
            </mesh>
          ))}
        </group>
      );
    default:
      return null;
  }
}

/** The paired light type per form: rect-area for the long emitters, point for the round ones. */
const PAIRED_POINT: FixtureSpec["form"][] = ["ring", "bulb", "ring-light"];

function PairedLight({ spec, colors }: { spec: FixtureSpec; colors: Theme["colors"] }) {
  const color = resolveLightingColour(spec, colors);
  if (PAIRED_POINT.includes(spec.form)) {
    return (
      <pointLight
        userData={{ kookaburraFixtureLight: true }}
        intensity={spec.lightIntensity}
        color={color}
        decay={2}
      />
    );
  }
  return (
    <rectAreaLight
      userData={{ kookaburraFixtureLight: true }}
      intensity={spec.lightIntensity}
      color={color}
      width={spec.size[0]}
      height={spec.form === "panel" ? spec.size[1] : spec.size[1] * 2}
    />
  );
}

/** The forms that carry procedural housing geometry. */
const HOUSED: FixtureSpec["form"][] = ["neon-sign", "tube-stand", "ring-light", "led-strip"];

export function Fixture({ entry, colors }: { entry: FixturePlanEntry; colors: Theme["colors"] }) {
  const { spec, instances, lights } = entry;
  const key = useId();
  const mapShadows = useStageMapShadows();
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
      // `side` is omitted rather than passed as undefined, which three warns about per material.
      new MeshBasicMaterial(
        spec.form === "panel" ? { toneMapped: false, side: DoubleSide } : { toneMapped: false },
      ),
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
      // Glow cores only (toneMapped false); housings are Standard materials the keyframes must never recolour.
      if (
        mesh.isMesh &&
        !(mesh as InstancedMesh).isInstancedMesh &&
        (mesh.material as Material)?.toneMapped === false
      ) {
        meshes.push(mesh);
      }
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
    <group
      ref={groupRef}
      userData={{ kookaburraFixture: true }}
      position={relative ? undefined : basePosition}
    >
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
      {HOUSED.includes(spec.form) &&
        instances.map((inst, i) => (
          <group
            // biome-ignore lint/suspicious/noArrayIndexKey: derived static list
            key={`h${i}`}
            position={inst.offset}
            rotation={rotation}
          >
            <Housing spec={spec} mapShadows={mapShadows} />
          </group>
        ))}
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
