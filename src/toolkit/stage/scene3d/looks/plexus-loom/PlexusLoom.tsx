import { useEffect, useLayoutEffect, useMemo } from "react";
import { TorusGeometry } from "three";
import {
  type InkStrand,
  inkRibbonMaterial,
  inkStrands,
  lookColorUniform,
  loopSeconds,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { HOOP_FRAGMENT, LOOM, THREAD_FRAGMENT, THREAD_PATH, THREAD_VERTEX_HOOK } from "./shaders";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const THREADS_PER_BUNDLE_PAIR = 2 * LOOM.threadsPerBundle;

/** Bundle-major strands (bundle, then family, then thread), so the first `bundles * 6` strands draw exactly `bundles` bundles per family. */
export function loomStrands(maxBundles: number): InkStrand[] {
  return inkStrands(
    maxBundles * THREADS_PER_BUNDLE_PAIR,
    LOOM.points,
    (_, i) => [i / (LOOM.points - 1)],
    {
      data: (s) => {
        const pair = s % THREADS_PER_BUNDLE_PAIR;
        const sign = pair < LOOM.threadsPerBundle ? 1 : -1;
        return [Math.floor(s / THREADS_PER_BUNDLE_PAIR), sign, pair % LOOM.threadsPerBundle];
      },
    },
  );
}

/** Plexus loom: two opposed families of three-thread bundles strung between a low and a high glow hoop, a twisted ruled surface whose waist weaves lozenges at eye level behind the stage. The loom turns once per 360 s and the high hoop breathes on a 40 s sine. */
export function PlexusLoom({ colors, params, speed }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const bundles = Math.min(LOOM.maxBundles, Math.max(1, Math.round(params.bundles)));
  const threads = useInkRibbonGeometry(() => loomStrands(LOOM.maxBundles), []);
  const hoop = useMemo(() => {
    const g = new TorusGeometry(params.hoopRadius, LOOM.hoopTube, 10, 256);
    g.rotateX(Math.PI / 2);
    return g;
  }, [params.hoopRadius]);
  useEffect(() => () => hoop.dispose(), [hoop]);

  const mats = useLookMaterials(
    () => ({
      threads: inkRibbonMaterial({
        key: "plexus-loom/threads",
        path: THREAD_PATH,
        vertex: THREAD_VERTEX_HOOK,
        fragmentShader: THREAD_FRAGMENT,
        lineWidth: LOOM.width,
        uniforms: {
          uThreadA: lookColorUniform("#000000"),
          uThreadB: lookColorUniform("#000000"),
          uThreadC: lookColorUniform("#000000"),
          uSpin: { value: 0 },
          uBreath: { value: 0 },
          uTwist: { value: 0 },
          uRadius: { value: 16 },
          uBundles: { value: 36 },
          uHueTurn: { value: 0 },
          uOpacity: { value: 0.55 },
        },
      }),
      hoops: {
        key: "plexus-loom/hoops",
        fragmentShader: HOOP_FRAGMENT,
        transparent: true,
        uniforms: { uGlow: lookColorUniform("#000000") },
      },
    }),
    [],
  );

  const [threadA, threadB, threadC, glow] = colors;
  useLayoutEffect(() => {
    mats.threads.uniforms.uThreadA.value.set(threadA);
    mats.threads.uniforms.uThreadB.value.set(threadB);
    mats.threads.uniforms.uThreadC.value.set(threadC);
    mats.hoops.uniforms.uGlow.value.set(glow);
  }, [mats, threadA, threadB, threadC, glow]);

  useLayoutEffect(() => {
    showInkStrands(threads, bundles * THREADS_PER_BUNDLE_PAIR);
    const turn = loopSeconds(t * params.spin, LOOM.spinPeriod) / LOOM.spinPeriod;
    const breath = Math.sin((TAU * loopSeconds(t, LOOM.breathPeriod)) / LOOM.breathPeriod);
    const u = mats.threads.uniforms;
    u.uSpin.value = TAU * turn;
    u.uHueTurn.value = turn;
    u.uBreath.value = breath * params.breath * DEG;
    u.uTwist.value = params.twist * DEG;
    u.uRadius.value = params.hoopRadius;
    u.uBundles.value = bundles;
    u.uOpacity.value = params.opacity;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={threads} material={mats.threads} frustumCulled={false} />
      <mesh geometry={hoop} material={mats.hoops} position={[0, LOOM.lowY, 0]} />
      <mesh geometry={hoop} material={mats.hoops} position={[0, LOOM.highY, 0]} />
    </group>
  );
}
