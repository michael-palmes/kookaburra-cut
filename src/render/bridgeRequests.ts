import { type AspectName, FORMATS, type FormatSpec } from "../engine/format";
import type { FontIssue, SceneLoadError, SceneLoadPhase } from "../engine/loadDiagnostics";
import { type LoadedProject, sceneFileStem } from "../engine/project";
import { collectSceneDocFontRefs } from "../engine/sceneDocSchema";
import { activeSceneIndex } from "../engine/sceneTimeline";
import { parseFontString } from "../theme/fontRef";

/** Pure halves of the bridge v2 service (docs/agent-kit.md, "The bridge (v2)"): request shaping, preset lookup and the `check` report. */

/** Mirror of bridge.rs's BRIDGE_KINDS (a test pins the two together). */
export const BRIDGE_KINDS = [
  "capture",
  "check",
  "fonts",
  "insertPreset",
  "mediaChanged",
  "openEdit",
] as const;
export type BridgeKind = (typeof BRIDGE_KINDS)[number];

/** Mirror of bridge.rs's NATIVE_KINDS: served by the app's Rust loop, never claimed by the render window. */
export const NATIVE_BRIDGE_KINDS = ["mediaChanged", "openEdit"] as const;

export function isNativeBridgeKind(kind: string | null | undefined): boolean {
  return (NATIVE_BRIDGE_KINDS as readonly string[]).includes(kind ?? "");
}

/** Frames per capture request; past this a contact sheet stops being readable. */
export const MAX_CAPTURE_FRAMES = 48;

export interface BridgeFrame {
  scene?: string | null;
  at?: number | null;
}

/** Mirror of bridge.rs's BridgeRequest; a request without `kind` is a v1 capture. */
export interface BridgeRequest {
  version: number;
  id: string;
  kind?: string | null;
  project?: string | null;
  scene?: string | null;
  at?: number | null;
  requestedAtMs: number;
  aspect?: string | null;
  frames?: BridgeFrame[] | null;
  sheet?: boolean | null;
  render?: boolean | null;
  refs?: string[] | null;
  listFamilies?: boolean | null;
  preset?: string | null;
  position?: number | null;
  name?: string | null;
  paths?: string[] | null;
  edit?: string | null;
  projectPath?: string | null;
}

/** v1 clients get v1 responses (same fields, extra ones ignored); everything else answers as v2. */
export function responseVersion(request: Pick<BridgeRequest, "kind" | "version">): 1 | 2 {
  return request.kind || request.version >= 2 ? 2 : 1;
}

/** The aspect a request renders at: its own override (any FORMATS aspect), else the editor's. */
export function requestFormat(
  aspect: string | null | undefined,
  editorAspect: string | null | undefined,
): FormatSpec {
  if (aspect != null) {
    const format = FORMATS[aspect as AspectName];
    if (!format) {
      throw new Error(`unknown aspect "${aspect}"; use one of ${Object.keys(FORMATS).join(", ")}`);
    }
    return format;
  }
  return FORMATS[(editorAspect ?? "16:9") as AspectName] ?? FORMATS["16:9"];
}

/** The frames a capture renders: the `frames` list, else the single top-level scene/at. */
export function requestFrames(
  request: BridgeRequest,
): { scene: string | null; at: number | null }[] {
  const frames = request.frames?.length
    ? request.frames
    : [{ scene: request.scene ?? null, at: request.at ?? null }];
  if (frames.length > MAX_CAPTURE_FRAMES) {
    throw new Error(`a capture takes at most ${MAX_CAPTURE_FRAMES} frames (got ${frames.length})`);
  }
  return frames.map((frame) => ({
    scene: frame.scene == null ? null : String(frame.scene),
    at: typeof frame.at === "number" && Number.isFinite(frame.at) ? frame.at : null,
  }));
}

/** Which scene a captured time landed in and how far into it, for the response and the sheet label. */
export function frameScene(
  project: Pick<LoadedProject, "slots" | "sceneFiles">,
  selector: string | null,
  tMs: number,
): { index: number; scene: string; at: number } {
  let index =
    selector === null
      ? activeSceneIndex(project.slots, tMs)
      : /^\d+$/.test(selector)
        ? Number(selector)
        : project.sceneFiles.findIndex((file) => sceneFileStem(file) === selector);
  if (!project.slots[index]) index = 0;
  const slot = project.slots[index];
  return {
    index,
    scene: sceneFileStem(project.sceneFiles[index] ?? ""),
    at: Math.round(tMs - (slot?.startMs ?? 0)) / 1000,
  };
}

/** Project-relative asset paths anywhere in one sidecar (string values only, deduplicated in order). */
export function collectAssetRefs(doc: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (/^(\.\/)?assets\/[^\n]*[^/\n]$/.test(value)) found.add(value.replace(/^\.\//, ""));
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(doc);
  return [...found];
}

export interface CheckScene {
  index: number;
  file: string;
  id: string;
  ok: boolean;
  phase?: SceneLoadPhase;
  error?: string;
  warnings: string[];
}

export interface CheckFont {
  ref: string;
  ok: boolean;
  error?: string;
  fallback?: string | null;
}

export interface CheckAsset {
  path: string;
  ok: boolean;
  error?: string;
}

export interface CheckReport {
  ok: boolean;
  scenes: CheckScene[];
  fonts: CheckFont[];
  assets: CheckAsset[];
  warnings: string[];
}

const fontKey = (ref: string) => {
  const { family, weight } = parseFontString(ref.trim());
  return `${family.toLowerCase()}@${weight}`;
};

/** The `check` response body from a real load: scene errors (load and render), font issues beside the faces that passed, and asset paths that are missing or misspelt. */
export function buildCheckReport(input: {
  project: Pick<
    LoadedProject,
    "sceneFiles" | "slots" | "sceneDocs" | "compareBDocs" | "healedSceneIds"
  > & {
    sceneErrors?: readonly SceneLoadError[];
    fontIssues?: readonly FontIssue[];
    loadWarnings?: readonly string[];
  };
  renderErrors?: readonly SceneLoadError[];
  assets?: readonly CheckAsset[];
}): CheckReport {
  const { project } = input;
  const assets = [...(input.assets ?? [])];
  const badAssets = new Map(assets.filter((a) => !a.ok).map((a) => [a.path, a.error ?? "missing"]));
  const errors = [...(project.sceneErrors ?? []), ...(input.renderErrors ?? [])];
  const scenes = project.sceneFiles.map((file, index): CheckScene => {
    const own = errors.filter((e) => e.index === index);
    const refs = [
      ...collectAssetRefs(project.sceneDocs[index]),
      ...collectAssetRefs(project.compareBDocs?.[index]),
    ];
    const warnings = [...new Set(refs)]
      .filter((path) => badAssets.has(path))
      .map((path) => `${path}: ${badAssets.get(path)}`);
    const scene: CheckScene = {
      index,
      file,
      id: project.slots[index]?.id ?? sceneFileStem(file),
      ok: own.length === 0,
      warnings,
    };
    if (own.length > 0) {
      scene.phase = own[0].phase;
      scene.error = [...new Set(own.map((e) => e.message))].join("; ");
    }
    return scene;
  });
  const issues = project.fontIssues ?? [];
  const issueKeys = new Set(issues.map((issue) => fontKey(issue.ref)));
  const fonts: CheckFont[] = [
    ...issues.map((issue) => ({
      ref: issue.ref,
      ok: false,
      error: issue.message,
      fallback: issue.fallback,
    })),
    ...collectSceneDocFontRefs(project.sceneDocs)
      .map((ref) => `${ref.family}@${ref.weight}`)
      .filter((ref) => !issueKeys.has(fontKey(ref)))
      .map((ref) => ({ ref, ok: true })),
  ];
  const warnings = [
    ...(project.healedSceneIds ?? []).map(
      (file) => `${file} shared its scene id with another scene, so it was given a new one`,
    ),
    ...(project.loadWarnings ?? []),
  ];
  return {
    ok: scenes.every((s) => s.ok) && fonts.every((f) => f.ok) && assets.every((a) => a.ok),
    scenes,
    fonts,
    assets,
    warnings,
  };
}

/** The catalogue fields preset lookup needs (a subset of PresetEntry). */
export interface PresetRefEntry {
  id: string;
  slug: string;
  projectId: string;
  name: string;
  source: string;
}

/** Resolve a preset ref the way the Add a scene gallery names them: `title`, `preset:title`, `ws-preset:<slug>` or `ws:<slug>`, then a unique display name. */
export function resolvePresetRef<T extends PresetRefEntry>(
  ref: string,
  entries: readonly T[],
): T | undefined {
  const wanted = ref.trim();
  if (wanted.startsWith("preset:") || wanted.startsWith("ws-preset:")) {
    return entries.find((entry) => entry.projectId === wanted);
  }
  if (wanted.startsWith("ws:")) return entries.find((entry) => entry.id === wanted);
  const exact =
    entries.find((entry) => entry.source !== "user" && entry.id === wanted) ??
    entries.find((entry) => entry.source === "user" && entry.slug === wanted);
  if (exact) return exact;
  const named = entries.filter((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

/** The project or preset a TrustDeniedError names, when it names one. */
export function trustDeniedSlug(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "TrustDeniedError") return null;
  return /"([^"]+)"/.exec(error.message)?.[1] ?? null;
}

/** The plain sentence a `needsTrust` response carries. */
export function trustSentence(label: string): string {
  return `"${label}" changed since you last allowed it to run in Kookaburra Cut (or has never been opened there), so the app won't run its scene code unseen. Open it in the app once and allow it, then try again.`;
}
