/** Scene media: the one content family behind still images and floating video windows. Pure (plain data in, plain data out, no clock reads) so parse, preview and export agree by construction; the sidecar schema and its degrade-don't-crash validation stay in `sceneDocSchema.ts` while this module owns the semantics: the legacy `images`/`videoWindow` read-forward, the window placement conversion and the authoring factory. */

import { ease } from "./ease";
import type {
  SceneDoc,
  SceneDocDuration,
  SceneDocImageSpec,
  SceneDocMediaSpec,
  SceneDocVideoWindow,
  SceneImageHost,
  SceneImageMotionSpec,
  SceneImageOverlayPlacement,
  SceneImageStagePlacement,
  SceneMediaHost,
  SceneMediaKind,
  SceneMediaMotionSpec,
  SceneMediaVideoSpec,
  SceneMediaWindow,
  VideoWindowRadius,
} from "./sceneDocSchema";
import { DEFAULT_VIDEO_WINDOW_SCALE, sampleVideoWindowMotion } from "./sceneVideoWindow";

export const DEFAULT_SCENE_IMAGE_STAGE: SceneImageStagePlacement = {
  position: [0, 0, 0],
  size: 1,
  rotationDeg: [0, 0, 0],
};

export const DEFAULT_SCENE_IMAGE_OVERLAY: SceneImageOverlayPlacement = {
  position: [0, 0],
  size: 0.25,
  rotationDeg: 0,
  shape: "none",
  layer: "above",
};

/** A promoted video window keeps this id, which is also `sceneRig.ts`'s `VIDEO_WINDOW_AIM_ID`, so legacy camera aim bindings resolve unchanged. */
export const VIDEO_WINDOW_MEDIA_ID = "videoWindow";

/** Window chrome a promoted or freshly created video entry starts with (the legacy `videoWindow` default). */
export const DEFAULT_SCENE_MEDIA_WINDOW_RADIUS: VideoWindowRadius = "macos";

/** Stage width in world units for a video entry: roughly what its default overlay size covers in a 16:9 frame, so switching host keeps the size sane instead of collapsing to the 1-unit image default. */
export const DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE = 5.3;

export const DEFAULT_SCENE_MEDIA_VIDEO_STAGE: SceneImageStagePlacement = {
  position: [0, 0, 0],
  size: DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE,
  rotationDeg: [0, 0, 0],
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const clampWindowScale = (value: number | undefined): number =>
  Number.isFinite(value) ? clamp(value as number, 0.1, 1) : DEFAULT_VIDEO_WINDOW_SCALE;

/** Legacy `videoWindow.scale` as an overlay size: the same number, because a windowed entry keeps the window's own sizing (it fits INSIDE a box that is `size` of the frame, `windowOverlayPlaneWidth`) rather than the plain image rule of "size IS the width". Aspect-free by design: the effective aspect is a render-time fact (live intrinsics, and the recording crop's aspect is not the clip's), so folding it in here mis-sizes every window whose doc never recorded one. */
export function videoWindowScaleToOverlaySize(scale: number | undefined): number {
  return clampWindowScale(scale);
}

/** The width a windowed Overlay entry's plane draws at: a contain fit inside a box that is `size` of the frame, so a clip at least as wide as the frame spans `size` of the width and a narrower one stays inside the frame height. Byte-for-byte the legacy window fit (`clipPlaneSize("contain", …)`), at every aspect. */
export function windowOverlayPlaneWidth(
  size: number,
  frame: { width: number; height: number },
  mediaAspect: number,
): number {
  return Math.min(size * frame.width, size * frame.height * mediaAspect);
}

const finiteV2 = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n));

const cloneStage = (stage: SceneImageStagePlacement): SceneImageStagePlacement => ({
  position: [...stage.position],
  size: stage.size,
  rotationDeg: [...stage.rotationDeg],
});

const cloneOverlay = (overlay: SceneImageOverlayPlacement): SceneImageOverlayPlacement => {
  const next: SceneImageOverlayPlacement = {
    position: [...overlay.position],
    size: overlay.size,
    rotationDeg: overlay.rotationDeg,
    shape: overlay.shape,
    layer: overlay.layer,
  };
  if (overlay.stackOrder !== undefined) next.stackOrder = overlay.stackOrder;
  return next;
};

/** Overlay placement for a legacy window: `offset` is a whole-frame fraction while the overlay position is half-frame relative, so it doubles; the size follows the parity conversion, and the window sits below the frame chrome the way its world-space ancestor did. */
export function videoWindowOverlayPlacement(
  window: SceneDocVideoWindow,
): SceneImageOverlayPlacement {
  const offset = finiteV2(window.offset) ? window.offset : [0, 0];
  return {
    position: [clamp(offset[0], -1, 1) * 2, clamp(offset[1], -1, 1) * 2],
    size: videoWindowScaleToOverlaySize(window.scale),
    rotationDeg: 0,
    shape: "none",
    layer: "below",
  };
}

export const DEFAULT_SCENE_MEDIA_VIDEO_OVERLAY: SceneImageOverlayPlacement = {
  position: [0, 0],
  size: videoWindowScaleToOverlaySize(DEFAULT_VIDEO_WINDOW_SCALE),
  rotationDeg: 0,
  shape: "none",
  layer: "below",
};

export function sceneMediaFromImage(image: SceneDocImageSpec): SceneDocMediaSpec {
  const entry: SceneDocMediaSpec = {
    id: image.id,
    kind: "image",
    src: image.src,
    host: image.host,
    stage: cloneStage(image.stage),
    overlay: cloneOverlay(image.overlay),
  };
  if (image.motion) entry.motion = { ...image.motion };
  if (image.castShadow !== undefined) entry.castShadow = image.castShadow;
  return entry;
}

export function sceneMediaFromVideoWindow(window: SceneDocVideoWindow): SceneDocMediaSpec {
  const chrome: SceneMediaWindow = {
    radius: window.radius ?? DEFAULT_SCENE_MEDIA_WINDOW_RADIUS,
  };
  if (window.recording !== undefined) chrome.recording = window.recording;
  if (window.border) chrome.border = { ...window.border };
  if (window.shadow) chrome.shadow = { ...window.shadow, offset: [...window.shadow.offset] };
  const video: SceneMediaVideoSpec = {};
  if (window.media.startMs !== undefined) video.startMs = window.media.startMs;
  if (window.media.loop !== undefined) video.loop = window.media.loop;
  if (window.media.aspect !== undefined) video.aspect = window.media.aspect;
  const entry: SceneDocMediaSpec = {
    id: VIDEO_WINDOW_MEDIA_ID,
    kind: "video",
    src: window.media.src,
    host: "overlay",
    stage: cloneStage(DEFAULT_SCENE_MEDIA_VIDEO_STAGE),
    overlay: videoWindowOverlayPlacement(window),
    window: chrome,
    video,
  };
  if (window.motion) entry.motion = { ...window.motion };
  return entry;
}

/** The media view of a legacy doc: every image in order, then the one video window. */
export function sceneMediaFromLegacy(
  images: readonly SceneDocImageSpec[] | undefined,
  videoWindow: SceneDocVideoWindow | undefined,
): SceneDocMediaSpec[] {
  const media = (images ?? []).map(sceneMediaFromImage);
  if (videoWindow?.media?.src) media.push(sceneMediaFromVideoWindow(videoWindow));
  return media;
}

/** Which entry serves as the scene's video window: the first video carrying window chrome, or the promoted entry by id. It is what the legacy `videoWindow` duration source and the rig's `VIDEO_WINDOW_AIM_ID` both name. */
export function videoWindowMediaEntry(
  media: readonly SceneDocMediaSpec[],
): SceneDocMediaSpec | undefined {
  return media.find(
    (candidate) =>
      candidate.kind === "video" &&
      (candidate.window !== undefined || candidate.id === VIDEO_WINDOW_MEDIA_ID),
  );
}

/** Does this duration follow a media entry rather than a device? Both spellings count, so a device edit leaves a media-pinned length alone. */
export function followsSceneMedia(duration: SceneDocDuration | undefined): boolean {
  return (
    duration?.mode === "follow-media" &&
    (duration.source === "media" || duration.source === "videoWindow")
  );
}

/** The entry a follow-media duration pins, if it pins one: `sourceMediaId` names it directly, and the legacy `source: "videoWindow"` names whichever entry serves as the window. Undefined when the duration pins no entry, or when the pin is stale. */
export function pinnedFollowMediaEntry(
  duration: SceneDocDuration | undefined,
  media: readonly SceneDocMediaSpec[],
): SceneDocMediaSpec | undefined {
  if (duration?.mode !== "follow-media") return undefined;
  if (duration.source === "media") {
    return duration.sourceMediaId === undefined
      ? undefined
      : media.find((entry) => entry.id === duration.sourceMediaId);
  }
  if (duration.source === "videoWindow") return videoWindowMediaEntry(media);
  return undefined;
}

/** The scene's media whichever family it was authored in: an authored `media` array wins, otherwise the legacy blocks derive one. Readers go through this rather than `doc.media`, since a legacy document's derived array is deliberately non-enumerable and does not survive `structuredClone` (see the bridge note in `sceneDocSchema.ts`). */
export function resolveSceneDocMedia(
  doc: Pick<SceneDoc, "media" | "images" | "videoWindow"> | undefined,
): SceneDocMediaSpec[] {
  if (!doc) return [];
  return doc.media ?? sceneMediaFromLegacy(doc.images, doc.videoWindow);
}

// ── Authoring writes (the inspector's one seam onto `media`) ──────────────────

/** Writes an authored media array and drops the legacy blocks it supersedes, so the sidecar carries `media` alone. Defined rather than assigned: a legacy document's derived array is non-enumerable, and a plain assignment would inherit that and keep the promotion out of the file. */
export function setSceneDocMedia(doc: SceneDoc, media: readonly SceneDocMediaSpec[]): void {
  delete doc.images;
  delete doc.videoWindow;
  if (media.length === 0) {
    delete doc.media;
    return;
  }
  Object.defineProperty(doc, "media", {
    value: [...media],
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Every inspector media write: resolve the scene's media whichever family authored it, hand that array to `mutate`, and store what it returns as the authored `media` (promote-on-write, so the legacy blocks leave the sidecar in the same entry). Editing entries in place returns the same array. */
export function editSceneDocMedia(
  doc: SceneDoc,
  mutate: (media: SceneDocMediaSpec[]) => SceneDocMediaSpec[],
): SceneDocMediaSpec[] {
  const next = mutate(resolveSceneDocMedia(doc));
  setSceneDocMedia(doc, next);
  return next;
}

export function createSceneMedia(
  id: string,
  src: string,
  kind: SceneMediaKind,
  host: SceneMediaHost = kind === "video" ? "overlay" : "stage",
): SceneDocMediaSpec {
  if (kind === "video") {
    return {
      id,
      kind,
      src,
      host,
      stage: cloneStage(DEFAULT_SCENE_MEDIA_VIDEO_STAGE),
      overlay: cloneOverlay(DEFAULT_SCENE_MEDIA_VIDEO_OVERLAY),
      window: { radius: DEFAULT_SCENE_MEDIA_WINDOW_RADIUS },
      video: {},
    };
  }
  return {
    id,
    kind,
    src,
    host,
    stage: cloneStage(DEFAULT_SCENE_IMAGE_STAGE),
    overlay: cloneOverlay(DEFAULT_SCENE_IMAGE_OVERLAY),
  };
}

export const SCENE_MEDIA_ID_PREFIX: Record<SceneMediaKind, string> = {
  image: "img",
  video: "vid",
};

/** Mints the next free `img<N>`/`vid<N>`. Pass EVERY id the doc holds: re-minting a live id orphans whatever binds to it (camera aims, keyed tracks). */
export function nextSceneMediaId(kind: SceneMediaKind, used: readonly string[]): string {
  const taken = new Set(used);
  const prefix = SCENE_MEDIA_ID_PREFIX[kind];
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function sceneMediaForHost(
  media: readonly SceneDocMediaSpec[],
  host: SceneMediaHost,
): SceneDocMediaSpec[] {
  return media.filter((entry) => entry.host === host);
}

// ── Where an entry renders ────────────────────────────────────────────────────

/** Which fallback family owns an entry: `<SceneStage>` consumes the stage family and `<VideoWindow/>` the window family, so a scene's own mounts stand exactly their family down. Disjoint by construction, so nothing renders twice. */
export type SceneMediaFamily = "stage" | "window";

/** The split is by KIND, never by chrome: a still keeps its host's own layer (chrome is a look painted on that plane), while an Overlay-hosted clip always draws in the world, where a frameless scene can draw it at all. */
export function sceneMediaFamily(entry: SceneDocMediaSpec): SceneMediaFamily | null {
  if (entry.host === "stage") return "stage";
  return entry.kind === "video" ? "window" : null;
}

/** Does this entry draw through the window path (a world-space plane contain-fitted inside its size box) rather than its host's plain plane? Every Overlay clip does, and a Stage clip does once chrome is authored. */
export function sceneMediaUsesWindowPath(entry: SceneDocMediaSpec): boolean {
  return entry.kind === "video" && (entry.window !== undefined || entry.host === "overlay");
}

/** Media the scene's own world hosts: everything on the Stage, plus every Overlay-hosted clip. */
export function sceneMediaInWorld(media: readonly SceneDocMediaSpec[]): SceneDocMediaSpec[] {
  return media.filter((entry) => sceneMediaFamily(entry) !== null);
}

/** Media the overlay frame layer hosts, drawn over the composited slide: Overlay-hosted stills, chrome or not. */
export function sceneMediaInFrame(media: readonly SceneDocMediaSpec[]): SceneDocMediaSpec[] {
  return media.filter((entry) => sceneMediaFamily(entry) === null);
}

// ── Motion ────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;
const RAD2DEG = 180 / Math.PI;

export interface SceneImageMotionSample {
  /** Relative to the active host's authored position, in world units on Stage and frame units on Overlay. */
  position: [number, number, number];
  /** Relative Euler rotation in degrees. */
  rotationDeg: [number, number, number];
  scale: number;
  opacity: number;
}

const identityMotion = (): SceneImageMotionSample => ({
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: 1,
  opacity: 1,
});

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Pure host-aware preset sampling over scene-local time. */
export function sampleSceneImageMotion(
  motion: SceneImageMotionSpec | undefined,
  host: SceneImageHost,
  localMs: number,
): SceneImageMotionSample {
  const sample = identityMotion();
  if (!motion || motion.preset === "none") return sample;

  const safeMs = Number.isFinite(localMs) ? Math.max(0, localMs) : 0;
  const seconds = safeMs / 1000;
  switch (motion.preset) {
    case "turntable": {
      const rotation = finiteOr(motion.degPerSec, 18) * seconds;
      if (host === "stage") sample.rotationDeg[1] = rotation;
      else sample.rotationDeg[2] = rotation * 0.35;
      break;
    }
    case "float": {
      const amplitude = Math.max(0, finiteOr(motion.amplitude, 0.12));
      const hz = Math.max(0, finiteOr(motion.hz, 0.4));
      const offset = amplitude * Math.sin(TWO_PI * hz * seconds);
      sample.position[1] = host === "stage" ? offset : offset * 0.25;
      break;
    }
    case "tilt-reveal": {
      const durationMs = Math.max(1, finiteOr(motion.durationMs, 1000));
      const progress = ease("outCubic", safeMs / durationMs);
      const remaining = 1 - progress;
      if (host === "stage") {
        if (remaining > 0) {
          sample.rotationDeg[0] = -14 * remaining;
          sample.rotationDeg[1] = -40 * remaining;
        }
      } else {
        sample.position[0] = 0.08 * remaining;
        if (remaining > 0) sample.rotationDeg[2] = -10 * remaining;
        sample.scale = 0.96 + 0.04 * progress;
      }
      break;
    }
    case "push-in": {
      const durationMs = Math.max(1, finiteOr(motion.durationMs, 1200));
      const progress = ease("outCubic", safeMs / durationMs);
      if (host === "stage") {
        sample.scale = 0.86 + 0.14 * progress;
        if (progress < 1) sample.rotationDeg[1] = -8 * (1 - progress);
      } else {
        sample.scale = 0.9 + 0.1 * progress;
      }
      break;
    }
  }
  return sample;
}

/** The one sampler seam: a still keeps the image family's host-aware presets, a video keeps the window family's maths (world-unit offsets, radian rotations converted to the shared degree sample). A preset the kind never had is inert rather than faked. */
export function sampleSceneMediaMotion(
  kind: SceneMediaKind,
  motion: SceneMediaMotionSpec | undefined,
  host: SceneMediaHost,
  localMs: number,
): SceneImageMotionSample {
  const preset = motion?.preset;
  if (!motion || preset === undefined || preset === "none") return identityMotion();
  if (kind !== "video") {
    return preset === "drift"
      ? identityMotion()
      : sampleSceneImageMotion({ ...motion, preset }, host, localMs);
  }
  if (preset === "turntable") return identityMotion();
  const sample = sampleVideoWindowMotion({ ...motion, preset }, localMs);
  return {
    position: [sample.posX, sample.posY, sample.posZ],
    rotationDeg: [sample.rotX * RAD2DEG, sample.rotY * RAD2DEG, 0],
    scale: sample.scale,
    opacity: 1,
  };
}
