import { Text } from "@react-three/drei";
import type { ComponentType } from "react";
import { type Camera, type Group, Matrix4, type Object3D, type PerspectiveCamera } from "three";
import { fontUrl, SDF_GLYPH_SIZE } from "../theme/fonts";
import { materialProp, useExactTextBase } from "../toolkit/text/exactText";
import type { SceneModule } from "../toolkit/types";
import { CAMERA, useFormat } from "./format";
import { errorHeadline } from "./sceneErrors";

const CARD_BACKING = "#16181d";
const CARD_TITLE = "#ece7de";
const CARD_DETAIL = "#a3abb6";

const cardComponents = new WeakSet<ComponentType>();

/** True for the stand-in `loadProject` mounts in place of a scene that failed to load. */
export function isSceneErrorCard(scene: SceneModule): boolean {
  return cardComponents.has(scene.Scene);
}

const lockOffset = new Matrix4().makeTranslation(0, 0, -(CAMERA.position[2] - CAMERA.contentZ));
const lockScale = new Matrix4();

/** Pins the card to the live camera before each draw (the FixedBackdrop pattern), so a sidecar camera move can't carry it out of frame; a pure function of the camera, so deterministic. */
function lockToCamera(card: Group, camera: Camera): void {
  const fov = (camera as PerspectiveCamera).isPerspectiveCamera
    ? (camera as PerspectiveCamera).fov
    : CAMERA.fov;
  const scale = Math.tan((fov * Math.PI) / 360) / Math.tan((CAMERA.fov * Math.PI) / 360);
  card.matrixWorld
    .copy(camera.matrixWorld)
    .multiply(lockOffset)
    .multiply(lockScale.makeScale(scale, scale, 1));
  for (const child of card.children) child.updateMatrixWorld(true);
}

function SceneErrorCardView({ file, detail }: { file: string; detail: string }) {
  const format = useFormat();
  const { width, height } = format.frame;
  const column = Math.min(width - format.safe.left - format.safe.right, height * 1.5);
  const titleSize = Math.min(height * 0.07, column / 11);
  const detailSize = titleSize * 0.46;
  const left = -column / 2;
  const exactBase = useExactTextBase();
  return (
    <group>
      <mesh
        position={[0, 0, -0.02]}
        frustumCulled={false}
        renderOrder={-1}
        onBeforeRender={function (this: Object3D, _renderer, _scene, camera) {
          if (this.parent) lockToCamera(this.parent as Group, camera);
        }}
      >
        <planeGeometry args={[width * 1.2, height * 1.2]} />
        <meshBasicMaterial color={CARD_BACKING} toneMapped={false} />
      </mesh>
      <Text
        font={fontUrl({ family: "Inter", weight: 600 })}
        fontSize={titleSize}
        color={CARD_TITLE}
        anchorX="left"
        anchorY="bottom"
        maxWidth={column}
        position={[left, titleSize * 0.35, 0]}
        frustumCulled={false}
        {...materialProp(exactBase)}
        sdfGlyphSize={SDF_GLYPH_SIZE}
      >
        This scene can’t load
      </Text>
      <Text
        font={fontUrl({ family: "Inter", weight: 400 })}
        fontSize={detailSize}
        color={CARD_DETAIL}
        anchorX="left"
        anchorY="top"
        maxWidth={column}
        lineHeight={1.4}
        overflowWrap="break-word"
        position={[left, -titleSize * 0.2, 0]}
        frustumCulled={false}
        {...materialProp(exactBase)}
        sdfGlyphSize={SDF_GLYPH_SIZE}
      >
        {detail ? `${file}\n${detail}` : file}
      </Text>
    </group>
  );
}

/** The deterministic WebGL stand-in for a scene that failed to read, compile, evaluate or export `defineScene`: bundled Inter only (never the project's fonts), laid out against `useFormat`, keeping the manifest's duration so the timeline doesn't move. */
export function sceneErrorCard(input: {
  file: string;
  message: string;
  durationMs: number;
}): SceneModule {
  const detail = errorHeadline(input.message);
  const Scene = () => <SceneErrorCardView file={input.file} detail={detail} />;
  cardComponents.add(Scene);
  return { id: `error:${input.file}`, durationMs: input.durationMs, Scene };
}
