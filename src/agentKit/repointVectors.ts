import { applyEditRepoint, type EditRepointSlot, followMediaSources } from "../engine/sceneDoc";
import { parseSceneDoc } from "../engine/sceneDocSchema";

/** Conformance vectors for kb's raw-JSON mirror of the edit re-point (`scripts/kblib/video/repoint.py`): each raw sidecar goes through the app's own parse and `applyEditRepoint`, and `expect` holds the subtrees the app's sidecar write (JSON.stringify of the patched doc, as `commitSceneDocPatch` writes it) carries; a null value means the path is absent from the write. `follow` pins `followMediaSources`. */

type Raw = Record<string, unknown>;

export interface RepointVector {
  id: string;
  raw: Raw;
  slot: EditRepointSlot;
  rel: string;
  targetId: string | null;
  expect: Record<string, unknown> | null;
}

export interface FollowVector {
  id: string;
  raw: Raw;
  expect: string[];
}

export interface RepointVectors {
  version: 1;
  repoint: RepointVector[];
  follow: FollowVector[];
}

const REL = "assets/clip-edited.mp4";

const video = (src: string, extra: Raw = {}) => ({ src, kind: "video", ...extra });
const image = (src: string, extra: Raw = {}) => ({ src, kind: "image", ...extra });
const doc = (fields: Raw): Raw => ({ version: 1, name: "Scene", ...fields });

interface Case {
  id: string;
  raw: Raw;
  slot: EditRepointSlot;
  targetId?: string;
  /** The written paths this case pins (dotted, numeric segments index arrays). */
  paths: string[];
}

const REPOINT_CASES: Case[] = [
  {
    id: "background-video",
    raw: doc({ background: { type: "video", src: "assets/bg.mp4" } }),
    slot: "background",
    paths: ["background"],
  },
  {
    id: "background-video-normalised",
    raw: doc({
      background: {
        type: "video",
        src: "assets/bg.mp4",
        loop: false,
        fit: "fit",
        parallax: 0.8,
        colour: "#fff",
      },
    }),
    slot: "background",
    paths: ["background"],
  },
  {
    id: "background-video-loop-true-fill",
    raw: doc({
      background: { type: "video", src: "assets/bg.mp4", loop: true, fit: "fill", parallax: 0.2 },
    }),
    slot: "background",
    paths: ["background"],
  },
  {
    id: "background-image-is-null",
    raw: doc({ background: { type: "image", src: "assets/bg.png" } }),
    slot: "background",
    paths: [],
  },
  { id: "background-absent-is-null", raw: doc({}), slot: "background", paths: [] },
  {
    id: "device-first-without-target",
    raw: doc({
      devices: [
        { id: "d1", model: "iphone-17-pro", media: video("assets/a.mp4", { startMs: 400 }) },
        { id: "d2", model: "iphone-17-pro", media: video("assets/b.mp4") },
      ],
    }),
    slot: "device",
    paths: ["devices.0.media", "devices.1.media"],
  },
  {
    id: "device-by-target",
    raw: doc({
      devices: [
        { id: "d1", model: "iphone-17-pro", media: video("assets/a.mp4") },
        { id: "d2", model: "pixel-9", media: video("assets/b.mp4", { fit: "cover" }) },
      ],
    }),
    slot: "device",
    targetId: "d2",
    paths: ["devices.0.media", "devices.1.media"],
  },
  {
    id: "device-stale-target-is-null",
    raw: doc({ devices: [{ id: "d1", model: "iphone-17-pro", media: video("assets/a.mp4") }] }),
    slot: "device",
    targetId: "gone",
    paths: [],
  },
  {
    id: "device-image-becomes-video",
    raw: doc({ devices: [{ id: "d1", model: "iphone-17-pro", media: image("assets/shot.png") }] }),
    slot: "device",
    targetId: "d1",
    paths: ["devices.0.media"],
  },
  {
    id: "device-without-media-is-null",
    raw: doc({ devices: [{ id: "d1", model: "iphone-17-pro" }] }),
    slot: "device",
    targetId: "d1",
    paths: [],
  },
  { id: "device-less-doc-is-null", raw: doc({}), slot: "device", paths: [] },
  {
    id: "device-cover",
    raw: doc({
      devices: [
        {
          id: "d1",
          model: "iphone-duo",
          media: video("assets/in.mp4"),
          coverMedia: video("assets/out.mp4", { startOn: "open", startMs: 120 }),
        },
      ],
    }),
    slot: "deviceCover",
    targetId: "d1",
    paths: ["devices.0.media", "devices.0.coverMedia"],
  },
  {
    id: "device-cover-missing-is-null",
    raw: doc({ devices: [{ id: "d1", model: "iphone-duo", media: video("assets/in.mp4") }] }),
    slot: "deviceCover",
    targetId: "d1",
    paths: [],
  },
  {
    id: "compare-device-creates-override",
    raw: doc({
      devices: [{ id: "d1", model: "iphone-17-pro", media: video("assets/before.mp4") }],
      compare: { b: {} },
    }),
    slot: "compareDevice",
    targetId: "d1",
    paths: ["devices.0.media", "compare.b.media", "compare.b.coverMedia"],
  },
  {
    id: "compare-device-without-b",
    raw: doc({
      devices: [{ id: "d1", model: "iphone-17-pro", media: image("assets/before.png") }],
      compare: { value: 0.5 },
    }),
    slot: "compareDevice",
    targetId: "d1",
    paths: ["devices.0.media", "compare.b.media"],
  },
  {
    id: "compare-device-updates-override",
    raw: doc({
      devices: [{ id: "d1", model: "iphone-17-pro", media: image("assets/before.png") }],
      compare: { b: { media: { d1: video("assets/after.mp4", { startMs: 250 }) } } },
    }),
    slot: "compareDevice",
    targetId: "d1",
    paths: ["devices.0.media", "compare.b.media"],
  },
  {
    id: "compare-device-drops-malformed-overrides",
    raw: doc({
      devices: [
        { id: "d1", model: "iphone-17-pro", media: video("assets/before.mp4") },
        { id: "d2", model: "iphone-17-pro", media: video("assets/other.mp4") },
      ],
      compare: {
        b: {
          media: {
            d2: video("assets/other-after.mp4"),
            d9: { src: "", kind: "video" },
            d8: { src: "assets/x.mp4", kind: "gif" },
          },
        },
      },
    }),
    slot: "compareDevice",
    targetId: "d1",
    paths: ["compare.b.media"],
  },
  {
    id: "compare-device-no-compare-is-null",
    raw: doc({
      devices: [{ id: "d1", model: "iphone-17-pro", media: video("assets/before.mp4") }],
    }),
    slot: "compareDevice",
    targetId: "d1",
    paths: [],
  },
  {
    id: "compare-device-cover",
    raw: doc({
      devices: [
        {
          id: "d1",
          model: "iphone-duo",
          media: video("assets/in.mp4"),
          coverMedia: video("assets/out.mp4"),
        },
      ],
      compare: { b: { coverMedia: { d1: video("assets/after-out.mp4") } } },
    }),
    slot: "compareDeviceCover",
    targetId: "d1",
    paths: ["devices.0.coverMedia", "compare.b.coverMedia", "compare.b.media"],
  },
  {
    id: "compare-device-cover-inherits",
    raw: doc({
      devices: [
        {
          id: "d1",
          model: "iphone-duo",
          media: video("assets/in.mp4"),
          coverMedia: video("assets/out.mp4", { fit: "cover" }),
        },
      ],
      compare: { b: { themeId: "kookaburra-default" } },
    }),
    slot: "compareDeviceCover",
    targetId: "d1",
    paths: ["devices.0.coverMedia", "compare.b.coverMedia"],
  },
  {
    id: "media-by-id-drops-start",
    raw: doc({
      media: [
        {
          id: "vid1",
          kind: "video",
          src: "assets/screencast.mp4",
          host: "window",
          stage: { position: [0, 0, 0], size: 5.3, rotationDeg: [0, 0, 0] },
          overlay: { position: [0, 0], size: 0.72, rotationDeg: 0, shape: "none", layer: "below" },
          window: { radius: "macos", recording: true },
          video: { startMs: 600, loop: false, aspect: 1.5 },
        },
      ],
    }),
    slot: "media",
    targetId: "vid1",
    paths: ["media", "images", "videoWindow"],
  },
  {
    id: "media-image-becomes-video",
    raw: doc({
      media: [
        { id: "img1", kind: "image", src: "assets/shot.png", host: "overlay" },
        { id: "vid1", kind: "video", src: "assets/a.mp4" },
      ],
    }),
    slot: "media",
    targetId: "img1",
    paths: ["media"],
  },
  {
    id: "media-entries-normalised",
    raw: doc({
      media: [
        {
          id: "vid1",
          kind: "video",
          src: "assets/a.mp4",
          host: "nowhere",
          stage: { position: [1, 2], size: -1, rotationDeg: [400, -190, 180] },
          overlay: {
            position: [0.25, -0.5],
            size: 0.4,
            rotationDeg: 270,
            shape: "circle",
            stackOrder: 3,
          },
          motion: { preset: "spin", amplitude: -1, hz: 0.5, durationMs: 0, degPerSec: -20 },
          castShadow: true,
          window: { radius: { custom: 0.2 }, border: { enabled: true }, shadow: "soft" },
          video: { startMs: "soon", loop: true, aspect: 0 },
          extra: "dropped",
        },
        { id: "vid1", kind: "video", src: "assets/dup.mp4" },
        { id: "img2", kind: "image", src: "assets/notes.gif" },
        { id: "img3", src: "assets/still.jpg", host: "window", motion: { preset: "drift" } },
      ],
    }),
    slot: "media",
    targetId: "vid1",
    paths: ["media"],
  },
  {
    id: "media-stale-target-is-null",
    raw: doc({ media: [{ id: "vid1", kind: "video", src: "assets/a.mp4" }] }),
    slot: "media",
    targetId: "gone",
    paths: [],
  },
  {
    id: "media-without-target-takes-the-window",
    raw: doc({
      media: [
        { id: "img1", kind: "image", src: "assets/shot.png" },
        { id: "vid1", kind: "video", src: "assets/plain.mp4" },
        { id: "vid2", kind: "video", src: "assets/win.mp4", window: { radius: "subtle" } },
      ],
    }),
    slot: "media",
    paths: ["media"],
  },
  {
    id: "video-window-slot-authored",
    raw: doc({
      media: [{ id: "vid2", kind: "video", src: "assets/win.mp4", window: { radius: "sharp" } }],
    }),
    slot: "videoWindow",
    paths: ["media"],
  },
  {
    id: "video-window-slot-without-window-is-null",
    raw: doc({ media: [{ id: "vid1", kind: "image", src: "assets/a.png" }] }),
    slot: "videoWindow",
    paths: [],
  },
  {
    id: "legacy-video-window-promotes",
    raw: doc({
      images: [
        {
          id: "img1",
          src: "assets/a.png",
          host: "overlay",
          overlay: { position: [0.1, 0.2], size: 0.3, rotationDeg: -540, layer: "below" },
          motion: { preset: "float", amplitude: 0.1 },
          castShadow: false,
        },
        { id: "bad", src: "assets/movie.mp4" },
      ],
      videoWindow: {
        media: { src: "assets/rec.mp4", startMs: 800, loop: true, aspect: 1.6 },
        offset: [0.7, -2],
        scale: 1.4,
        radius: "rounded",
        recording: false,
        border: { enabled: true, width: 0.01 },
        shadow: { opacity: 0.3, blur: 0.1, offset: [0, -0.04] },
        motion: { preset: "float" },
      },
    }),
    slot: "videoWindow",
    paths: ["media", "images", "videoWindow"],
  },
  {
    id: "legacy-video-window-defaults",
    raw: doc({ videoWindow: { media: { src: "assets/rec.mp4" } } }),
    slot: "media",
    targetId: "videoWindow",
    paths: ["media", "videoWindow"],
  },
  {
    id: "legacy-image-by-id",
    raw: doc({
      images: [
        { id: "img1", src: "assets/a.png" },
        { id: "img2", src: "assets/b.webp", stage: { position: [1, 0, 0], size: 2 } },
      ],
    }),
    slot: "media",
    targetId: "img2",
    paths: ["media", "images"],
  },
  {
    id: "media-not-an-array-uses-legacy",
    raw: doc({ media: "nope", images: [{ id: "img1", src: "assets/a.png" }] }),
    slot: "media",
    targetId: "img1",
    paths: ["media", "images"],
  },
  {
    id: "authored-media-wins-over-legacy",
    raw: doc({
      media: [{ id: "vid1", kind: "video", src: "assets/a.mp4" }],
      images: [{ id: "img1", src: "assets/a.png" }],
      videoWindow: { media: { src: "assets/rec.mp4" } },
    }),
    slot: "media",
    targetId: "vid1",
    paths: ["media", "images", "videoWindow"],
  },
];

const FOLLOW_CASES: { id: string; raw: Raw }[] = [
  {
    id: "manual",
    raw: doc({
      duration: { mode: "manual" },
      devices: [{ id: "d1", model: "x", media: video("assets/a.mp4") }],
    }),
  },
  {
    id: "no-duration",
    raw: doc({ devices: [{ id: "d1", model: "x", media: video("assets/a.mp4") }] }),
  },
  {
    id: "every-device-video",
    raw: doc({
      duration: { mode: "follow-media" },
      devices: [
        {
          id: "d1",
          model: "iphone-duo",
          media: video("assets/in.mp4"),
          coverMedia: video("assets/out.mp4"),
        },
        { id: "d2", model: "x", media: image("assets/shot.png") },
        { id: "d3", model: "x", media: video("assets/third.mp4") },
      ],
      compare: {
        b: {
          media: { d2: video("assets/after.mp4"), d1: image("assets/after.png") },
          coverMedia: { d1: video("assets/after-out.mp4") },
        },
      },
    }),
  },
  {
    id: "pinned-device",
    raw: doc({
      duration: { mode: "follow-media", sourceDeviceId: "d2" },
      devices: [
        { id: "d1", model: "x", media: video("assets/a.mp4") },
        { id: "d2", model: "x", media: video("assets/b.mp4") },
      ],
    }),
  },
  {
    id: "stale-pin-falls-back",
    raw: doc({
      duration: { mode: "follow-media", sourceDeviceId: "gone" },
      devices: [
        { id: "d1", model: "x", media: video("assets/a.mp4") },
        { id: "d2", model: "x", media: video("assets/b.mp4") },
      ],
    }),
  },
  {
    id: "media-pin",
    raw: doc({
      duration: { mode: "follow-media", source: "media", sourceMediaId: "vid2" },
      devices: [{ id: "d1", model: "x", media: video("assets/a.mp4") }],
      media: [
        { id: "vid1", kind: "video", src: "assets/v1.mp4" },
        { id: "vid2", kind: "video", src: "assets/v2.mp4" },
      ],
    }),
  },
  {
    id: "media-pin-without-id",
    raw: doc({
      duration: { mode: "follow-media", source: "media" },
      media: [{ id: "vid1", kind: "video", src: "assets/v1.mp4" }],
    }),
  },
  {
    id: "media-pin-to-a-still",
    raw: doc({
      duration: { mode: "follow-media", source: "media", sourceMediaId: "img1" },
      media: [{ id: "img1", kind: "image", src: "assets/a.png" }],
    }),
  },
  {
    id: "legacy-video-window-source",
    raw: doc({
      duration: { mode: "follow-media", source: "videoWindow" },
      videoWindow: { media: { src: "assets/rec.mp4" } },
    }),
  },
  {
    id: "media-videos-without-devices",
    raw: doc({
      duration: { mode: "follow-media" },
      media: [
        { id: "img1", kind: "image", src: "assets/a.png" },
        { id: "vid1", kind: "video", src: "assets/v1.mp4" },
        { id: "vid2", kind: "video", src: "assets/v2.mp4" },
      ],
      background: { type: "video", src: "assets/bg.mp4" },
    }),
  },
  {
    id: "background-last",
    raw: doc({
      duration: { mode: "follow-media" },
      devices: [{ id: "d1", model: "x", media: image("assets/shot.png") }],
      background: { type: "video", src: "assets/bg.mp4" },
    }),
  },
  {
    id: "nothing-to-follow",
    raw: doc({
      duration: { mode: "follow-media" },
      background: { type: "image", src: "assets/bg.png" },
    }),
  },
  { id: "duration-not-an-object", raw: doc({ duration: "follow-media" }) },
];

function pick(value: unknown, path: string): unknown {
  let node: unknown = value;
  for (const part of path.split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(part)) node = node[Number(part)];
    else if (node && typeof node === "object") node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return node;
}

export function buildRepointVectors(): RepointVectors {
  const repoint = REPOINT_CASES.map((c): RepointVector => {
    const parsed = parseSceneDoc(structuredClone(c.raw), `vector ${c.id}`);
    if (!parsed) throw new Error(`repoint vector ${c.id} does not parse`);
    const next = applyEditRepoint(parsed, c.slot, REL, c.targetId);
    let expect: Record<string, unknown> | null = null;
    if (next) {
      const written = JSON.parse(JSON.stringify(next));
      expect = {};
      for (const path of c.paths) expect[path] = pick(written, path) ?? null;
    }
    return { id: c.id, raw: c.raw, slot: c.slot, rel: REL, targetId: c.targetId ?? null, expect };
  });
  const follow = FOLLOW_CASES.map(
    (c): FollowVector => ({
      id: c.id,
      raw: c.raw,
      expect: followMediaSources(parseSceneDoc(structuredClone(c.raw), `vector ${c.id}`)),
    }),
  );
  return { version: 1, repoint, follow };
}

export function serialiseRepointVectors(vectors: RepointVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
