import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { computeFormat } from "../engine/format";
import { resolveCutoutRender } from "../engine/frameFormat";
import type { StageRect } from "../engine/gizmoRegistry";
import { useGizmoSectionOpen } from "../engine/gizmoSections";
import { useImageEditStore } from "../engine/imageEditStore";
import { mediaMeta } from "../engine/media";
import {
  isEditableProjectId,
  type LoadedProject,
  nativeProjectSlug,
  resolveAssetUrl,
} from "../engine/project";
import type {
  SceneDocMediaSpec,
  SceneImageOverlayPlacement,
  SceneMediaHost,
} from "../engine/sceneDocSchema";
import { resolveSceneDocMedia, sceneMediaOverlayPlaced } from "../engine/sceneMedia";
import { cutoutStageRect, frameWorldCutout } from "../engine/stageViewport";
import { assetVersionKey, useAssetVersionStore } from "../store/assetVersionStore";
import { useEditorStore } from "../store/editorStore";
import {
  OVERLAY_MEDIA_SIZE_RANGE,
  overlayImageGizmoCommit,
} from "../toolkit/media/imageGizmoCommit";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import { frameGuideLines, type Pt } from "./gizmo/gizmo2dMath";

/** What a video entry's box falls back to before either the doc's recorded aspect or the native probe answers. */
const DEFAULT_VIDEO_ASPECT = 16 / 9;

function centrePx(placement: SceneImageOverlayPlacement, rect: StageRect): Pt {
  return [
    rect.left + ((placement.position[0] + 1) / 2) * rect.width,
    rect.top + ((1 - placement.position[1]) / 2) * rect.height,
  ];
}

/** A window-hosted entry drags within the window range, a frame-layer one within the image range: the ranges follow the sizing rule each HOST renders by, since that is what decides whether `size` is a box to fit inside or the width itself. */
const sizeRange = (entry: SceneDocMediaSpec): readonly [number, number] =>
  entry.host === "window" ? OVERLAY_MEDIA_SIZE_RANGE.window : OVERLAY_MEDIA_SIZE_RANGE.image;

function decodeImageAspect(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const loader = new Image();
    loader.onload = () =>
      resolve(loader.naturalHeight > 0 ? loader.naturalWidth / loader.naturalHeight : null);
    loader.onerror = () => resolve(null);
    loader.src = url;
  });
}

/** An overlay source's pixel aspect, from the same `media_meta` probe the inspector reads (cached per asset by content hash), falling back to an image decode for a project outside the workspace. Null when neither answers, which keeps a still's box off the layer instead of guessing a square. */
async function probeImageAspect(
  projectId: string,
  src: string,
  suffix: string,
): Promise<number | null> {
  if (isEditableProjectId(projectId)) {
    try {
      const meta = await mediaMeta(nativeProjectSlug(projectId), src);
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

/** One overlay-placed entry's box in stage pixels, matching what the renderer draws: a window-hosted entry fits INSIDE a box that is `size` of the frame (the window rule, so a clip narrower than the frame shrinks), while a frame-layer entry's `size` IS its width and its height follows the source aspect (or the width, cropped to a circle). */
export function overlayMediaGizmoBox(
  host: SceneMediaHost,
  placement: SceneImageOverlayPlacement,
  sourceAspect: number,
  frameAspect: number,
  rect: { width: number; height: number },
): { width: number; height: number } {
  const fit = host === "window" ? Math.min(1, sourceAspect / frameAspect) : 1;
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

/** Editor-only direct manipulation for overlay-placed media: the frame layer's own entries and the world-space windows, both edited through the overlay placement numbers. Mount above the canvas under the same workspace/export/autorun guards as the other 2D gizmos. */
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
    () => sceneMediaOverlayPlaced(resolveSceneDocMedia(project.sceneDocs[sceneIndex])),
    [project.sceneDocs, sceneIndex],
  );
  const versionSignal = useAssetVersionStore((state) =>
    images.map((image) => state.versions[assetVersionKey(project.id, image.src)] ?? 0).join("|"),
  );
  // Two spaces in one layer: a frame-layer entry draws against the whole frame, while a window-hosted one is world content and lands inside an overlay's cutout, laid out against the cutout's own format.
  const frameSpec = project.sceneFrames[sceneIndex];
  const cutout = useMemo(
    () => frameWorldCutout(frameSpec, formatSpec.width / formatSpec.height),
    [frameSpec, formatSpec],
  );
  const worldFormat = useMemo(
    () => (cutout && frameSpec ? resolveCutoutRender(formatSpec, frameSpec).format : format),
    [cutout, frameSpec, formatSpec, format],
  );
  const spaceOf = useCallback(
    (entry: SceneDocMediaSpec, rect: StageRect) =>
      entry.host === "window"
        ? { rect: cutoutStageRect(rect, cutout), aspect: worldFormat.aspect }
        : { rect, aspect: format.aspect },
    [cutout, format.aspect, worldFormat.aspect],
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
            // A clip sizes off the aspect its doc recorded at pick time; an edit render re-points a still without one, so the native probe answers for those.
            probe: image.kind === "image" || image.video?.aspect === undefined,
          },
        ];
      }),
    );
  }, [images, project.id, versionSignal]);

  useEffect(() => {
    let alive = true;
    for (const request of Object.values(sourceRequests)) {
      if (!request.probe) continue;
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
        const probed = sourceAspects[sourceRequests[image.id]?.key ?? ""];
        // A still's aspect comes from the probe; until it lands the item stays off the layer rather than drawing a square box over a portrait screenshot. A clip always has a box: its recorded aspect, the probe, then 16:9.
        const sourceAspect = video
          ? (image.video?.aspect ?? probed ?? DEFAULT_VIDEO_ASPECT)
          : probed;
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
              const space = spaceOf(image, rect);
              const [cx, cy] = centrePx(placement, space.rect);
              const box = overlayMediaGizmoBox(
                image.host,
                placement,
                aspect,
                space.aspect,
                space.rect,
              );
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
    [images, livePlacement, sourceAspects, sourceRequests, spaceOf],
  );

  // Guides follow the space the layer's items live in: a scene staging any window-hosted clip inside a cutout snaps to the cutout, since the frame's own centre and safe edges sit under the panel.
  const worldHosted = images.some((image) => image.host === "window");
  const frameGuides = useCallback(
    (rect: StageRect) => {
      const guideRect = worldHosted ? cutoutStageRect(rect, cutout) : rect;
      const guideFormat = worldHosted ? worldFormat : format;
      const scale = guideRect.width / guideFormat.frame.width;
      return frameGuideLines(guideRect, {
        left: guideFormat.safe.left * scale,
        right: guideFormat.safe.right * scale,
        top: guideFormat.safe.top * scale,
        bottom: guideFormat.safe.bottom * scale,
      });
    },
    [cutout, format, worldFormat, worldHosted],
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
    const rect = spaceOf(started.image, gesture.rect).rect;
    let placement: SceneImageOverlayPlacement;
    if (gesture.kind === "move") {
      const centre = centrePx(base, rect);
      placement = {
        ...base,
        position: positionAt([centre[0] + gesture.dxPx, centre[1] + gesture.dyPx], rect),
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
          rect,
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
