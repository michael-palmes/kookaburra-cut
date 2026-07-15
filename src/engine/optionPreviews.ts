import { invoke } from "@tauri-apps/api/core";
import { type LoadedProject, sceneFileStem } from "./project";
import { captureFrameAt, withBorrowedClock } from "./snapshots";

/** Option previews: committed app-rendered preview assets for the inspector's option pickers (text-motion clips, shadow stills, stage/backdrop stills), rendered from the dev-only `projects/preview-lab` project via `pnpm kookaburra:run --action option-previews` and committed under `src/assets/option-previews/`; missing assets degrade to swatch placeholders, never a broken card. Set naming (pinned in tests): `textanim-<preset>` · `shadow-<mode>` · `stage-<type>`; clips ship as `<set>.mp4` + `<set>-poster.jpg`, stills as `<set>.jpg`. */

/** Capture rate for clip sets; the generator captures one frame per 1000/fps ms. */
export const OPTION_CLIP_FPS = 20;
/** Downscale width for every option-preview capture. */
export const OPTION_PREVIEW_WIDTH = 320;

// A glob (not explicit imports) so not-yet-generated previews degrade to placeholders.
const assetGlob = import.meta.glob<string>("../assets/option-previews/*", {
  query: "?url",
  import: "default",
  eager: true,
});

/** The committed still for a set (`<set>.jpg`), or null. */
export function optionPreviewStill(set: string): string | null {
  return assetGlob[`../assets/option-previews/${set}.jpg`] ?? null;
}

/** The committed clip + poster pair for a set, or null when either is missing. */
export function optionPreviewClip(set: string): { clip: string; poster: string } | null {
  const clip = assetGlob[`../assets/option-previews/${set}.mp4`];
  const poster = assetGlob[`../assets/option-previews/${set}-poster.jpg`];
  return clip && poster ? { clip, poster } : null;
}

export interface OptionPreviewJob {
  /** preview-lab scene file stem. */
  stem: string;
  /** Output set name (the asset basename). */
  set: string;
  kind: "still" | "clip";
}

/** Map preview-lab's scene stems to capture jobs (pure; the autorun action and its tests share it): `tm-<preset>` scenes render text-motion CLIPS (except `tm-none`, which is motionless, so one still is honest); `bg-<shader>` scenes render animated-background CLIPS; `bgp-<shader>-<preset>` scenes render shader-preset STILLS (small tiles, motion already shown by the type card); `shadow-*` / `stage-*` scenes are stills. Unknown stems are skipped, so lab experiments never break the batch. */
export function optionPreviewJobs(stems: string[]): OptionPreviewJob[] {
  const jobs: OptionPreviewJob[] = [];
  for (const stem of stems) {
    if (stem.startsWith("tm-")) {
      const preset = stem.slice(3);
      jobs.push({
        stem,
        set: `textanim-${preset}`,
        kind: preset === "none" ? "still" : "clip",
      });
    } else if (stem.startsWith("bgp-")) {
      jobs.push({ stem, set: stem, kind: "still" });
    } else if (stem.startsWith("bg-")) {
      jobs.push({ stem, set: stem, kind: "clip" });
    } else if (stem.startsWith("shadow-") || stem.startsWith("stage-")) {
      jobs.push({ stem, set: stem, kind: "still" });
    }
  }
  return jobs;
}

/** Capture every option-preview set off the loaded preview-lab project (the caller holds the usual project-commit + scene-hosts barriers): stills capture the scene middle; clips capture the whole scene window at `OPTION_CLIP_FPS`. Frames land natively via `write_option_preview` (`~/Kookaburra Cut/_autorun/option-previews/<set>/NNN.jpg`); the `kookaburra:run` wrapper encodes clips and promotes everything into `src/assets/`. Returns the number of sets written, or null when capture isn't possible right now. */
export async function captureOptionPreviews(project: LoadedProject): Promise<number | null> {
  const stems = project.sceneFiles.map(sceneFileStem);
  const jobs = optionPreviewJobs(stems);
  return withBorrowedClock(async () => {
    for (const job of jobs) {
      const slot = project.slots[stems.indexOf(job.stem)];
      if (!slot) continue;
      const times: number[] = [];
      if (job.kind === "still") {
        times.push(Math.round(slot.startMs + slot.durationMs / 2));
      } else {
        const step = 1000 / OPTION_CLIP_FPS;
        for (let t = slot.startMs; t < slot.startMs + slot.durationMs - 1; t += step) {
          times.push(Math.round(t));
        }
      }
      for (let i = 0; i < times.length; i++) {
        const bytes = await captureFrameAt(times[i], OPTION_PREVIEW_WIDTH, "jpeg");
        if (!bytes) throw new Error(`option-previews: capture failed (${job.set} @${times[i]}ms)`);
        await invoke("write_option_preview", bytes, {
          headers: { "x-kookaburra-set": job.set, "x-kookaburra-index": String(i + 1) },
        });
      }
    }
    return jobs.length;
  });
}
