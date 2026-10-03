import { useLayoutEffect, useMemo, useRef } from "react";
import {
  CircleGeometry,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import {
  lookColorUniform,
  loopSeconds,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { FROSTED, frostedLayout, lampPosition, panePose } from "./panes";
import { CORE_FRAGMENT, FLOOR_FRAGMENT, PANE_FRAGMENT, PANE_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_POSITION: [number, number, number] = [0, FROSTED.floorY, 0];
const FLOOR_RADIUS = 100;

/** Frosted panes: a ring of inward-facing etched panes with shoji rails, lamps drifting behind them on exact 60 s Lissajous loops and blooming through the frost as analytic Gaussians (no transmission pass), small glow cores showing through the gaps. */
export function FrostedPanes({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const panesRef = useRef<InstancedMesh>(null);
  const coresRef = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => {
    const pane = new PlaneGeometry(1, 1);
    pane.setAttribute(
      "aSize",
      new InstancedBufferAttribute(new Float32Array(FROSTED.maxPanes * 2), 2),
    );
    pane.setAttribute("aSeed", new InstancedBufferAttribute(new Float32Array(FROSTED.maxPanes), 1));
    return {
      pane,
      core: new SphereGeometry(FROSTED.coreRadius, 16, 12),
      floor: new CircleGeometry(FLOOR_RADIUS, 96).rotateX(-Math.PI / 2),
    };
  }, []);
  useLayoutEffect(
    () => () => {
      geometry.pane.dispose();
      geometry.core.dispose();
      geometry.floor.dispose();
    },
    [geometry],
  );

  const ring = params.ringRadius;
  const { panes, lamps } = useMemo(
    () => frostedLayout(params.paneCount, params.lampCount, ring),
    [params.paneCount, params.lampCount, ring],
  );
  const paneMeshes = useMemo(() => [panesRef], []);
  useStaticInstancedLayout(paneMeshes, panes, panePose);
  const coreMatrix = useMemo(() => new Matrix4(), []);

  const mats = useLookMaterials(
    () => ({
      panes: {
        key: "frosted-panes/pane",
        vertexShader: PANE_VERTEX,
        fragmentShader: PANE_FRAGMENT,
        transparent: true,
        depthWrite: true,
        uniforms: {
          uGlass: lookColorUniform("#161e25"),
          uFrame: lookColorUniform("#2b3740"),
          uBloom: lookColorUniform("#835838"),
          uLampColor: lookColorUniform("#b58a5e"),
          uBacking: lookColorUniform("#1a232c"),
          uLamps: { value: Array.from({ length: FROSTED.maxLamps }, () => new Vector3()) },
          uLampCount: { value: 0 },
          uBloomCap: { value: 0.8 },
          uFrost: { value: 0.5 },
          uRain: { value: 0 },
          uLoop: { value: 0 },
        },
      },
      cores: {
        key: "frosted-panes/core",
        fragmentShader: CORE_FRAGMENT,
        transparent: true,
        uniforms: { uLampColor: lookColorUniform("#b58a5e") },
      },
      floor: {
        key: "frosted-panes/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: {
          uFrame: lookColorUniform("#2b3740"),
          uBacking: lookColorUniform("#1a232c"),
          uRing: { value: 12.5 },
        },
      },
    }),
    [],
  );

  const [glass, frame, bloom, lamp] = colors;
  useLayoutEffect(() => {
    const p = mats.panes.uniforms;
    p.uGlass.value.set(glass);
    p.uFrame.value.set(frame);
    p.uBloom.value.set(bloom);
    p.uLampColor.value.set(lamp);
    p.uBacking.value.set(backing);
    mats.cores.uniforms.uLampColor.value.set(lamp);
    mats.floor.uniforms.uFrame.value.set(frame);
    mats.floor.uniforms.uBacking.value.set(backing);
  }, [mats, glass, frame, bloom, lamp, backing]);

  useLayoutEffect(() => {
    const size = geometry.pane.getAttribute("aSize") as InstancedBufferAttribute;
    const seed = geometry.pane.getAttribute("aSeed") as InstancedBufferAttribute;
    panes.forEach((pane, i) => {
      size.setXY(i, pane.width, pane.height);
      seed.setX(i, pane.seed);
    });
    size.needsUpdate = true;
    seed.needsUpdate = true;
  }, [geometry, panes]);

  useLayoutEffect(() => {
    const p = mats.panes.uniforms;
    const cores = coresRef.current;
    for (let j = 0; j < lamps.length; j++) {
      const at = p.uLamps.value[j] as Vector3;
      lampPosition(lamps[j], ring, t, at);
      cores?.setMatrixAt(j, coreMatrix.makeTranslation(at.x, at.y, at.z));
    }
    if (cores) {
      cores.count = lamps.length;
      cores.instanceMatrix.needsUpdate = true;
    }
    p.uLampCount.value = lamps.length;
    p.uBloomCap.value = params.bloom;
    p.uFrost.value = params.frost;
    p.uRain.value = params.rain;
    p.uLoop.value = loopSeconds(t, FROSTED.lampPeriod) / FROSTED.lampPeriod;
    mats.floor.uniforms.uRing.value = ring;
  });

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={geometry.floor} material={mats.floor} position={FLOOR_POSITION} />
      <instancedMesh
        ref={panesRef}
        args={[undefined, undefined, FROSTED.maxPanes]}
        geometry={geometry.pane}
        material={mats.panes}
        frustumCulled={false}
      />
      <instancedMesh
        ref={coresRef}
        args={[undefined, undefined, FROSTED.maxLamps]}
        geometry={geometry.core}
        material={mats.cores}
        frustumCulled={false}
      />
    </group>
  );
}
