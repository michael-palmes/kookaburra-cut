import {
  type ProjectMusic,
  resolveMusicPosition,
  resolveSceneLocalMs,
  roundMs,
} from "../engine/musicTime";
import { collectParseWarnings } from "../engine/parseWarnings";
import { resolveSceneDocMusic, sceneDocMusicFields } from "../engine/sceneDocMusic";
import { parseSceneDoc } from "../engine/sceneDocSchema";

type Raw = Record<string, unknown>;

/** Conformance vectors for kb's musical-position mirror (`scripts/kblib/music.py`): every case runs through the app's own resolver, and the kit must reproduce `projectMs` as the exact same double, its `js_round` and the scene-local ms. `sidecars` pin `beats.model.refresh_doc` against `resolveSceneDocMusic` over a parsed raw sidecar: which fields carry an `at`, the time each resolves to, and the per-field issues (key crossings are app-only). */

export interface MusicResolveVector {
  id: string;
  music: ProjectMusic;
  position: string;
  sceneStartMs: number;
  expect:
    | { ok: true; projectMs: number; rounded: number; sceneLocalMs: number }
    | { ok: false; code: string };
}

export interface MusicSidecarVector {
  id: string;
  music: ProjectMusic;
  sceneStartMs: number;
  raw: Raw;
  expect: {
    moved: boolean;
    fields: ReturnType<typeof sceneDocMusicFields>;
    issues: string[];
  };
}

export interface MusicVectors {
  version: 1;
  resolve: MusicResolveVector[];
  rounding: { x: number; out: number }[];
  sidecars: MusicSidecarVector[];
}

const GRIDS = [
  { bpm: 135.11, offsetMs: 447.5, beatsPerBar: 4 },
  { bpm: 120, offsetMs: 0, beatsPerBar: 4 },
  { bpm: 96.25, offsetMs: -311.7, beatsPerBar: 3 },
  { bpm: 174.000001, offsetMs: 12.25, beatsPerBar: 7 },
];

const POSITIONS = [
  "bar:1",
  "bar:13",
  "bar:13.3",
  "bar:13.3.2",
  "bar:12.3.4",
  "bar:0.4",
  "bar:-1",
  "bar:29-83ms",
  "bar:36+12.5ms",
  "bar:007.2",
  "cue:drop",
  "cue:raw",
  "cue:nudged+40ms",
  "section:outro",
  "section:outro-0.25ms",
  "bar:13.5",
  "bar:13.0",
  "bar:13.1.5",
  "bar:100001",
  "beat:13.3",
  "bar:13+40",
  "cue:missing",
  "cue:loop",
  "section:missing",
];

const ROUNDING = [
  0.5, 1.5, -0.5, -1.5, 2.4999999999999996, 0.49999999999999994, 21762.5, -21762.5, 1234.5,
  4503599627370495.5,
];

function vector(
  id: string,
  music: ProjectMusic,
  position: string,
  sceneStartMs: number,
): MusicResolveVector {
  const r = resolveMusicPosition(position, music);
  if (!r.ok) return { id, music, position, sceneStartMs, expect: { ok: false, code: r.code } };
  const local = resolveSceneLocalMs(position, music, sceneStartMs);
  return {
    id,
    music,
    position,
    sceneStartMs,
    expect: {
      ok: true,
      projectMs: r.projectMs,
      rounded: roundMs(r.projectMs),
      sceneLocalMs: local.ok ? local.projectMs : Number.NaN,
    },
  };
}

const SIDECAR_MUSIC: ProjectMusic = {
  grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
  startOffsetMs: 0,
  cues: { drop: "bar:5", raw: 4321 },
  sections: { outro: { from: "bar:9", to: "bar:11" } },
};

const clip = (extra: Record<string, unknown> = {}) => ({
  src: "assets/a.mp4",
  kind: "video",
  ...extra,
});

const mediaEntry = (id: string, video: Record<string, unknown>, kind = "video") => ({
  id,
  kind,
  src: kind === "video" ? "assets/b.mp4" : "assets/b.png",
  host: "overlay",
  video,
});

const SIDECARS: { id: string; music?: ProjectMusic; sceneStartMs: number; raw: Raw }[] = [
  {
    id: "every-field",
    sceneStartMs: 1000,
    raw: {
      camera: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: { target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, distance: 6 },
          },
          {
            id: "k2",
            tMs: 1,
            at: "bar:5",
            pose: { target: [0, 0, 0], azimuthDeg: 9, elevationDeg: 0, distance: 6 },
          },
        ],
        segments: [{ from: "k1", to: "k2", ease: "linear" }],
      },
      cameraRig: {
        keys: [
          {
            id: "r1",
            tMs: 1,
            at: "cue:drop",
            pose: { position: [0, 0, 5], aim: { mode: "point", at: [0, 0, 0] } },
          },
        ],
        segments: [],
      },
      lighting: { keys: [{ id: "l1", tMs: 1, at: "bar:2", pose: { ambient: 1 } }] },
      deviceTrack: {
        keys: [
          { id: "d1", tMs: 0, pose: {} },
          { id: "d2", tMs: 1, at: "bar:2.3", pose: { phone: { scale: 2 } } },
        ],
        segments: [{ from: "d1", to: "d2", ease: "linear" }],
      },
      devices: [
        {
          id: "phone",
          model: "iphone-17-pro",
          media: clip({ at: "bar:2" }),
          coverMedia: clip({ startMs: 5, at: "cue:drop+40ms" }),
        },
        { id: "tab", model: "ipad-pro-13", media: clip({ startMs: 300 }) },
      ],
      media: [
        mediaEntry("v1", { startMs: 1, at: "bar:3", loop: true }),
        mediaEntry("v2", { startMs: 7 }),
      ],
      compare: {
        b: {
          lighting: { keys: [{ id: "b1", tMs: 1, at: "bar:3", pose: { ambient: 0.5 } }] },
          media: { phone: clip({ at: "bar:4" }) },
          coverMedia: { phone: clip() },
        },
        track: {
          keys: [
            { id: "c1", tMs: 0, pose: { value: 0 } },
            { id: "c2", tMs: 1, at: "section:outro+20ms", pose: { value: 1 } },
          ],
          segments: [{ from: "c1", to: "c2", ease: "linear" }],
        },
      },
    },
  },
  {
    id: "no-at",
    sceneStartMs: 1000,
    raw: {
      deviceTrack: { keys: [{ id: "d1", tMs: 0, pose: {} }], segments: [] },
      devices: [{ id: "phone", model: "iphone-17-pro", media: clip({ startMs: 400 }) }],
      media: [mediaEntry("v1", { startMs: 7 })],
    },
  },
  {
    id: "already-cached",
    sceneStartMs: 1000,
    raw: {
      deviceTrack: { keys: [{ id: "d1", tMs: 7250, at: "bar:5", pose: {} }], segments: [] },
      devices: [
        { id: "phone", model: "iphone-17-pro", media: clip({ startMs: 1250, at: "bar:2" }) },
      ],
      media: [mediaEntry("v1", { startMs: 3250, at: "bar:3" })],
    },
  },
  {
    id: "absent-start-on-the-first-frame",
    sceneStartMs: 250,
    raw: { devices: [{ id: "phone", model: "iphone-17-pro", media: clip({ at: "bar:1" }) }] },
  },
  {
    id: "screen-rules",
    sceneStartMs: 1000,
    raw: {
      devices: [
        {
          id: "a",
          model: "iphone-17-pro",
          media: { src: "assets/a.png", kind: "image", at: "bar:2" },
        },
        {
          id: "b",
          model: "iphone-17-pro",
          media: clip({ startOn: "open", startMs: 40, at: "bar:2" }),
        },
        { id: "c", model: "iphone-17-pro", media: clip({ inMs: 500, at: "bar:1" }) },
        { id: "d", model: "iphone-17-pro", media: clip({ at: "bar:1" }) },
        { id: "e", model: "iphone-17-pro", media: clip({ inMs: -5, at: "bar:1" }) },
        { id: "f", model: "iphone-17-pro", media: clip({ startMs: -750, inMs: 500, at: "bar:1" }) },
        { id: "nomodel", media: clip({ at: "bar:3" }) },
      ],
      media: [mediaEntry("still", { at: "bar:2" }, "image")],
      compare: {
        b: {
          coverMedia: {
            a: clip({ startOn: "open", at: "bar:3" }),
            b: { kind: "video", at: "bar:3" },
          },
        },
      },
    },
  },
  {
    id: "unresolvable",
    sceneStartMs: 0,
    raw: {
      devices: [
        { id: "phone", model: "iphone-17-pro", media: clip({ startMs: 9, at: "cue:nowhere" }) },
      ],
      media: [mediaEntry("v1", { startMs: 3, at: "bar 3" })],
      compare: {
        track: { keys: [{ id: "c1", tMs: 2, at: "cue:raw", pose: { value: 0 } }], segments: [] },
      },
    },
  },
  {
    id: "no-grid",
    music: { startOffsetMs: 0, cues: { raw: 4321 }, sections: {} },
    sceneStartMs: 300,
    raw: {
      deviceTrack: { keys: [{ id: "d1", tMs: 5, at: "bar:2", pose: {} }], segments: [] },
      devices: [{ id: "phone", model: "iphone-17-pro", media: clip({ at: "cue:raw" }) }],
    },
  },
];

function sidecarVector(c: (typeof SIDECARS)[number]): MusicSidecarVector {
  const music = c.music ?? SIDECAR_MUSIC;
  const raw = { version: 1, ...c.raw };
  const parsed = collectParseWarnings(() => parseSceneDoc(structuredClone(raw), c.id)).result;
  if (!parsed) throw new Error(`sidecar vector ${c.id} doesn't parse`);
  const r = resolveSceneDocMusic(parsed, music, c.sceneStartMs);
  return {
    id: c.id,
    music,
    sceneStartMs: c.sceneStartMs,
    raw,
    expect: {
      moved: r.doc !== parsed,
      fields: sceneDocMusicFields(r.doc),
      issues: r.issues.filter((issue) => !issue.includes(" keys reorder to ")),
    },
  };
}

export function buildMusicVectors(): MusicVectors {
  const resolve: MusicResolveVector[] = [];
  GRIDS.forEach((grid, g) => {
    for (const startOffsetMs of [0, 1250]) {
      const music: ProjectMusic = {
        grid,
        startOffsetMs,
        cues: { drop: "bar:29", raw: 49400, nudged: "bar:5.2-40ms", loop: "cue:drop" },
        sections: { outro: { from: "bar:33.2", to: "bar:41", label: "outro" } },
      };
      POSITIONS.forEach((position, p) => {
        const sceneStartMs = (p % 3) * 7333.5;
        resolve.push(vector(`g${g}-o${startOffsetMs}-p${p}`, music, position, sceneStartMs));
      });
    }
  });
  const gridless: ProjectMusic = {
    startOffsetMs: 0,
    cues: { raw: 2500.5, bar: "bar:3" },
    sections: {},
  };
  for (const position of ["bar:1", "cue:raw", "cue:bar"]) {
    resolve.push(vector(`nogrid-${position}`, gridless, position, 1000));
  }
  return {
    version: 1,
    resolve,
    rounding: ROUNDING.map((x) => ({ x, out: roundMs(x) })),
    sidecars: SIDECARS.map(sidecarVector),
  };
}

export function serialiseMusicVectors(vectors: MusicVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
