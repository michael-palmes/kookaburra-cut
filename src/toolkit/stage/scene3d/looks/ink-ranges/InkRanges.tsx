import { useLayoutEffect, useMemo } from "react";
import { createRingBandsGeometry, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { inkMaterialSpecs, writeInkFrame, writeInkPalette } from "./materials";
import { INK_BANDS, INK_FLOOR, INK_RIDGES } from "./ranges";

/** Ink ranges: shan shui ridge bands wrapped round the stage as one F5 ring stack (sky wall, valley floor, five ridges drawn far to near), counter-rotating at whole turns per hour so the layers slide past each other like a crankie scroll. */
export function InkRanges({ colors, params, speed }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const geometry = useMemo(() => createRingBandsGeometry(INK_BANDS, { floor: INK_FLOOR }), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const mats = useLookMaterials(inkMaterialSpecs, []);
  const materials = useMemo(
    () => [mats.sky, ...INK_RIDGES.map(() => mats.ridge), mats.floor],
    [mats],
  );

  const [near, far, mist, sun] = colors;
  useLayoutEffect(() => {
    writeInkPalette(mats, [near, far, mist, sun], params.layers);
  }, [mats, near, far, mist, sun, params.layers]);
  useLayoutEffect(() => writeInkFrame(mats, params, t));

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={geometry} material={materials} frustumCulled={false} />
    </group>
  );
}
