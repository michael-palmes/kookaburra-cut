/** 3D columns, bars and their stacked variants: ONE shared `RoundedBoxGeometry` behind an `InstancedMesh`, one instance per mark. Per-instance transforms are composed translate x scale about each mark's base, so growth never re-parametrises the bevel and never rebuilds geometry; per-instance colour rides `setColorAt` + `instanceColor` and per-instance alpha an `instanceAlpha` attribute, both written imperatively (per-instance colour through r3f's JSX diffing is a known upstream bug). */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  Color,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { barSpan } from "./chart2dMath";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import type { Chart3DSpace } from "./space3d";
import type { ChartLayout, ChartRevealFn } from "./types";

export interface Bars3DProps {
  layout: ChartLayout;
  space: Chart3DSpace;
  /** 0..1 of half the bar's cross-section. */
  cornerRadius: number;
  colours: readonly string[];
  fallbackColour: string;
  reveal?: ChartRevealFn;
  opacity: number;
  shadows: boolean;
  roughness: number;
  metalness: number;
}

/** Corner segments on the shared box: enough to read as a bevel, cheap enough for hundreds of instances. */
const BAR_SEGMENTS = 3;
/** A hair of rounding always stays, since `RoundedBoxGeometry` derives its normals from the bevel and a zero radius would shade a box like a sphere. */
const MIN_RADIUS_FRACTION = 0.02;
const MAX_RADIUS_FRACTION = 0.5;

/** Per-instance alpha: three multiplies `instanceColor` into `vColor` for us, so only the alpha channel needs patching in. */
function applyInstanceAlpha(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float instanceAlpha;\nvarying float vChartAlpha;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvChartAlpha = instanceAlpha;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vChartAlpha;")
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.a *= vChartAlpha;",
      );
  };
  material.customProgramCacheKey = () => "kookaburra-chart-bar-alpha-v1";
}

export function Bars3D(props: Bars3DProps) {
  const {
    layout,
    space,
    cornerRadius,
    colours,
    fallbackColour,
    reveal,
    opacity,
    shadows,
    roughness,
    metalness,
  } = props;
  const meshRef = useRef<InstancedMesh>(null);
  const count = layout.bars.length;
  const vertical = layout.valueAxis === "y";

  // The shared box is baked at the mark cross-section and the FULL value span, so only the value axis ever scales anisotropically (and only downward).
  const across = vertical ? layout.barWidth * space.width : layout.barWidth * space.height;
  const boxX = vertical ? across : space.width;
  const boxY = vertical ? space.height : across;
  const boxZ = space.depth;
  const radius = useMemo(() => {
    const cross = Math.min(across, boxZ);
    const wanted = Math.max(MIN_RADIUS_FRACTION, Math.min(1, cornerRadius) * MAX_RADIUS_FRACTION);
    return Math.max(1e-5, cross * wanted);
  }, [across, boxZ, cornerRadius]);

  const geometry = useMemo(() => {
    const box = new RoundedBoxGeometry(
      Math.max(1e-4, boxX),
      Math.max(1e-4, boxY),
      Math.max(1e-4, boxZ),
      BAR_SEGMENTS,
      radius,
    );
    // `vertexColors` needs a real `color` attribute or the default generic vec3 paints every bar black; ones let three's own instance-colour multiply through untouched.
    const vertices = box.getAttribute("position").count;
    box.setAttribute("color", new BufferAttribute(new Float32Array(vertices * 3).fill(1), 3));
    box.setAttribute(
      "instanceAlpha",
      new InstancedBufferAttribute(new Float32Array(Math.max(1, count)).fill(1), 1),
    );
    return box;
  }, [boxX, boxY, boxZ, radius, count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ vertexColors: true, roughness, metalness });
    applyInstanceAlpha(m);
    return m;
  }, [roughness, metalness]);
  useEffect(() => () => material.dispose(), [material]);

  // Per-frame instance state: matrices, colours and alphas, written straight to the buffers.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const colour = new Color();
    const alphas = geometry.getAttribute("instanceAlpha") as InstancedBufferAttribute;
    let translucent = false;
    layout.bars.forEach((mark, i) => {
      const { grow, alpha } = revealAt(reveal, mark.seriesIndex, mark.categoryIndex);
      const span = barSpan(mark, layout.valueAxis, grow);
      const middle = span.lo + span.size / 2;
      const stack = layout.stacked ? mark.seriesIndex * space.stackEpsilon : 0;
      let px: number;
      let py: number;
      let sx: number;
      let sy: number;
      if (vertical) {
        px = (mark.x + mark.width / 2 - 0.5) * space.width;
        py = middle * space.height + stack;
        sx = (mark.width * space.width) / boxX;
        sy = Math.max(1e-6, span.size);
      } else {
        px = (middle - 0.5) * space.width + stack;
        py = (mark.y + mark.height / 2) * space.height;
        sx = Math.max(1e-6, span.size);
        sy = (mark.height * space.height) / boxY;
      }
      matrix.makeScale(sx, sy, 1);
      matrix.setPosition(px, py, 0);
      mesh.setMatrixAt(i, matrix);
      colour.set(chartColourAt(colours, mark.seriesIndex, fallbackColour));
      mesh.setColorAt(i, colour);
      alphas.setX(i, alpha);
      if (alpha < 1) translucent = true;
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    alphas.needsUpdate = true;
    material.opacity = opacity;
    const transparent = translucent || opacity < 1;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
  });

  if (count === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      castShadow={shadows}
      receiveShadow={shadows}
      frustumCulled={false}
    />
  );
}
