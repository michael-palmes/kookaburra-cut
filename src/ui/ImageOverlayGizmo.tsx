import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { computeFormat } from "../engine/format";
import type { StageRect } from "../engine/gizmoRegistry";
import { useGizmoSectionOpen } from "../engine/gizmoSections";
import { useImageEditStore } from "../engine/imageEditStore";
import { mediaMeta } from "../engine/media";
import {
  isWorkspaceProjectId,
  type LoadedProject,
  resolveAssetUrl,
  workspaceSlug,
} from "../engine/project";
import type {
  SceneDocMediaSpec,
  SceneImageOverlayPlacement,
  SceneMediaKind,
} from "../engine/sceneDocSchema";
import { resolveSceneDocMedia, sceneMediaForHost } from "../engine/sceneMedia";
import { assetVersionKey, useAssetVersionStore } from "../store/assetVersionStore";
import { useEditorStore } from "../store/editorStore";
import {
  OVERLAY_MEDIA_SIZE_RANGE,
  overlayImageGizmoCommit,
} from "../toolkit/media/imageGizmoCommit";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import { frameGuideLines, type Pt } from "./gizmo/gizmo2dMath";

/** What a video entry's box falls back to before its clip's intrinsics are recorded on the doc. */
const DEFAULT_VIDEO_ASPECT = 16 / 9;

function centrePx(placement: SceneImageOverlayPlacement, rect: StageRect): Pt {
  return [
    rect.left + ((placement.position[0] + 1) / 2) * rect.width,
    rect.top + ((1 - placement.position[1]) / 2) * rect.height,
  ];
}

/** A clip drags within the window range wherever its chrome stands, a still within the image one: the ranges follow the sizing rule each kind renders by. */
const sizeRange = (entry: SceneDocMediaSpec): readonly [number, number] =>
  entry.kind === "video" ? OVERLAY_MEDIA_SIZE_RANGE.window : OVERLAY_MEDIA_SIZE_RANGE.image;

function decodeImageAspect(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const loader = new Image();
    loader.onload = () =>
      resolve(loader.naturalHeight > 0 ? loader.naturalWidth / loader.naturalHeight : null);
    loader.onerror = () => resolve(null);
    loader.src = url;
  });
}

/** An overlay still's pixel aspect, from the same `media_meta` probe the inspector reads (cached per asset by content hash), falling back to a decode for a project outside the workspace. Null when neither answers, which keeps that item's box off the layer instead of guessing a square. */
async function probeImageAspect(
  projectId: string,
  src: string,
  suffix: string,
): Promise<number | null> {
  if (isWorkspaceProjectId(projectId)) {
    try {
      const meta = await mediaMeta(workspaceSlug(projectId), src);
      if (meta.width > 0 && meta.height > 0) return meta.width / meta.height;
    } catch {
      // The decode below is the fallback.
    }
  }
  try {
    return await decodeImageAspect(resolveAssetUrl(projectId, src) + suffix);
  } catch {
    return null;
  }
}

/** Module-level so StrictMode's mount, cleanup, remount re-attaches to the same probe instead of marking it requested and dropping the result (the batch 26 eyedropper failure shape). */
const imageAspectCache = new Map<string, number>();
const imageAspectInFlight = new Map<string, Promise<number | null>>();

function fetchImageAspect(
  projectId: string,
  src: string,
  suffix: string,
  key: string,
): Promise<number | null> {
  const cached = imageAspectCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let flight = imageAspectInFlight.get(key);
  if (!flight) {
    flight = probeImageAspect(projectId, src, suffix).then((aspect) => {
      imageAspectInFlight.delete(key);
      if (aspect !== null) imageAspectCache.set(key, aspect);
      return aspect;
    });
    imageAspectInFlight.set(key, flight);
  }
  return flight;
}

/** One Overlay entry's box in stage pixels, matching what the renderer draws: a clip fits INSIDE a box that is `size` of the frame (the window rule, so a clip narrower than the frame shrinks), while a still's `size` IS its width and its height follows the source aspect (or the width, cropped to a circle). */
export function overlayMediaGizmoBox(
  kind: SceneMediaKind,
  placement: SceneImageOverlayPlacement,
  sourceAspect: number,
  frameAspect: number,
  rect: { width: number; height: number },
): { width: number; height: number } {
  const fit = kind === "video" ? Math.min(1, sourceAspect / frameAspect) : 1;
  const width = placement.size * fit * rect.width;
  return {
    width,
    height:
      placement.shape === "circle"
        ? width
        : placement.size * fit * (frameAspect / sourceAspect) * rect.height,
  };
}

function positionAt(px: Pt, rect: StageRect): [number, number] {
  return [(2 * (px[0] - rect.left)) / rect.width - 1, 1 - (2 * (px[1] - rect.top)) / rect.height];
}

interface StartedGesture {
  id: string;
  kind: Gizmo2DGesture["kind"];
  image: SceneDocMediaSpec;
}

/** Editor-only direct manipulation for Overlay-hosted images. Mount above the canvas under the same workspace/export/autorun guards as the other 2D gizmos. */
export function OverlayImageGizmo({
  project,
  sceneIndex,
}: {
  project: LoadedProject;
  sceneIndex: number;
}) {
  const sectionOpen = useGizmoSectionOpen("media");
  const selected = useImageEditStore((state) => state.selected);
  const livePlacement = useImageEditStore((state) =>
    state.previewPlacement?.sceneIndex === sceneIndex && state.previewPlacement.kind === "overlay"
      ? state.previewPlacement
      : null,
  );
  const cameraArmed = useCameraEditStore((state) => state.armedTool !== null);
  const formatSpec = useEditorStore((state) => state.format);
  const format = useMemo(() => computeFormat(formatSpec), [formatSpec]);
  const [sourceAspects, setSourceAspects] = useState<Record<string, number>>({});
  const images = useMemo(
    () => sceneMediaForHost(resolveSceneDocMedia(project.sceneDocs[sceneIndex]), "overlay"),
    [project.sceneDocs, sceneIndex],
  );
  const versionSignal = useAssetVersionStore((state) =>
    images.map((image) => state.versions[assetVersionKey(project.id, image.src)] ?? 0).join("|"),
  );

  const sourceRequests = useMemo(() => {
    const versions = versionSignal.split("|").map(Number);
    return Object.fromEntries(
      images.map((image, index) => {
        const version = versions[index] ?? 0;
        const suffix = version > 0 ? `?v=${version}` : "";
        return [
          image.id,
          {
            src: image.src,
            key: `${project.id}\u0000${image.src}${suffix}`,
            suffix,
            video: image.kind === "video",
          },
        ];
      }),
    );
  }, [images, project.id, versionSignal]);

  useEffect(() => {
    let alive = true;
    for (const request of Object.values(sourceRequests)) {
      // A clip has no decodable intrinsics here; video entries size off their recorded `video.aspect`.
      if (request.video) continue;
      void fetchImageAspect(project.id, request.src, request.suffix, request.key).then((aspect) => {
        if (alive && aspect !== null) {
          setSourceAspects((current) =>
            current[request.key] === aspect ? current : { ...current, [request.key]: aspect },
          );
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [project.id, sourceRequests]);

  const previousCommitted = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    const next = Object.fromEntries(
      images.map((image) => [
        image.id,
        `${image.overlay.position.join()},${image.overlay.size},${image.overlay.rotationDeg}`,
      ]),
    );
    const previous = previousCommitted.current;
    previousCommitted.current = next;
    if (previous === null) return;
    const preview = useImageEditStore.getState().previewPlacement;
    if (
      preview?.sceneIndex === sceneIndex &&
      preview.kind === "overlay" &&
      previous[preview.imageId] !== next[preview.imageId]
    ) {
      useImageEditStore.getState().clearPreview();
    }
  }, [images, sceneIndex]);
  useEffect(
    () => () => {
      const preview = useImageEditStore.getState().previewPlacement;
      if (preview?.sceneIndex === sceneIndex && preview.kind === "overlay") {
        useImageEditStore.getState().clearPreview();
      }
    },
    [sceneIndex],
  );

  const items = useMemo<Gizmo2DItem[]>(
    () =>
      images.flatMap((image) => {
        const video = image.kind === "video";
        // A still's aspect comes from the probe; until it lands the item stays off the layer rather than drawing a square box over a portrait screenshot.
        const sourceAspect = video
          ? (image.video?.aspect ?? DEFAULT_VIDEO_ASPECT)
          : sourceAspects[sourceRequests[image.id]?.key ?? ""];
        if (sourceAspect === undefined && image.overlay.shape !== "circle") return [];
        const aspect = sourceAspect ?? 1;
        return [
          {
            id: image.id,
            label: video ? "Video" : "Image",
            can: { move: true, resize: true, rotate: true },
            frame: (rect: StageRect) => {
              const placement =
                livePlacement?.imageId === image.id ? livePlacement.placement : image.overlay;
              const [cx, cy] = centrePx(placement, rect);
              const box = overlayMediaGizmoBox(image.kind, placement, aspect, format.aspect, rect);
              return {
                cx,
                cy,
                w: box.width,
                h: box.height,
                deg: placement.rotationDeg,
                pivot: [cx, cy] as Pt,
              };
            },
          },
        ];
      }),
    [format.aspect, images, livePlacement, sourceAspects, sourceRequests],
  );

  const frameGuides = useCallback(
    (rect: StageRect) => {
      const scale = rect.width / format.frame.width;
      return frameGuideLines(rect, {
        left: format.safe.left * scale,
        right: format.safe.right * scale,
        top: format.safe.top * scale,
        bottom: format.safe.bottom * scale,
      });
    },
    [format],
  );

  const run = useRef<StartedGesture | null>(null);
  const pending = useRef<ReturnType<typeof overlayImageGizmoCommit> | null>(null);

  const onGesture = (gesture: Gizmo2DGesture) => {
    let started = run.current;
    if (!started || started.id !== gesture.id || started.kind !== gesture.kind) {
      const image = images.find((candidate) => candidate.id === gesture.id);
      if (!image) return;
      const rendered =
        livePlacement?.imageId === image.id
          ? { ...image, overlay: livePlacement.placement }
          : image;
      started = { id: image.id, kind: gesture.kind, image: structuredClone(rendered) };
      run.current = started;
      pending.current = null;
    }
    const base = started.image.overlay;
    let placement: SceneImageOverlayPlacement;
    if (gesture.kind === "move") {
      const centre = centrePx(base, gesture.rect);
      placement = {
        ...base,
        position: positionAt([centre[0] + gesture.dxPx, centre[1] + gesture.dyPx], gesture.rect),
      };
    } else if (gesture.kind === "resize") {
      const resized = overlayImageGizmoCommit(
        sceneIndex,
        gesture.id,
        { ...base, size: base.size * gesture.factor },
        sizeRange(started.image),
      );
      const size = resized.kind === "overlay" ? resized.placement.size : base.size;
      const ratio = size / base.size;
      placement = {
        ...base,
        position: positionAt(
          [
            gesture.fixedPx[0] + (ratio * gesture.diagPx[0]) / 2,
            gesture.fixedPx[1] + (ratio * gesture.diagPx[1]) / 2,
          ],
          gesture.rect,
        ),
        size,
      };
    } else {
      placement = { ...base, rotationDeg: gesture.deg };
    }
    const preview = overlayImageGizmoCommit(
      sceneIndex,
      gesture.id,
      placement,
      sizeRange(started.image),
    );
    pending.current = preview;
    useImageEditStore.getState().preview(preview);
  };

  const onGestureEnd = (gesture: Gizmo2DGesture | null) => {
    const commit = pending.current;
    run.current = null;
    pending.current = null;
    if (!gesture || !commit) return;
    useImageEditStore.getState().requestCommit(commit);
  };

  if (!sectionOpen) return null;
  return (
    <Gizmo2D
      items={items}
      domain="media"
      selectedId={selected?.sceneIndex === sceneIndex ? selected.imageId : null}
      onSelect={(imageId) =>
        useImageEditStore.getState().select(imageId ? { sceneIndex, imageId } : null)
      }
      resizeAbout="opposite-corner"
      frameGuides={frameGuides}
      onGesture={onGesture}
      onGestureEnd={onGestureEnd}
      cameraArmed={cameraArmed}
    />
  );
}
