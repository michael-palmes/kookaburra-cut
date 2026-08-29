import { invoke } from "@tauri-apps/api/core";
import { preloadSceneObjects } from "../toolkit/objects/preload";
import { type LoadedProject, sceneFileStem } from "./project";
import { captureFrameAt, withBorrowedClock } from "./snapshots";

/** Option previews: committed app-rendered preview assets for the inspector's option pickers (text-motion clips, shadow stills, stage/backdrop stills, New-scene kind stills, chart appearance stills, chart build-in clips), rendered from the dev-only `fixtures/preview-lab-*` projects (one per family: text, stage, chart, chart build-ins, one per background) via `pnpm kookaburra:run --action option-previews` and committed under `src/assets/option-previews/` beside `manifest.json` (per-set source hashes; the wrapper re-renders only stale sets, `--all` re-records everything). Missing assets degrade to swatch placeholders, never a broken card. Set naming (pinned in tests, MIRRORED by scripts/option-preview-stale.mjs): `textanim-<preset>` · `textlook-<preset>` · `shadow-<mode>` · `stage-<type>` · `kind-<sceneKind>` · `chart-<stylePreset>` · `chartanim-<buildIn>`; clips ship as `<set>.mp4` + `<set>-poster.jpg`, stills as `<set>.jpg`. */

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

/** Map preview-lab's scene stems to capture jobs (pure; the autorun action and its tests share it): `tm-<preset>` scenes render text-motion CLIPS (except `tm-none`, which is motionless, so one still is honest); `tl-<preset>` scenes render text-look CLIPS (a plain fade, the hover-play card); `bg-<shader>` scenes render animated-background CLIPS; `chartanim-<preset>` scenes render chart build-in CLIPS (the motion IS the option); `bgp-<shader>-<preset>` scenes render shader-preset STILLS (small tiles, motion already shown by the type card); `shadow-*` / `stage-*` / `kind-*` (New-scene kind cards) / `object-*` (object-picker cards) / `chart-*` (chart appearance cards, a settled chart) scenes are stills. Unknown stems are skipped, so lab experiments never break the batch. */
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
    } else if (stem.startsWith("tl-")) {
      jobs.push({ stem, set: `textlook-${stem.slice(3)}`, kind: "clip" });
    } else if (stem.startsWith("bgp-")) {
      jobs.push({ stem, set: stem, kind: "still" });
    } else if (stem.startsWith("bg-") || stem.startsWith("chartanim-")) {
      jobs.push({ stem, set: stem, kind: "clip" });
    } else if (
      stem.startsWith("shadow-") ||
      stem.startsWith("stage-") ||
      stem.startsWith("kind-") ||
      stem.startsWith("object-") ||
      stem.startsWith("chart-")
    ) {
      jobs.push({ stem, set: stem, kind: "still" });
    }
  }
  return jobs;
}

/** The set names a loaded lab project owns; the autorun action uses this to skip mounting projects with nothing stale. */
export function optionPreviewSetsOf(project: LoadedProject): string[] {
  return optionPreviewJobs(project.sceneFiles.map(sceneFileStem)).map((j) => j.set);
}

/** Capture option-preview sets off a loaded preview-lab project (the caller holds the usual project-commit + scene-hosts barriers): stills capture the scene middle; clips capture the whole scene window at `OPTION_CLIP_FPS`. `only` limits capture to the named stale sets (absent = all, the `--all` re-record). Frames land natively via `write_option_preview` (`<run result dir>/option-previews/<set>/NNN.jpg`, from `KOOKABURRA_RESULT_DIR` or the legacy `_autorun`); the `kookaburra:run` wrapper encodes clips, promotes everything staged into `src/assets/` and commits the captured sets' source hashes to the manifest. Returns the number of sets written, or null when capture isn't possible right now. */
export async function captureOptionPreviews(
  project: LoadedProject,
  only?: ReadonlySet<string>,
): Promise<number | null> {
  const stems = project.sceneFiles.map(sceneFileStem);
  const jobs = optionPreviewJobs(stems).filter((j) => !only || only.has(j.set));
  // Staged objects load async and this path skips the export preamble; without the barrier a card can capture the PREVIOUS frame's content (the lantern-mash bug).
  await preloadSceneObjects(project.sceneDocs);
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
