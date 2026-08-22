import { useTexture } from "@react-three/drei";
import { useContext, useLayoutEffect, useMemo } from "react";
import {
  DoubleSide,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  RGBADepthPacking,
  SRGBColorSpace,
  type Texture,
} from "three";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { frameLayerRenderOrder } from "../../engine/frameLayerOrder";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { useImageOverlayPreview, useImageStagePreview } from "../../engine/imageEditStore";
import { resolveAssetUrl } from "../../engine/project";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import type {
  SceneDocImageSpec,
  SceneImageMotionSpec,
  SceneImageOverlayPlacement,
  SceneImageStagePlacement,
} from "../../engine/sceneDocSchema";
import {
  type SceneImageMotionSample,
  sampleSceneImageMotion,
  sceneImagesForHost,
} from "../../engine/sceneImage";
import {
  useSceneConsumesStageImages,
  useStageImageRegistry,
} from "../../engine/stageImageRegistry";
import { useTimeline } from "../../engine/timeline";
import { assetVersionKey, useAssetVersionStore } from "../../store/assetVersionStore";
import { useEditorStore } from "../../store/editorStore";
import { useStageMapShadows } from "../stage/context";
import type { FormatInfo } from "../types";
import { AssetBoundary } from "./AssetBoundary";
import { StageImageGizmo, StageImageOutline } from "./StageImageGizmo";

const DEG2RAD = Math.PI / 180;
const IMAGE_ALPHA_TEST = 1 / 255;

export interface StageImageTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  size: number;
  opacity: number;
}

export interface OverlayImageTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  width: number;
  height: number;
  opacity: number;
  renderOrder: number;
}

export function sampleRenderedSceneImageMotion(
  motion: SceneImageMotionSpec | undefined,
  host: "stage" | "overlay",
  localMs: number,
  editorOwnsImages: boolean,
): SceneImageMotionSample {
  return sampleSceneImageMotion(editorOwnsImages ? undefined : motion, host, localMs);
}

export function shouldNeutraliseSceneImageMotion(
  sectionOpen: boolean,
  exporting: boolean,
): boolean {
  return sectionOpen && !exporting;
}

export function createStageImageShadowMaterials(texture: Texture): {
  depth: MeshDepthMaterial;
  distance: MeshDistanceMaterial;
} {
  return {
    depth: new MeshDepthMaterial({
      depthPacking: RGBADepthPacking,
      map: texture,
      alphaTest: IMAGE_ALPHA_TEST,
      side: DoubleSide,
    }),
    distance: new MeshDistanceMaterial({
      map: texture,
      alphaTest: IMAGE_ALPHA_TEST,
      side: DoubleSide,
    }),
  };
}

export function resolveStageImageTransform(
  placement: SceneImageStagePlacement,
  motion: SceneImageMotionSample,
): StageImageTransform {
  return {
    position: [
      placement.position[0] + motion.position[0],
      placement.position[1] + motion.position[1],
      placement.position[2] + motion.position[2],
    ],
    rotation: [
      (placement.rotationDeg[0] + motion.rotationDeg[0]) * DEG2RAD,
      (placement.rotationDeg[1] + motion.rotationDeg[1]) * DEG2RAD,
      (placement.rotationDeg[2] + motion.rotationDeg[2]) * DEG2RAD,
    ],
    size: placement.size * motion.scale,
    opacity: motion.opacity,
  };
}

export function resolveOverlayImageTransform(
  placement: SceneImageOverlayPlacement,
  motion: SceneImageMotionSample,
  format: FormatInfo,
  sourceAspect: number,
  stackOrder: number,
): OverlayImageTransform {
  const width = placement.size * format.frame.width * motion.scale;
  return {
    position: [
      ((placement.position[0] + motion.position[0]) * format.frame.width) / 2,
      ((placement.position[1] + motion.position[1]) * format.frame.height) / 2,
      motion.position[2],
    ],
    rotation: [
      motion.rotationDeg[0] * DEG2RAD,
      motion.rotationDeg[1] * DEG2RAD,
      -(placement.rotationDeg + motion.rotationDeg[2]) * DEG2RAD,
    ],
    width,
    height: placement.shape === "circle" ? width : width / sourceAspect,
    opacity: motion.opacity,
    renderOrder: frameLayerRenderOrder(placement.layer, stackOrder),
  };
}

export function resolveOverlayImageStackOrders(
  images: readonly SceneDocImageSpec[],
  orderStart: number,
): number[] {
  let fallback = images.reduce(
    (next, image) =>
      image.overlay.stackOrder === undefined ? next : Math.max(next, image.overlay.stackOrder + 1),
    orderStart,
  );
  return images.map((image) => image.overlay.stackOrder ?? fallback++);
}

function sourceAspect(texture: Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 1;
  const height = image?.height ?? 1;
  return width > 0 && height > 0 ? width / height : 1;
}

function useSceneImageUrl(src: string): string | null {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((state) => state.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const version = useAssetVersionStore(
    (state) => state.versions[assetVersionKey(projectId, src)] ?? 0,
  );
  try {
    const url = resolveAssetUrl(projectId, src);
    return version > 0 ? `${url}?v=${version}` : url;
  } catch (error) {
    console.warn(`[image] "${src}" unresolved:`, error);
    return null;
  }
}

function useColourTexture(url: string): Texture {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  return texture;
}

function applyCircleMask(material: MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec2 vSceneImageUv;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vSceneImageUv = uv;",
    );
    shader.fragmentShader = `varying vec2 vSceneImageUv;\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `#include <opaque_fragment>
      float sceneImageD = length(vSceneImageUv - 0.5) - 0.5;
      gl_FragColor.a *= 1.0 - smoothstep(-0.01, 0.01, sceneImageD);`,
    );
  };
  material.customProgramCacheKey = () => "kookaburra-scene-image-circle-v1";
}

function StageImage({ image, mapShadows }: { image: SceneDocImageSpec; mapShadows: boolean }) {
  const url = useSceneImageUrl(image.src);
  const context = useSceneContext();
  const sceneIndex = context?.index ?? -1;
  const exporting = isExporting();
  const editable = context?.side === undefined && !exporting;
  const sectionOpen = useGizmoSectionOpen("images");
  const preview = useImageStagePreview(sceneIndex, image.id, editable);
  const { localMs } = useTimeline();
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={image.src}>
      <LoadedStageImage
        image={image}
        url={url}
        placement={preview ?? image.stage}
        motion={sampleRenderedSceneImageMotion(
          image.motion,
          "stage",
          localMs,
          shouldNeutraliseSceneImageMotion(sectionOpen, exporting),
        )}
        sceneIndex={sceneIndex}
        castShadow={mapShadows && image.castShadow === true}
      />
    </AssetBoundary>
  );
}

function LoadedStageImage({
  image,
  url,
  placement,
  motion,
  sceneIndex,
  castShadow,
}: {
  image: SceneDocImageSpec;
  url: string;
  placement: SceneImageStagePlacement;
  motion: SceneImageMotionSample;
  sceneIndex: number;
  castShadow: boolean;
}) {
  const texture = useColourTexture(url);
  const aspect = sourceAspect(texture);
  const transform = resolveStageImageTransform(placement, motion);
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: IMAGE_ALPHA_TEST,
      depthWrite: true,
      side: DoubleSide,
    });
    next.shadowSide = DoubleSide;
    next.toneMapped = false;
    return next;
  }, [texture]);
  const shadowMaterials = useMemo(
    () => (castShadow ? createStageImageShadowMaterials(texture) : null),
    [castShadow, texture],
  );
  useLayoutEffect(
    () => () => {
      material.dispose();
      shadowMaterials?.depth.dispose();
      shadowMaterials?.distance.dispose();
    },
    [material, shadowMaterials],
  );
  material.opacity = transform.opacity;

  const baseRotation: [number, number, number] = [
    placement.rotationDeg[0] * DEG2RAD,
    placement.rotationDeg[1] * DEG2RAD,
    placement.rotationDeg[2] * DEG2RAD,
  ];

  return (
    <>
      <group position={transform.position} rotation={transform.rotation} scale={transform.size}>
        <mesh
          material={material}
          castShadow={castShadow}
          customDepthMaterial={shadowMaterials?.depth}
          customDistanceMaterial={shadowMaterials?.distance}
        >
          <planeGeometry args={[1, 1 / aspect]} />
        </mesh>
      </group>
      <group position={placement.position} rotation={baseRotation} scale={placement.size}>
        <StageImageOutline imageId={image.id} sceneIndex={sceneIndex} localSize={[1, 1 / aspect]} />
      </group>
      <StageImageGizmo imageId={image.id} sceneIndex={sceneIndex} committed={image.stage} />
    </>
  );
}

function OverlayImage({ image, stackOrder }: { image: SceneDocImageSpec; stackOrder: number }) {
  const url = useSceneImageUrl(image.src);
  const context = useSceneContext();
  const sceneIndex = context?.index ?? -1;
  const exporting = isExporting();
  const editable = context?.side === undefined && !exporting;
  const sectionOpen = useGizmoSectionOpen("images");
  const preview = useImageOverlayPreview(sceneIndex, image.id, editable);
  const { localMs } = useTimeline();
  const format = useFormat();
  if (!url) return null;
  return (
    <AssetBoundary key={url} label={image.src}>
      <LoadedOverlayImage
        url={url}
        placement={preview ?? image.overlay}
        motion={sampleRenderedSceneImageMotion(
          image.motion,
          "overlay",
          localMs,
          shouldNeutraliseSceneImageMotion(sectionOpen, exporting),
        )}
        format={format}
        stackOrder={stackOrder}
      />
    </AssetBoundary>
  );
}

function LoadedOverlayImage({
  url,
  placement,
  motion,
  format,
  stackOrder,
}: {
  url: string;
  placement: SceneImageOverlayPlacement;
  motion: SceneImageMotionSample;
  format: FormatInfo;
  stackOrder: number;
}) {
  const texture = useColourTexture(url);
  const transform = resolveOverlayImageTransform(
    placement,
    motion,
    format,
    sourceAspect(texture),
    stackOrder,
  );
  const circle = placement.shape === "circle";
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    next.toneMapped = false;
    if (circle) applyCircleMask(next);
    return next;
  }, [circle, texture]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  material.opacity = transform.opacity;

  return (
    <mesh
      position={transform.position}
      rotation={transform.rotation}
      material={material}
      renderOrder={transform.renderOrder}
    >
      <planeGeometry args={[transform.width, transform.height]} />
    </mesh>
  );
}

export function StageSceneImages() {
  const doc = useContext(SceneDocContext) ?? undefined;
  const sceneIndex = useSceneContext()?.index;
  const images = sceneImagesForHost(doc, "stage");
  const mapShadows = useStageMapShadows();
  useLayoutEffect(() => {
    if (sceneIndex === undefined || images.length === 0) return;
    useStageImageRegistry.getState().register(sceneIndex);
    return () => useStageImageRegistry.getState().unregister(sceneIndex);
  }, [images.length, sceneIndex]);
  if (images.length === 0) return null;
  return (
    <>
      {images.map((image) => (
        <StageImage key={image.id} image={image} mapShadows={mapShadows} />
      ))}
    </>
  );
}

export function StageSceneImagesFallback() {
  const doc = useContext(SceneDocContext) ?? undefined;
  const sceneIndex = useSceneContext()?.index;
  const images = sceneImagesForHost(doc, "stage");
  if (images.length === 0) return null;
  return <StageSceneImagesFallbackContent images={images} sceneIndex={sceneIndex} />;
}

function StageSceneImagesFallbackContent({
  images,
  sceneIndex,
}: {
  images: readonly SceneDocImageSpec[];
  sceneIndex: number | undefined;
}) {
  const consumed = useSceneConsumesStageImages(sceneIndex);
  if (consumed) return null;
  return (
    <>
      {images.map((image) => (
        <StageImage key={image.id} image={image} mapShadows={false} />
      ))}
    </>
  );
}

export function OverlaySceneImages({ orderStart }: { orderStart: number }) {
  const doc = useContext(SceneDocContext) ?? undefined;
  const images = sceneImagesForHost(doc, "overlay");
  if (images.length === 0) return null;
  const stackOrders = resolveOverlayImageStackOrders(images, orderStart);
  return (
    <>
      {images.map((image, index) => (
        <OverlayImage key={image.id} image={image} stackOrder={stackOrders[index]} />
      ))}
    </>
  );
}
