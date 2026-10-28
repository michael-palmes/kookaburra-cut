import type { ProjectMusic } from "../engine/musicTime";
import { outgoingSceneTransitions } from "../engine/project";
import {
  type CutAlign,
  type CutEntry,
  keepCutsForTransition,
  type ResolvedCuts,
  resolveSceneCuts,
} from "../engine/sceneCuts";
import {
  buildSceneTimeline,
  resolveAt,
  type SceneSlot,
  type TransitionSpec,
  timelineTotalMs,
} from "../engine/sceneTimeline";
import { TRANSITION_CATALOG } from "../engine/transitionCatalog";

/** Conformance vectors for kb's timeline mirror (`scripts/kblib/film/timeline.py`): each manifest's scene list goes through the app's own `outgoingSceneTransitions`, `resolveSceneCuts`, `buildSceneTimeline` and `resolveAt`, so verify-export and the film checks place scenes exactly where the export does; `keeps` pin the transition picker's keep-the-cut plan. */

interface ManifestScenes {
  version?: number;
  scenes: { durationMs: number; transition?: TransitionSpec; cutAt?: string; align?: CutAlign }[];
}

export interface TimelineVector {
  id: string;
  manifest: ManifestScenes;
  /** Present on pinned-cut cases: what the cuts resolve against, and how they resolved. */
  music?: ProjectMusic;
  cuts?: ResolvedCuts;
  slots: SceneSlot[];
  totalMs: number;
  at: {
    tMs: number;
    active: { index: number; localMs: number }[];
    transition: { type: string; progress: number; fromIndex: number; toIndex: number } | null;
  }[];
}

export interface KeepVector {
  id: string;
  entries: CutEntry[];
  durations: number[];
  index: number;
  spec: TransitionSpec | null;
  music?: ProjectMusic;
  out: ReturnType<typeof keepCutsForTransition>;
}

export interface TimelineVectors {
  version: 1;
  cases: TimelineVector[];
  keeps: KeepVector[];
}

// 120 bpm in 4/4 with bar 1 at 250 ms of the track and the soundtrack starting 100 ms in.
const GRID_MUSIC: ProjectMusic = {
  grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
  startOffsetMs: 100,
  cues: { drop: "bar:5.3" },
  sections: {},
};
const ODD_MUSIC: ProjectMusic = {
  grid: { bpm: 93.5, offsetMs: 1234.567, beatsPerBar: 3 },
  startOffsetMs: 0,
  cues: {},
  sections: {},
};

const t = (type: string, durationMs: number, extra: Partial<TransitionSpec> = {}): TransitionSpec =>
  ({ type, durationMs, ...extra }) as TransitionSpec;

const CASES: { id: string; manifest: ManifestScenes; music?: ProjectMusic }[] = [
  { id: "empty", manifest: { version: 2, scenes: [] } },
  { id: "one-scene", manifest: { version: 2, scenes: [{ durationMs: 4000 }] } },
  {
    id: "crossfade",
    manifest: {
      version: 2,
      scenes: [{ durationMs: 2000, transition: t("crossfade", 600) }, { durationMs: 2000 }],
    },
  },
  {
    id: "hard-cuts",
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 1000 },
        { durationMs: 1500, transition: t("dip", 0) },
        { durationMs: 900 },
      ],
    },
  },
  {
    id: "clamped-by-the-shorter-neighbour",
    manifest: {
      version: 2,
      scenes: [{ durationMs: 1800, transition: t("push", 5000) }, { durationMs: 1200 }],
    },
  },
  {
    id: "short-scene-eaten-by-both-overlaps",
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 2000, transition: t("crossfade", 600) },
        { durationMs: 400, transition: t("wipe", 600, { direction: [0, 1] }) },
        { durationMs: 2000 },
      ],
    },
  },
  {
    id: "legacy-incoming-transitions",
    manifest: {
      scenes: [
        { durationMs: 2000, transition: t("zoom", 300) },
        { durationMs: 2000, transition: t("crossfade", 500) },
        { durationMs: 1500, transition: t("dip", 250, { color: "#000000" }) },
      ],
    },
  },
  {
    id: "unknown-type-degrades-to-crossfade",
    manifest: {
      version: 2,
      scenes: [{ durationMs: 1500, transition: t("sparkle", 400) }, { durationMs: 1500 }],
    },
  },
  {
    id: "last-scene-transition-ignored",
    manifest: {
      version: 2,
      scenes: [{ durationMs: 1000 }, { durationMs: 1000, transition: t("crossfade", 500) }],
    },
  },
  {
    id: "fractional-durations",
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 1666.5, transition: t("crossfade", 333.25, { ease: "smooth" }) },
        { durationMs: 2333.75, transition: t("glitch", 120.5, { ease: "snappy" }) },
        { durationMs: 999 },
      ],
    },
  },
  {
    id: "every-catalogue-transition",
    manifest: {
      version: 2,
      scenes: [
        ...TRANSITION_CATALOG.map((entry, i) => ({
          durationMs: 1200 + (i % 3) * 300,
          transition: t(entry.type, entry.defaultDurationMs, {
            ...(i % 2 ? { ease: "smooth" as const } : {}),
          }),
        })),
        { durationMs: 1000 },
      ],
    },
  },
  {
    id: "pinned-cuts",
    music: GRID_MUSIC,
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 3000, transition: t("crossfade", 800), cutAt: "bar:3", align: "mid" },
        { durationMs: 1, transition: t("push", 500), cutAt: "cue:drop+40ms" },
        { durationMs: 2500, transition: t("dip", 300) },
        { durationMs: 1, cutAt: "bar:9.2.3", align: "mid" },
      ],
    },
  },
  {
    id: "pinned-cuts-odd-grid",
    music: ODD_MUSIC,
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 1777, transition: t("wipe", 333), cutAt: "bar:3.2", align: "mid" },
        { durationMs: 2222, transition: t("crossfade", 901), cutAt: "bar:5", align: "mid" },
        { durationMs: 1500 },
      ],
    },
  },
  {
    id: "pinned-cuts-that-cannot-resolve",
    music: GRID_MUSIC,
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 6000, transition: t("crossfade", 600) },
        { durationMs: 2000, cutAt: "bar:2" },
        { durationMs: 2000, cutAt: "cue:missing" },
        { durationMs: 2000, cutAt: "bar:nine" },
      ],
    },
  },
  {
    id: "pinned-cuts-without-a-grid",
    manifest: {
      version: 2,
      scenes: [
        { durationMs: 2000, transition: t("crossfade", 400), cutAt: "bar:2" },
        { durationMs: 2000 },
      ],
    },
  },
];

const KEEPS: Omit<KeepVector, "out">[] = [
  {
    id: "on-beat-cut-gets-pinned",
    entries: [
      { durationMs: 4150 },
      { durationMs: 4000 },
      { durationMs: 2000, transition: t("crossfade", 500) },
      { durationMs: 3000 },
    ],
    durations: [4150, 4000, 2000, 3000],
    index: 0,
    spec: t("crossfade", 800, { ease: "smooth" }),
    music: GRID_MUSIC,
  },
  {
    id: "off-beat-cut-held-by-length",
    entries: [{ durationMs: 4250 }, { durationMs: 4000 }, { durationMs: 3000 }],
    durations: [4250, 4000, 3000],
    index: 0,
    spec: t("push", 601),
    music: GRID_MUSIC,
  },
  {
    id: "pinned-follower-re-resolves",
    entries: [
      { durationMs: 4150 },
      { durationMs: 4000, cutAt: "bar:5", align: "mid", transition: t("dip", 400) },
      { durationMs: 3000 },
    ],
    durations: [4150, 4000, 3000],
    index: 0,
    spec: t("wipe", 700),
    music: GRID_MUSIC,
  },
  {
    id: "removing-a-transition",
    entries: [
      { durationMs: 4300, transition: t("crossfade", 800), cutAt: "bar:3", align: "mid" },
      { durationMs: 4400 },
      { durationMs: 3000 },
    ],
    durations: [4300, 4400, 3000],
    index: 0,
    spec: null,
    music: GRID_MUSIC,
  },
  {
    id: "no-grid",
    entries: [{ durationMs: 4000 }, { durationMs: 4000 }, { durationMs: 3000 }],
    durations: [4000, 4000, 3000],
    index: 1,
    spec: t("crossfade", 500),
  },
];

/** Instants worth pinning: both ends, every slot edge and midpoint, inside each overlap, and outside the timeline. */
function sampleTimes(slots: SceneSlot[]): number[] {
  const total = timelineTotalMs(slots);
  const times = new Set<number>([-50, 0, total, total + 1000]);
  for (const s of slots) {
    times.add(s.startMs);
    times.add(s.endMs);
    times.add(s.startMs + s.durationMs / 2);
    if (s.transitionIn) times.add(s.startMs + s.transitionIn.durationMs / 3);
  }
  return [...times].sort((a, b) => a - b);
}

export function buildTimelineVectors(): TimelineVectors {
  return {
    version: 1,
    cases: CASES.map(({ id, manifest, music }) => {
      const outgoing = outgoingSceneTransitions({
        version: manifest.version,
        scenes: manifest.scenes as never,
      });
      const pinned = music !== undefined || manifest.scenes.some((s) => s.cutAt !== undefined);
      const cuts = resolveSceneCuts(
        manifest.scenes.map((s, i) => ({
          durationMs: s.durationMs,
          transition: outgoing[i],
          cutAt: s.cutAt,
          align: s.align,
        })),
        music,
      );
      const slots = buildSceneTimeline(
        manifest.scenes.map((_, i) => ({
          id: `s${i}`,
          durationMs: cuts.durations[i],
          transition: outgoing[i],
        })),
      );
      return {
        id,
        manifest,
        ...(pinned ? { ...(music ? { music } : {}), cuts } : {}),
        slots: JSON.parse(JSON.stringify(slots)),
        totalMs: timelineTotalMs(slots),
        at: sampleTimes(slots).map((tMs) => {
          const r = resolveAt(slots, tMs);
          return {
            tMs,
            active: r.active,
            transition: r.transition
              ? {
                  type: r.transition.type,
                  progress: r.transition.progress,
                  fromIndex: r.transition.fromIndex,
                  toIndex: r.transition.toIndex,
                }
              : null,
          };
        }),
      };
    }),
    keeps: KEEPS.map((k) => ({
      ...k,
      out: keepCutsForTransition(k.entries, k.durations, k.index, k.spec, k.music),
    })),
  };
}

export function serialiseTimelineVectors(vectors: TimelineVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
