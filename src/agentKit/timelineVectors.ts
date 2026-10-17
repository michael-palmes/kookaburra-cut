import { outgoingSceneTransitions } from "../engine/project";
import {
  buildSceneTimeline,
  resolveAt,
  type SceneSlot,
  type TransitionSpec,
  timelineTotalMs,
} from "../engine/sceneTimeline";
import { TRANSITION_CATALOG } from "../engine/transitionCatalog";

/** Conformance vectors for kb's timeline mirror (`scripts/kblib/film/timeline.py`): each manifest's scene list goes through the app's own `outgoingSceneTransitions`, `buildSceneTimeline` and `resolveAt`, so verify-export and the film checks place scenes exactly where the export does. */

interface ManifestScenes {
  version?: number;
  scenes: { durationMs: number; transition?: TransitionSpec }[];
}

export interface TimelineVector {
  id: string;
  manifest: ManifestScenes;
  slots: SceneSlot[];
  totalMs: number;
  at: {
    tMs: number;
    active: { index: number; localMs: number }[];
    transition: { type: string; progress: number; fromIndex: number; toIndex: number } | null;
  }[];
}

export interface TimelineVectors {
  version: 1;
  cases: TimelineVector[];
}

const t = (type: string, durationMs: number, extra: Partial<TransitionSpec> = {}): TransitionSpec =>
  ({ type, durationMs, ...extra }) as TransitionSpec;

const CASES: { id: string; manifest: ManifestScenes }[] = [
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
    cases: CASES.map(({ id, manifest }) => {
      const outgoing = outgoingSceneTransitions({
        version: manifest.version,
        scenes: manifest.scenes as never,
      });
      const slots = buildSceneTimeline(
        manifest.scenes.map((s, i) => ({
          id: `s${i}`,
          durationMs: s.durationMs,
          transition: outgoing[i],
        })),
      );
      return {
        id,
        manifest,
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
  };
}

export function serialiseTimelineVectors(vectors: TimelineVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
