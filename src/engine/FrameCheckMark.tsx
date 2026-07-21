import { useEffect, useMemo } from "react";
import { MeshBasicMaterial } from "three";
import type { V3 } from "../toolkit/types";
import { useHeldLocalMs } from "./presentHold";
import { useTimeline } from "./timeline";

/** An SF-Symbols `checkmark.circle` lookalike (the real symbol would need a bundled font, too much for the deterministic path): a lighter circle ring plus a full-strength check, one colour at two alpha levels, so it reads as a hierarchical two-tone symbol. Drawn as an SDF injected into a `MeshBasicMaterial` (the `ImageCard`/pill precedent, so it inherits three's colour pipeline), pure of derivatives so AA is compile-stable. */
const MARK_DEFS = /* glsl */ `
varying vec2 vMarkUv;
uniform float uMarkAA;
float frameCheckSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
`;

const MARK_FRAG = /* glsl */ `#include <opaque_fragment>
  vec2 mp = vMarkUv - 0.5;
  float ringD = abs(length(mp) - 0.4) - 0.05;
  float ringA = (1.0 - smoothstep(-uMarkAA, uMarkAA, ringD)) * 0.5;
  float d1 = frameCheckSeg(mp, vec2(-0.16, 0.0), vec2(-0.04, -0.13));
  float d2 = frameCheckSeg(mp, vec2(-0.04, -0.13), vec2(0.18, 0.14));
  float checkA = 1.0 - smoothstep(-uMarkAA, uMarkAA, min(d1, d2) - 0.05);
  gl_FragColor.a *= max(ringA, checkA);`;

function makeMarkMaterial(): { material: MeshBasicMaterial; aa: { value: number } } {
  const aa = { value: 0.018 };
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  material.toneMapped = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMarkAA = aa;
    shader.vertexShader = `varying vec2 vMarkUv;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vMarkUv = uv;",
    );
    shader.fragmentShader = `${MARK_DEFS}\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      MARK_FRAG,
    );
  };
  material.customProgramCacheKey = () => "kookaburra-frame-checkmark-v1";
  return { material, aa };
}

/** A chip's checkmark.circle mark, centre-anchored on `position`, filled with the chip's label colour and fading over the same window. */
export function FrameCheckMark({
  position,
  size,
  color,
  from,
  to,
}: {
  position: V3;
  size: number;
  color: string;
  from: number;
  to: number;
}) {
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const mark = useMemo(() => makeMarkMaterial(), []);
  useEffect(() => () => mark.material.dispose(), [mark]);
  mark.material.color.set(color);
  mark.material.opacity = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
  return (
    <mesh position={position} material={mark.material} renderOrder={2}>
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}
