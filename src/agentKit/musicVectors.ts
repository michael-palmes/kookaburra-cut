import {
  type ProjectMusic,
  resolveMusicPosition,
  resolveSceneLocalMs,
  roundMs,
} from "../engine/musicTime";

/** Conformance vectors for kb's musical-position mirror (`scripts/kblib/music.py`): every case runs through the app's own resolver, and the kit must reproduce `projectMs` as the exact same double, its `js_round` and the scene-local ms. */

export interface MusicResolveVector {
  id: string;
  music: ProjectMusic;
  position: string;
  sceneStartMs: number;
  expect:
    | { ok: true; projectMs: number; rounded: number; sceneLocalMs: number }
    | { ok: false; code: string };
}

export interface MusicVectors {
  version: 1;
  resolve: MusicResolveVector[];
  rounding: { x: number; out: number }[];
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
  };
}

export function serialiseMusicVectors(vectors: MusicVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
