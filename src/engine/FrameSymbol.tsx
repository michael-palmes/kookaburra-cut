import { useTexture } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { MeshBasicMaterial, SRGBColorSpace, type Texture } from "three";
import { CHIP_ICON_TEXTURES, type ChipIconId } from "../toolkit/frame/chipIcons";
import type { V3 } from "../toolkit/types";
import { useHeldLocalMs } from "./presentHold";
import { useTimeline } from "./timeline";

/** A chip's mark from the bundled Lucide-derived icon set: the white icon PNG rendered as a tinted quad (`MeshBasicMaterial` map x colour, the ImageCard/decoration precedent, `toneMapped:false` so the tint lands exactly). Centre-anchored; deterministic because the texture is a fixed bundled asset. */
export function FrameSymbol({
  id,
  position,
  size,
  color,
  from,
  to,
}: {
  id: ChipIconId;
  position: V3;
  size: number;
  color: string;
  from: number;
  to: number;
}) {
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const texture = useTexture(CHIP_ICON_TEXTURES[id]) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    m.map = texture;
    return m;
  }, [texture]);
  useEffect(() => () => material.dispose(), [material]);
  material.color.set(color);
  material.opacity = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
  return (
    <mesh position={position} material={material} renderOrder={2}>
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}
