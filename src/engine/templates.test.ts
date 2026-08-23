import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "./format";
import type { ProjectManifest } from "./project";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";
import {
  BLANK_TEMPLATE_ID,
  findTemplate,
  TEMPLATE_CATEGORIES,
  TEMPLATE_PERSONAS,
  TEMPLATE_USES,
  type TemplateManifest,
  type TemplateManifestResult,
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

/** The four aspects every template serves; `app-store-preview-30` is the one sanctioned exception (Apple takes portrait captures only). */
const TEMPLATE_ASPECTS = ["16:9", "9:16", "1:1", "4:5"];
const ASPECT_EXCEPTIONS: Record<string, string[]> = { "app-store-preview-30": ["9:16"] };

interface Band {
  scenes: [number, number];
  totalMs: [number, number];
}

/** Scene-count and runtime bands per category, the per-category authoring contract for template batches, slack at the floor. */
const CATEGORY_BANDS: Record<string, Band> = {
  "app-updates": { scenes: [4, 8], totalMs: [12_000, 40_000] },
  "product-launch": { scenes: [4, 9], totalMs: [20_000, 50_000] },
  "marketing-social": { scenes: [4, 10], totalMs: [10_000, 35_000] },
  presentations: { scenes: [4, 12], totalMs: [25_000, 75_000] },
  "finance-crypto": { scenes: [4, 8], totalMs: [15_000, 40_000] },
  "ai-developer": { scenes: [4, 8], totalMs: [20_000, 65_000] },
};
const DEFAULT_BAND: Band = { scenes: [4, 8], totalMs: [8_000, 60_000] };
/** Apple's window, armed by `storeLegal`. */
const STORE_LEGAL_BAND: Band = { scenes: [4, 8], totalMs: [15_000, 30_000] };
/** The documented floor: Blank is one headline scene and belongs to no category. */
const BLANK_BAND: Band = { scenes: [1, 1], totalMs: [1_000, 10_000] };

const ASSET_FILE = /\.(png|jpe?g|webp|gif|svg|mp4|mov|m4v|webm|mp3|wav|m4a|glb|gltf|hdr|exr|csv)$/i;

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
    return { id, parsed, manifest: parsed.success ? parsed.data : undefined, project, sidecars };
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
  if (some((doc) => doc.videoWindow != null)) present.add("video-window");
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

function bandFor(entry: TemplateFolder): Band {
  if (entry.id === BLANK_TEMPLATE_ID) return BLANK_BAND;
  if (entry.manifest?.storeLegal) return STORE_LEGAL_BAND;
  const category = entry.manifest?.category;
  return (category && CATEGORY_BANDS[category]) || DEFAULT_BAND;
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

  it.each(templateIds)("%s targets every aspect a template must serve", (id) => {
    const formats = template(id).project?.formats ?? [];
    expect(formats.filter((aspect) => !(aspect in FORMATS))).toEqual([]);
    expect([...formats].sort()).toEqual([...(ASPECT_EXCEPTIONS[id] ?? TEMPLATE_ASPECTS)].sort());
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
