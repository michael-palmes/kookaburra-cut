import { useEffect, useMemo, useRef } from "react";
import {
  type Camera,
  type Group,
  type Mesh,
  type Object3D,
  PlaneGeometry,
  type Scene,
  type Side,
  type WebGLRenderer,
} from "three";
import { useEffectsStore } from "../../engine/effectsStore";
import { OPTICAL_MAX_LEVELS, type OpticalBlurLevel } from "./opticalBlur";
import { type CardLook, type OpticalBlurFrame, OpticalBlurPass } from "./opticalBlurPass";

type V3 = [number, number, number];

/** The project's `render.textBlur`: "optical" turns preset soften into a true gaussian defocus. */
export function useOpticalTextBlur(): boolean {
  return useEffectsStore((s) => s.renderSettings.textBlur === "optical");
}

export interface OpticalBlurCardsProps {
  frame: { current: OpticalBlurFrame };
  /** The group holding only the text meshes to capture. */
  root: { current: Object3D | null };
  levels: readonly OpticalBlurLevel[];
  position: V3;
  rotZ?: number;
  look: CardLook;
}

/** One card per σ level in the text's layout frame: each stands in for its blurred units, sampling the capture its first draw of the frame triggers. */
export function OpticalBlurCards({
  frame,
  root,
  levels,
  position,
  rotZ,
  look,
}: OpticalBlurCardsProps) {
  const { toneMapped, depthTest, side } = look;
  const pass = useMemo(
    () => new OpticalBlurPass({ toneMapped, depthTest, side: side as Side }),
    [toneMapped, depthTest, side],
  );
  useEffect(() => () => pass.dispose(), [pass]);
  const idle = levels.length === 0;
  useEffect(() => {
    if (idle) pass.release();
  }, [idle, pass]);
  const geometry = useMemo(() => new PlaneGeometry(1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const group = useRef<Group>(null);
  const onBeforeRender = useMemo(
    () => (renderer: WebGLRenderer, scene: Scene, camera: Camera) => {
      const g = group.current;
      const r = root.current;
      if (!g || !r || scene.overrideMaterial) return;
      pass.run(renderer, camera, g, r, frame.current);
    },
    [pass, frame, root],
  );
  const cards = [];
  for (let i = 0; i < OPTICAL_MAX_LEVELS; i++) {
    const level = levels[i];
    const rect = level?.rect ?? [0, 0, 1, 1];
    cards.push(
      <mesh
        key={i}
        visible={level !== undefined}
        geometry={geometry}
        material={pass.cards[i]}
        position={[(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, 0]}
        scale={[rect[2] - rect[0], rect[3] - rect[1], 1]}
        onBeforeRender={onBeforeRender as unknown as Mesh["onBeforeRender"]}
      />,
    );
  }
  return (
    <group ref={group} position={position} {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}>
      {cards}
    </group>
  );
}
