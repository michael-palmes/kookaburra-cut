import { useEffect, useRef } from "react";
import type { Group } from "three";
import { isExporting } from "../../engine/exportState";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { useImageEditStore } from "../../engine/imageEditStore";
import { SceneGizmo } from "../../engine/SceneGizmo";
import { SceneOutline } from "../../engine/SceneOutline";
import { useSceneContext } from "../../engine/sceneContext";
import type { SceneImageStagePlacement } from "../../engine/sceneDocSchema";
import { STAGE_MEDIA_SIZE_RANGE, stageImageGizmoCommit } from "./imageGizmoCommit";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const placementKey = (placement: SceneImageStagePlacement) =>
  `${placement.position.join()}|${placement.rotationDeg.join()}|${placement.size}`;

function applyPlacement(group: Group, placement: SceneImageStagePlacement): void {
  group.position.set(...placement.position);
  group.rotation.set(
    placement.rotationDeg[0] * DEG2RAD,
    placement.rotationDeg[1] * DEG2RAD,
    placement.rotationDeg[2] * DEG2RAD,
  );
  group.scale.setScalar(placement.size);
}

/** Selection outline for a Stage-hosted image. Mount inside the image's base-placement group. */
export function StageImageOutline({
  imageId,
  sceneIndex,
  localSize,
}: {
  imageId: string;
  sceneIndex: number;
  /** The unscaled card size, normally `[1, 1 / sourceAspect]`. */
  localSize: readonly [number, number];
}) {
  const context = useSceneContext();
  const selected = useImageEditStore((state) => state.selected);
  const editable = context?.index === sceneIndex && context.side === undefined && !isExporting();
  if (!editable) return null;
  const target = { sceneIndex, imageId };
  return (
    <SceneOutline
      size={[localSize[0], localSize[1], 0]}
      domain="media"
      selected={selected?.sceneIndex === sceneIndex && selected.imageId === imageId}
      onSelect={() => useImageEditStore.getState().select(target)}
    />
  );
}

/** The editor-only 3D transform proxy for a Stage-hosted image. Mount as a sibling of the rendered placement group. */
export function StageImageGizmo({
  imageId,
  sceneIndex,
  committed,
  windowed = false,
}: {
  imageId: string;
  sceneIndex: number;
  committed: SceneImageStagePlacement;
  /** Windowed media drags within the wider window range, not the still image one. */
  windowed?: boolean;
}) {
  const context = useSceneContext();
  const selected = useImageEditStore((state) => state.selected);
  const mode = useImageEditStore((state) => state.gizmoMode);
  const sectionOpen = useGizmoSectionOpen("media");
  const proxyRef = useRef<Group>(null);
  const dragging = useRef(false);
  const synced = useRef<string | null>(null);
  const previousCommitted = useRef<string | null>(null);
  const editable = context?.index === sceneIndex && context.side === undefined && !isExporting();
  const active =
    editable && sectionOpen && selected?.sceneIndex === sceneIndex && selected.imageId === imageId;
  const key = placementKey(committed);

  useEffect(() => {
    const previous = previousCommitted.current;
    previousCommitted.current = key;
    if (previous === null || previous === key) return;
    const preview = useImageEditStore.getState().previewPlacement;
    if (preview?.sceneIndex === sceneIndex && preview.imageId === imageId) {
      useImageEditStore.getState().clearPreview();
    }
  }, [imageId, key, sceneIndex]);

  useEffect(() => {
    const group = proxyRef.current;
    if (!group || dragging.current || synced.current === key) return;
    synced.current = key;
    applyPlacement(group, committed);
  });

  useEffect(
    () => () => {
      const preview = useImageEditStore.getState().previewPlacement;
      if (preview?.sceneIndex === sceneIndex && preview.imageId === imageId) {
        useImageEditStore.getState().clearPreview();
      }
    },
    [imageId, sceneIndex],
  );

  if (!active) return null;

  const read = () => {
    const group = proxyRef.current;
    if (!group) return null;
    return stageImageGizmoCommit(
      sceneIndex,
      imageId,
      {
        position: [group.position.x, group.position.y, group.position.z],
        rotationDeg: [
          group.rotation.x * RAD2DEG,
          group.rotation.y * RAD2DEG,
          group.rotation.z * RAD2DEG,
        ],
        size: group.scale.x,
      },
      windowed ? STAGE_MEDIA_SIZE_RANGE.window : STAGE_MEDIA_SIZE_RANGE.image,
    );
  };

  const uniformiseScale = (group: Group) => {
    const base = committed.size;
    if (base <= 1e-6) return;
    let factor = 1;
    for (const ratio of [group.scale.x / base, group.scale.y / base, group.scale.z / base]) {
      if (
        Math.abs(Math.log(Math.max(1e-3, Math.abs(ratio)))) > Math.abs(Math.log(Math.abs(factor)))
      ) {
        factor = ratio;
      }
    }
    group.scale.setScalar(Math.max(0.05, Math.abs(factor) * base));
  };

  const change = () => {
    const group = proxyRef.current;
    if (!group) return;
    dragging.current = true;
    if (mode === "scale") uniformiseScale(group);
    const preview = read();
    if (preview?.kind !== "stage") return;
    applyPlacement(group, preview.placement);
    useImageEditStore.getState().preview(preview);
  };

  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const pending = read();
    if (pending) useImageEditStore.getState().requestCommit(pending);
  };

  return (
    <>
      <group ref={proxyRef} />
      <SceneGizmo
        object={proxyRef}
        mode={mode}
        domain="media"
        itemId={imageId}
        sceneIndex={sceneIndex}
        onObjectChange={change}
        onMouseUp={commit}
      />
    </>
  );
}
