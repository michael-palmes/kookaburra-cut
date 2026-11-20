import { describe, expect, it, vi } from "vitest";
import { BUILTIN_THEME_CATALOGUE, filterThemeCatalogue } from "../theme/catalogue";
import { clipFrameIndex } from "./clipFrame";
import { FORMATS } from "./format";
import { type ProjectManifest, sanitiseAudioMusic } from "./project";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";
import { resolveSceneDocMedia } from "./sceneMedia";
import {
  BLANK_TEMPLATE_ID,
  findTemplate,
  loopRangeInSlots,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_ALIASES,
  TEMPLATE_PERSONAS,
  TEMPLATE_USES,
  type TemplateManifest,
  type TemplateManifestResult,
  templateLoopRange,
  templateLoopTimes,
  templateManifestSchema,
  templateProjectId,
} from "./templates";

/**
 * The suite that replaces per-template verifies: template scenes are DATA and add no code paths,
 * so this is what a template batch actually gates on. It reads the committed tree, so it costs the
 * same at one template as at a hundred, and every check here is a drift class nothing else catches.
 */

// Discovery is the folder scan, not the registry: a manifest the schema rejects drops out of
// `listTemplates()` with a warning, and vanishing silently is exactly the failure to catch here.
const manifestGlob = import.meta.glob<unknown>("../../projects/*/template.json", {
  eager: true,
  import: "default",
});
const projectGlob = import.meta.glob<ProjectManifest>("../../projects/*/project.json", {
  eager: true,
  import: "default",
});
const sceneDocGlob = import.meta.glob<unknown>("../../projects/*/scenes/*.json", {
  eager: true,
  import: "default",
});
// Existence only: lazy globs are a map of loaders, so nothing here is read or decoded.
const sceneModuleGlob = import.meta.glob("../../projects/*/scenes/*.tsx");
const assetGlob = import.meta.glob("../../projects/*/assets/**", { query: "?url" });
const sharedSampleGlob = import.meta.glob("../../projects/_samples/*", { query: "?url" });
const fixtureManifestGlob = import.meta.glob("../../fixtures/**/template.json");

/** Version 1: the four aspects every template serves; `app-store-preview-30` is the one sanctioned exception (Apple takes portrait captures only). */
const V1_ASPECTS = ["16:9", "9:16", "1:1", "4:5"];
const V1_ASPECT_EXCEPTIONS: Record<string, string[]> = { "app-store-preview-30": ["9:16"] };
/** Version 2 is 16:9 only; Blank keeps all four, so a blank project starts in any shape. */
const V2_ASPECTS = ["16:9"];
const V2_ASPECT_EXCEPTIONS: Record<string, string[]> = { [BLANK_TEMPLATE_ID]: V1_ASPECTS };

interface Band {
  scenes: [number, number];
  totalMs: [number, number];
}

/** Version 1 scene-count and runtime bands, keyed by the category as authored, slack at the floor. */
const V1_CATEGORY_BANDS: Record<string, Band> = {
  "app-updates": { scenes: [4, 8], totalMs: [12_000, 40_000] },
  "product-launch": { scenes: [4, 9], totalMs: [20_000, 50_000] },
  "marketing-social": { scenes: [4, 10], totalMs: [10_000, 35_000] },
  presentations: { scenes: [4, 12], totalMs: [25_000, 75_000] },
  "finance-crypto": { scenes: [4, 8], totalMs: [15_000, 40_000] },
  "ai-developer": { scenes: [4, 8], totalMs: [20_000, 65_000] },
};
const V1_DEFAULT_BAND: Band = { scenes: [4, 8], totalMs: [8_000, 60_000] };
/** Version 2: launch films, one band per category so a category can diverge later. */
const LAUNCH_FILM_BAND: Band = { scenes: [8, 20], totalMs: [15_000, 60_000] };
const V2_CATEGORY_BANDS: Record<string, Band> = Object.fromEntries(
  TEMPLATE_CATEGORIES.map(({ id }) => [id, LAUNCH_FILM_BAND]),
);
/** One-take films: a single long scene is the form, so they keep the runtime band only. */
const ONE_TAKE_BAND: Band = { scenes: [1, 1], totalMs: LAUNCH_FILM_BAND.totalMs };
const V2_BAND_EXCEPTIONS: Record<string, Band> = {
  exhibition: ONE_TAKE_BAND,
  "one-dot": ONE_TAKE_BAND,
};
/** Apple's window, armed by `storeLegal`. */
const STORE_LEGAL_BAND: Band = { scenes: [4, 8], totalMs: [15_000, 30_000] };
/** The documented floor: Blank is one headline scene and belongs to no category. */
const BLANK_BAND: Band = { scenes: [1, 1], totalMs: [1_000, 10_000] };

const ASSET_FILE =
  /\.(png|jpe?g|webp|gif|svg|mp4|mov|m4v|webm|mp3|wav|m4a|flac|glb|gltf|hdr|exr|csv)$/i;

/** The looks a version 2 template may name: bundled themes the Look step lists. */
const VISIBLE_THEME_IDS = new Set(
  filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).map(({ id }) => id),
);

const categoryIds: readonly string[] = TEMPLATE_CATEGORIES.map((category) => category.id);
const personaIds: readonly string[] = TEMPLATE_PERSONAS;
const useIds: readonly string[] = TEMPLATE_USES;

/** Glob keys are relative to this file; the repo-relative path is what a failure message wants. */
const repoPath = (key: string) => key.replace(/^\.\.\/\.\.\//, "");
const folderId = (key: string) => key.split("/")[3];

/** Dev-only by convention: the preview labs and the `*-spike` fixtures, in either tree. */
const isDevFixture = (id: string) => id.startsWith("preview-lab") || id.endsWith("-spike");

interface TemplateFolder {
  id: string;
  /** As authored, so a version 1 band keys on the category it actually names. */
  raw: unknown;
  parsed: TemplateManifestResult;
  manifest: TemplateManifest | undefined;
  project: ProjectManifest | undefined;
  /** Sidecars as authored, so nothing the schema would drop is hidden from the asset scan. */
  sidecars: { file: string; raw: unknown }[];
}

const templates: TemplateFolder[] = Object.entries(manifestGlob)
  .map(([key, raw]) => {
    const id = folderId(key);
    const parsed = templateManifestSchema.safeParse(raw, `${id}/template.json`);
    const project = projectGlob[`../../projects/${id}/project.json`];
    const sidecars: { file: string; raw: unknown }[] = [];
    for (const scene of project?.scenes ?? []) {
      const file = scene.file.replace(/\.tsx$/, ".json");
      const sidecar = sceneDocGlob[`../../projects/${id}/${file}`];
      if (sidecar !== undefined) sidecars.push({ file, raw: sidecar });
    }
    const manifest = parsed.success ? parsed.data : undefined;
    return { id, raw, parsed, manifest, project, sidecars };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const templateIds = templates.map((entry) => entry.id);
const byId = new Map(templates.map((entry) => [entry.id, entry]));
const template = (id: string): TemplateFolder => {
  const found = byId.get(id);
  if (!found) throw new Error(`no template folder for "${id}"`);
  return found;
};

/** The sidecars parsed, with the warnings a bad document would emit on the way in. */
function sceneDocs(entry: TemplateFolder): { docs: SceneDoc[]; warnings: string[] } {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  const docs: SceneDoc[] = [];
  try {
    for (const sidecar of entry.sidecars) {
      const doc = parseSceneDoc(sidecar.raw, `${entry.id}/${sidecar.file}`);
      if (doc) docs.push(doc);
      else warnings.push(`${sidecar.file}: rejected by parseSceneDoc`);
    }
  } finally {
    warn.mockRestore();
  }
  return { docs, warnings };
}

/** What the scenes actually do, the mirror of the manifest's `uses`. */
function derivedUses(entry: TemplateFolder, docs: SceneDoc[]): Set<string> {
  const some = (predicate: (doc: SceneDoc) => boolean) => docs.some(predicate);
  const project = entry.project;
  const present = new Set<string>();
  if (some((doc) => (doc.devices?.length ?? 0) > 0)) present.add("device");
  if (some((doc) => (doc.devices?.length ?? 0) > 1 || doc.deviceLayout != null)) {
    present.add("multi-device");
  }
  if (some((doc) => doc.chart != null || doc.frame?.chart != null) || project?.frame?.chart) {
    present.add("chart");
  }
  if (some((doc) => doc.frame != null) || project?.frame != null) present.add("overlay");
  if (some((doc) => doc.cameraMode === "rig" || (doc.cameraRig?.keys.length ?? 0) > 0)) {
    present.add("camera-rig");
  }
  if (some((doc) => doc.layeredScreenshot != null)) present.add("layered-screenshot");
  if (
    some((doc) =>
      resolveSceneDocMedia(doc).some((entry) => entry.kind === "video" && entry.window != null),
    )
  ) {
    present.add("video-window");
  }
  if (some((doc) => doc.compare != null)) present.add("compare");
  if (some((doc) => (doc.objects?.length ?? 0) > 0)) present.add("objects");
  if (some((doc) => doc.textAnimation != null)) present.add("text-motion");
  if (some((doc) => doc.background != null || doc.backdrop != null)) present.add("background");
  if (project?.audio != null) present.add("audio");
  return present;
}

/** Every asset path a document references; the `text` map is user copy and never a path. */
function collectAssetRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (ASSET_FILE.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectAssetRefs(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "text") continue;
      collectAssetRefs(item, out);
    }
  }
  return out;
}

const isV2 = (entry: TemplateFolder) => (entry.manifest?.version ?? 1) >= 2;

function aspectsFor(entry: TemplateFolder): string[] {
  return isV2(entry)
    ? (V2_ASPECT_EXCEPTIONS[entry.id] ?? V2_ASPECTS)
    : (V1_ASPECT_EXCEPTIONS[entry.id] ?? V1_ASPECTS);
}

function bandFor(entry: TemplateFolder): Band {
  if (entry.id === BLANK_TEMPLATE_ID) return BLANK_BAND;
  if (isV2(entry)) {
    return (
      V2_BAND_EXCEPTIONS[entry.id] ??
      V2_CATEGORY_BANDS[entry.manifest?.category ?? ""] ??
      LAUNCH_FILM_BAND
    );
  }
  if (entry.manifest?.storeLegal) return STORE_LEGAL_BAND;
  const raw = entry.raw as { category?: unknown } | undefined;
  const authored = typeof raw?.category === "string" ? raw.category : "";
  return V1_CATEGORY_BANDS[authored] ?? V1_DEFAULT_BAND;
}

/** Runs `fn`, collecting what it warns instead of printing it. */
function warningsOf<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { result: fn(), warnings };
  } finally {
    warn.mockRestore();
  }
}

/** Version 2's added rules for a bundled template, as problems; empty is a pass. Version 1 manifests never reach it, so the old set keeps today's contract. */
function v2Problems(entry: TemplateFolder): string[] {
  const manifest = entry.manifest;
  const project = entry.project;
  if (!manifest || !project) return ["no parsed manifest or project.json"];
  const problems: string[] = [];
  if ((manifest.bring ?? []).length === 0) problems.push("bring lists nothing to supply");

  const audio = project.audio;
  if (manifest.song && !audio) problems.push("song names a track project.json doesn't play");
  if (!manifest.song && audio) problems.push("project.json plays audio with no song chip");
  if (manifest.song && audio) {
    const { result: music, warnings } = warningsOf(() => sanitiseAudioMusic(audio));
    problems.push(...warnings.map((warning) => `sanitiseAudioMusic: ${warning}`));
    if (!music.grid) problems.push("the song has no tempo grid");
    else {
      if (music.grid.bpm !== manifest.song.bpm) {
        problems.push(`song.bpm ${manifest.song.bpm} isn't the grid's ${music.grid.bpm}`);
      }
      if (!audio.grid?.source) problems.push("the grid ships without its source");
    }
    if ((music.sections?.length ?? 0) !== (audio.sections?.length ?? 0)) {
      problems.push("audio.sections lost entries to sanitiseAudioMusic");
    }
    const cues = Object.keys(audio.cues ?? {}).length;
    if (Object.keys(music.cues ?? {}).length !== cues) {
      problems.push("audio.cues lost entries to sanitiseAudioMusic");
    }
  }

  const looks = manifest.looks ?? [];
  for (const id of looks) {
    if (!VISIBLE_THEME_IDS.has(id)) problems.push(`look ${id} isn't a visible bundled theme`);
  }
  if (looks[0] !== project.themeId) {
    problems.push(`the first look (${looks[0]}) isn't project.json's themeId (${project.themeId})`);
  }
  for (const sidecar of entry.sidecars) {
    const doc = sidecar.raw as { themeId?: unknown } | null;
    if (doc && typeof doc === "object" && doc.themeId !== undefined) {
      problems.push(`${sidecar.file} pins themeId, which overrides the look`);
    }
  }

  const loop = manifest.preview.loop;
  if (!loop) problems.push("preview.loop names no window for the card loop");
  else if (!templateLoopRange(project, loop)) {
    problems.push("preview.loop starts outside its scene or runs past the end of the film");
  }
  return problems;
}

describe("bundled templates", () => {
  it("discovers every template by its template.json, Blank included", () => {
    expect(templateIds).toContain(BLANK_TEMPLATE_ID);
  });

  it("ships Blank's starter headline as template-managed text", () => {
    expect(sceneDocs(template(BLANK_TEMPLATE_ID)).docs[0]?.managedText).toEqual({
      layout: "template",
      items: [
        {
          key: "headline",
          type: "title",
          text: "Your video starts here",
        },
      ],
    });
  });

  it("keeps template.json off the preview labs and the spikes", () => {
    const offenders = [...Object.keys(manifestGlob), ...Object.keys(fixtureManifestGlob)]
      .filter((key) => isDevFixture(folderId(key)))
      .map(repoPath);
    expect(offenders).toEqual([]);
  });

  it("keeps template.json out of the fixtures tree entirely", () => {
    expect(Object.keys(fixtureManifestGlob).map(repoPath)).toEqual([]);
  });

  it("lands every template folder in the registry", () => {
    expect(templateIds.filter((id) => !findTemplate(id))).toEqual([]);
  });

  it("gives every template a unique order within its category", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const entry of templates) {
      const category = entry.manifest?.category;
      const order = entry.manifest?.order;
      if (!category || order === undefined) continue;
      const key = `${category}/${order}`;
      const first = seen.get(key);
      if (first) clashes.push(`${category} order ${order} in ${first} and ${entry.id}`);
      else seen.set(key, entry.id);
    }
    expect(clashes).toEqual([]);
  });
});

describe("template manifest categories", () => {
  const v1 = (category: string) => ({
    version: 1,
    name: "Older template",
    tagline: "",
    category,
    tags: [],
    personas: [],
    level: "standard",
    tier: "safe",
    uses: [],
    preview: { poster: 0, frames: [0, 0, 0, 0] },
    order: 10,
    status: "stable",
  });

  it.each(Object.entries(TEMPLATE_CATEGORY_ALIASES))(
    "reads version 1's %s as %s",
    (alias, category) => {
      expect(templateManifestSchema.parse(v1(alias)).category).toBe(category);
    },
  );

  it("files every alias under a shipped category", () => {
    const ids: readonly string[] = TEMPLATE_CATEGORIES.map(({ id }) => id);
    expect(Object.values(TEMPLATE_CATEGORY_ALIASES).filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("refuses a category nobody knows, prototype keys included", () => {
    expect(templateManifestSchema.safeParse(v1("finance")).success).toBe(false);
    expect(templateManifestSchema.safeParse(v1("constructor")).success).toBe(false);
  });
});

/** A version 2 manifest that passes the schema; tests override one field at a time. */
const v2Manifest = (over: Record<string, unknown> = {}) => ({
  version: 2,
  name: "Launch",
  tagline: "The one.",
  category: "launch",
  tags: [],
  personas: [],
  level: "standard",
  tier: "safe",
  uses: ["audio"],
  bring: ["Logo", "Three screen recordings"],
  song: { title: "First light", bpm: 128 },
  looks: ["kookaburra-onyx", "kookaburra-daylight", "kookaburra-ink"],
  preview: {
    poster: 0,
    frames: [0, 1, 2, 3],
    loop: { scene: 1, atMs: 500, durationMs: 6000 },
  },
  order: 1,
  status: "beta",
  ...over,
});

const issuePaths = (raw: unknown) => {
  const parsed = templateManifestSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path);
};

describe("template manifest version 2", () => {
  it("parses bring, song, looks and the loop window", () => {
    const manifest = templateManifestSchema.parse(v2Manifest());
    expect(manifest.bring).toEqual(["Logo", "Three screen recordings"]);
    expect(manifest.song).toEqual({ title: "First light", bpm: 128 });
    expect(manifest.looks).toEqual(["kookaburra-onyx", "kookaburra-daylight", "kookaburra-ink"]);
    expect(manifest.preview.loop).toEqual({ scene: 1, atMs: 500, durationMs: 6000 });
  });

  it("lets a template without a song or a loop leave them out", () => {
    const { song: _song, ...rest } = v2Manifest();
    const manifest = templateManifestSchema.parse({
      ...rest,
      preview: { poster: 0, frames: [0, 0, 0, 0] },
    });
    expect(manifest.song).toBeUndefined();
    expect(manifest.preview.loop).toBeUndefined();
  });

  it("needs bring and at least one look", () => {
    const { bring: _bring, looks: _looks, ...rest } = v2Manifest();
    expect(issuePaths(rest)).toEqual(["bring", "looks"]);
    expect(issuePaths(v2Manifest({ looks: [] }))).toEqual(["looks"]);
    expect(issuePaths(v2Manifest({ looks: ["a", "a"] }))).toEqual(["looks"]);
  });

  it("rejects a malformed song and loop field by field", () => {
    expect(issuePaths(v2Manifest({ song: { title: " ", bpm: 900, key: "D" } }))).toEqual([
      "song.key",
      "song.title",
      "song.bpm",
    ]);
    const preview = {
      poster: 0,
      frames: [0, 0, 0, 0],
      loop: { scene: -1, atMs: -5, durationMs: 0 },
    };
    expect(issuePaths(v2Manifest({ preview }))).toEqual([
      "preview.loop.scene",
      "preview.loop.atMs",
      "preview.loop.durationMs",
    ]);
  });

  it("keeps the version 1 ids out of a version 2 manifest", () => {
    expect(issuePaths(v2Manifest({ category: "app-updates" }))).toEqual(["category"]);
  });

  it("keeps the version 2 fields out of a version 1 manifest", () => {
    const { bring, song, looks } = v2Manifest();
    const preview = {
      poster: 0,
      frames: [0, 0, 0, 0],
      loop: { scene: 0, atMs: 0, durationMs: 6000 },
    };
    expect(
      issuePaths(v2Manifest({ version: 1, category: "update", bring, song, looks, preview })),
    ).toEqual(["bring", "song", "looks", "preview.loop"]);
  });

  it("ignores a manifest from a newer schema", () => {
    expect(issuePaths(v2Manifest({ version: 3 }))).toEqual(["version"]);
  });
});

describe("template loop window", () => {
  const film = {
    themeId: "kookaburra-studio-white",
    scenes: [
      { file: "scenes/01-a.tsx", durationMs: 4000 },
      {
        file: "scenes/02-b.tsx",
        durationMs: 4000,
        transition: { type: "crossfade", durationMs: 500 },
      },
      { file: "scenes/03-c.tsx", durationMs: 4000 },
    ],
  } as unknown as ProjectManifest;

  it("places the window in film time, across a transition and a cut", () => {
    expect(templateLoopRange(film, { scene: 1, atMs: 500, durationMs: 6000 })).toEqual({
      startMs: 4000,
      endMs: 10_000,
    });
  });

  it("refuses a window that starts outside its scene or overruns the film", () => {
    expect(templateLoopRange(film, { scene: 3, atMs: 0, durationMs: 1000 })).toBeNull();
    expect(templateLoopRange(film, { scene: 0, atMs: 4000, durationMs: 1000 })).toBeNull();
    expect(templateLoopRange(film, { scene: 2, atMs: 0, durationMs: 9000 })).toBeNull();
  });

  it("agrees with a loaded project's timeline", () => {
    const slots = [
      { startMs: 0, durationMs: 4000 },
      { startMs: 3500, durationMs: 4000 },
      { startMs: 7500, durationMs: 4000 },
    ];
    expect(loopRangeInSlots(slots, 11_500, { scene: 1, atMs: 500, durationMs: 6000 })).toEqual(
      templateLoopRange(film, { scene: 1, atMs: 500, durationMs: 6000 }),
    );
  });

  it("samples a six-second loop as 180 frames on the 30 fps clock", () => {
    const times = templateLoopTimes({ startMs: 4000, endMs: 10_000 });
    expect(times).toHaveLength(180);
    expect(times[0]).toBe(4000);
    expect(times[1]).toBe(4000 + 1000 / 30);
    expect(times.at(-1)).toBe(4000 + 179 * (1000 / 30));
  });

  it("steps a 60 fps clip evenly, not 1, 3, 2 frames", () => {
    const times = templateLoopTimes({ startMs: 0, endMs: 1000 });
    const clipFrames = times.slice(0, 6).map((t) => clipFrameIndex(t, 0, 60, 600));
    expect(clipFrames).toEqual([0, 2, 4, 6, 8, 10]);
  });
});

describe("template contract version 2", () => {
  const scene = (file: string, durationMs: number) => ({ file, durationMs });
  const folder = (
    manifest: Record<string, unknown> = {},
    project: Record<string, unknown> = {},
    sidecars: { file: string; raw: unknown }[] = [],
  ): TemplateFolder => {
    const raw = v2Manifest(manifest);
    const parsed = templateManifestSchema.safeParse(raw);
    return {
      id: "launch",
      raw,
      parsed,
      manifest: parsed.success ? parsed.data : undefined,
      project: {
        id: "launch",
        name: "Launch",
        themeId: "kookaburra-onyx",
        formats: ["16:9"],
        scenes: Array.from({ length: 8 }, (_, i) => scene(`scenes/0${i + 1}.tsx`, 2000)),
        audio: {
          file: "assets/first-light.flac",
          grid: {
            bpm: 128,
            offsetMs: 0,
            beatsPerBar: 4,
            source: { sha256: "0".repeat(64), analysisVersion: 1, tracker: "nn" },
          },
          sections: [{ id: "drop", from: "bar:9", to: "bar:13" }],
          cues: { hit: "bar:9" },
        },
        ...project,
      } as unknown as ProjectManifest,
      sidecars,
    };
  };

  it("passes a template that keeps every rule", () => {
    expect(v2Problems(folder())).toEqual([]);
  });

  it("ties the song chip to the soundtrack both ways", () => {
    expect(v2Problems(folder({}, { audio: undefined }))).toEqual([
      "song names a track project.json doesn't play",
    ]);
    const { song: _song, ...unsung } = v2Manifest();
    expect(v2Problems({ ...folder(), manifest: templateManifestSchema.parse(unsung) })).toEqual([
      "project.json plays audio with no song chip",
    ]);
    expect(v2Problems(folder({ song: { title: "First light", bpm: 120 } }))).toEqual([
      "song.bpm 120 isn't the grid's 128",
    ]);
  });

  it("needs the grid, its source, sections and cues to survive sanitising", () => {
    const audio = folder().project?.audio;
    const broken = folder(
      {},
      {
        audio: {
          ...audio,
          grid: { bpm: 128, offsetMs: 0 },
          sections: [{ id: "Drop", from: 1, to: 2 }],
        },
      },
    );
    const problems = v2Problems(broken);
    expect(problems).toContain("the grid ships without its source");
    expect(problems).toContain("audio.sections lost entries to sanitiseAudioMusic");
    expect(problems.some((problem) => problem.startsWith("sanitiseAudioMusic:"))).toBe(true);
  });

  it("holds the looks to visible bundled themes, the project theme first, unpinned by scenes", () => {
    const problems = v2Problems(
      folder({ looks: ["kookaburra-daylight", "kookaburra-studio-white"] }, {}, [
        { file: "scenes/01.json", raw: { version: 1, themeId: "kookaburra-onyx" } },
      ]),
    );
    expect(problems).toEqual([
      "look kookaburra-studio-white isn't a visible bundled theme",
      "the first look (kookaburra-daylight) isn't project.json's themeId (kookaburra-onyx)",
      "scenes/01.json pins themeId, which overrides the look",
    ]);
  });

  it("needs something to bring and a loop window inside the film", () => {
    const preview = {
      poster: 0,
      frames: [0, 0, 0, 0],
      loop: { scene: 7, atMs: 0, durationMs: 6000 },
    };
    expect(v2Problems(folder({ bring: [], preview }))).toEqual([
      "bring lists nothing to supply",
      "preview.loop starts outside its scene or runs past the end of the film",
    ]);
  });
});

describe("template manifest source", () => {
  const minimal = (over: Record<string, unknown> = {}) => ({
    version: 1,
    name: "Converted project",
    // A converted project ships an empty tagline until the details modal fills it in.
    tagline: "",
    tags: [],
    personas: [],
    level: "standard",
    tier: "safe",
    uses: [],
    preview: { poster: 0, frames: [0, 0, 0, 0] },
    order: 10,
    status: "stable",
    ...over,
  });

  it("accepts the manifest a converted project writes", () => {
    expect(templateManifestSchema.safeParse(minimal()).success).toBe(true);
  });

  it.each(["bundled", "pack", "user"])("accepts source %s", (source) => {
    expect(templateManifestSchema.parse(minimal({ source })).source).toBe(source);
  });

  it("rejects a source it doesn't know", () => {
    const parsed = templateManifestSchema.safeParse(minimal({ source: "downloaded" }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.path)).toEqual(["source"]);
  });

  it("marks a workspace template's entry as user-owned", () => {
    const entry = findTemplate(BLANK_TEMPLATE_ID);
    expect(entry?.source).toBe("bundled");
    expect(entry?.projectId).toBe(`template:${BLANK_TEMPLATE_ID}`);
    expect(templateProjectId("ws:mine")).toBe("ws-template:mine");
  });
});

describe.skipIf(templateIds.length === 0)("each bundled template", () => {
  it.each(templateIds)("%s carries a manifest the schema accepts", (id) => {
    const { parsed } = template(id);
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    expect(issues).toEqual([]);
  });

  it.each(templateIds)("%s ships a tagline (the schema allows an empty one)", (id) => {
    expect((template(id).manifest?.tagline ?? "").trim().length).toBeGreaterThan(0);
  });

  it.each(templateIds)("%s files itself under a known category and personas", (id) => {
    const entry = template(id);
    const category: string | undefined = entry.manifest?.category;
    const personas: readonly string[] = entry.manifest?.personas ?? [];
    if (id === BLANK_TEMPLATE_ID) expect(category).toBeUndefined();
    else expect(categoryIds).toContain(category);
    expect(personas.filter((persona) => !personaIds.includes(persona))).toEqual([]);
  });

  it.each(templateIds)("%s ships every scene file its project.json lists", (id) => {
    const entry = template(id);
    expect(entry.project).toBeDefined();
    const scenes = (entry.project?.scenes ?? []).map((scene) => scene.file);
    const persistent = entry.project?.persistent;
    const missing = (persistent ? [...scenes, persistent] : scenes).filter(
      (file) => !(`../../projects/${id}/${file}` in sceneModuleGlob),
    );
    expect(missing).toEqual([]);
  });

  it.each(templateIds)("%s has sidecars the scene-document schema accepts", (id) => {
    const entry = template(id);
    const { docs, warnings } = sceneDocs(entry);
    expect(warnings).toEqual([]);
    expect(docs.length).toBe(entry.sidecars.length);
  });

  it.each(templateIds)("%s targets the aspects its manifest version asks for", (id) => {
    const formats = template(id).project?.formats ?? [];
    expect(formats.filter((aspect) => !(aspect in FORMATS))).toEqual([]);
    expect([...formats].sort()).toEqual([...aspectsFor(template(id))].sort());
  });

  it.each(templateIds)("%s declares exactly the capabilities its scenes use", (id) => {
    const entry = template(id);
    const declared: readonly string[] = entry.manifest?.uses ?? [];
    expect(declared.filter((use) => !useIds.includes(use))).toEqual([]);
    const present = derivedUses(entry, sceneDocs(entry).docs);
    expect(declared.filter((use) => !present.has(use))).toEqual([]);
    expect([...present].filter((use) => !declared.includes(use)).sort()).toEqual([]);
  });

  it.each(templateIds)("%s resolves every asset it references", (id) => {
    const entry = template(id);
    const sources = [{ file: "project.json", raw: entry.project }, ...entry.sidecars];
    const problems: string[] = [];
    for (const source of sources) {
      for (const ref of collectAssetRefs(source.raw)) {
        if (!ref.startsWith("assets/") || ref.includes("..")) {
          problems.push(`${source.file}: "${ref}" isn't a project-relative assets/ path`);
        } else if (
          !(`../../projects/${id}/${ref}` in assetGlob) &&
          !(`../../projects/_samples/${ref.split("/").pop()}` in sharedSampleGlob)
        ) {
          problems.push(`${source.file}: "${ref}" is in neither ${id}/assets nor _samples`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(templateIds)("%s captures its previews from scenes that exist", (id) => {
    const entry = template(id);
    const preview = entry.manifest?.preview;
    if (!preview) return;
    const count = (entry.project?.scenes ?? []).length;
    const indices = [
      preview.poster,
      ...preview.frames.map((frame) => (typeof frame === "number" ? frame : frame.scene)),
    ];
    expect(indices.filter((index) => index >= count)).toEqual([]);
  });

  it.each(templateIds)("%s keeps the version 2 contract when it declares version 2", (id) => {
    const entry = template(id);
    expect(isV2(entry) ? v2Problems(entry) : []).toEqual([]);
  });

  it.each(templateIds)("%s stays inside its scene-count and runtime band", (id) => {
    const entry = template(id);
    const registered = findTemplate(id);
    const scenes = registered?.sceneCount ?? (entry.project?.scenes ?? []).length;
    const totalMs =
      registered?.durationMs ??
      (entry.project?.scenes ?? []).reduce((sum, scene) => sum + scene.durationMs, 0);
    const band = bandFor(entry);
    expect(scenes).toBeGreaterThanOrEqual(band.scenes[0]);
    expect(scenes).toBeLessThanOrEqual(band.scenes[1]);
    expect(totalMs).toBeGreaterThanOrEqual(band.totalMs[0]);
    expect(totalMs).toBeLessThanOrEqual(band.totalMs[1]);
  });
});
