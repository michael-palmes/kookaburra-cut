import { useLayoutEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide, Vector3 } from "three";
import { lookColorUniform, lookLuminance, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  ORIGAMI,
  origamiColumns,
  origamiGrid,
  origamiPhase,
  origamiRows,
  origamiSun,
} from "./origami";
import { WALL_FRAGMENT, WALL_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
/** Base tone sinks this far toward a dark backing, so a dark wall reads as folds catching light rather than a grey mass. */
const DARK_SINK = 0.65;

function wallGeometry(columns: number, rows: number): BufferGeometry {
  const { ij, index } = origamiGrid(columns, rows);
  const g = new BufferGeometry();
  // Positions come from the vertex stage; the attribute only sizes the draw.
  g.setAttribute("position", new BufferAttribute(new Float32Array((ij.length / 2) * 3), 3));
  g.setAttribute("aIJ", new BufferAttribute(ij, 2));
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}

/** Origami tide: a Miura-ori paper wall round the stage, folded in the vertex stage while two opposing waves pass a tide of deep chevrons that relax flat (Miura-ori, the Al Bahr Towers' shading units, Nils Völker). Unlit facets against a raking virtual sun. */
export function OrigamiTide({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const columns = origamiColumns(params.radius, params.pleat);
  const { rows, pitch } = useMemo(
    () => origamiRows(params.top, params.pleat),
    [params.top, params.pleat],
  );
  const geometry = useMemo(() => wallGeometry(columns, rows), [columns, rows]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const mats = useLookMaterials(
    () => ({
      wall: {
        key: "origami-tide/wall",
        vertexShader: WALL_VERTEX,
        fragmentShader: WALL_FRAGMENT,
        alphaToCoverage: true,
        side: DoubleSide,
        uniforms: {
          uPhase: { value: 0 },
          uAmp: { value: 0.8 },
          uRadius: { value: 13 },
          uStep: { value: 0.85 },
          uRowPitch: { value: 0.82 },
          uScale: { value: 1 },
          uPaper: lookColorUniform("#4e565f"),
          uShade: lookColorUniform("#20262d"),
          uBacking: lookColorUniform("#0c0f12"),
          uSun: { value: new Vector3(1, 0, 0) },
          uSink: { value: DARK_SINK },
        },
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const u = mats.wall.uniforms;
    const phase = origamiPhase(t, params.period);
    u.uPhase.value = phase;
    u.uAmp.value = params.fold;
    u.uRadius.value = params.radius;
    u.uStep.value = (Math.PI * 2 * params.radius) / columns;
    u.uRowPitch.value = pitch;
    u.uScale.value = params.pleat / ORIGAMI.refPleat;
    origamiSun(phase, params.sway, u.uSun.value as Vector3);
  });
  useLayoutEffect(() => {
    const u = mats.wall.uniforms;
    u.uPaper.value.set(colors[0]);
    u.uShade.value.set(colors[1]);
    u.uBacking.value.set(backing);
    const dark = lookLuminance(backing) < lookLuminance(colors[0]);
    u.uSink.value = dark ? DARK_SINK : 0;
  }, [mats, colors[0], colors[1], backing]);

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={geometry} material={mats.wall} frustumCulled={false} />
    </group>
  );
}
