import { Channel, invoke } from "@tauri-apps/api/core";
import type { ExportOptions, ExportProgress } from "./exporter";
import { setExporting, withExporting } from "./exportState";
import { isWorkspaceBackedProjectId, nativeProjectSlug } from "./project";
import { stage, stageExportOptions } from "./stageHandle";
import type { StillsWarning } from "./stillPages";
import { type StillsFormat, type StillsSize, stillsPixelSize } from "./stills";

export { awaitPresentTimingsSettled } from "./stillsRun";

/** Stills export: the slideshow as a PDF handout or a PNG zip, one page per still, captured through the deterministic export path (same preamble, barriers and `renderComposited`) and streamed one page at a time to the native writer. See docs/stills.md. */

export interface StillsSettings {
  format: StillsFormat;
  size: StillsSize;
  /** The project's display name: the PDF title. */
  title: string;
  /** Manifest scene files, index-parallel to the slots; a scene name falls back to its stem. */
  sceneFiles?: readonly string[];
  /** Overrides `opts.destination`; "autorun" writes into the run's result dir (auto-runs only). */
  destination?: "downloads" | "autorun";
  /** Leaves out the PDF dates, author and app version, and pins the zip timestamps. */
  reproducible?: boolean;
  /** The folder inside a PNG zip; the native default is the output stem. */
  zipFolder?: string;
}

/** One page's verify digest: 64 tile hashes of the page-stage RGBA, plus its text layer and metadata JSON. */
export interface StillPageDigest {
  tiles: Uint32Array;
  text: string;
  meta: string;
}

export interface StillsExportResult {
  path: string;
  kind: StillsFormat;
  pages: number;
  bytes: number;
  /** The output file's SHA-256 (advisory for PDF: WebKit's JPEG encoder is not pinned). */
  sha256: string;
  /** Per page payload SHA-256 from the native writer (JPEG or PNG bytes). */
  pageSha256: string[];
  /** The PNG zip's folder. */
  zipFolder?: string;
  /** SHA-256 over every page hash: the stills baseline. */
  pagesHash: string;
  /** Per page SHA-256 of its page-stage tile hashes, metadata and text layer. */
  pageHashes: string[];
  /** Global ms each page renders at. */
  pageTimesMs: number[];
  warnings: StillsWarning[];
  digests: StillPageDigest[];
}

interface NativeStillsResult {
  path: string;
  kind: StillsFormat;
  pages: number;
  bytes: number;
  sha256: string;
  pageSha256: string[];
  zipFolder?: string;
}

/** Exports the project's stills (`opts.format` is the native aspect; the caller commits it to the editor first, as Verify legs do). The stage plans and renders every page (engine/stillsRun.ts); this realm streams each one to the native writer, which owns the PDF, the PNG encode and the zip. */
export async function exportStills(
  opts: ExportOptions,
  settings: StillsSettings,
  onProgress?: (p: ExportProgress) => void,
  /** UI overlay hook: reports each coarse export-preamble phase (1..3); UI only, never affects render. */
  onPrepareStep?: (step: number) => void,
): Promise<StillsExportResult> {
  return withExporting(() => exportStillsHeld(opts, settings, onProgress, onPrepareStep));
}

async function exportStillsHeld(
  opts: ExportOptions,
  settings: StillsSettings,
  onProgress?: (p: ExportProgress) => void,
  onPrepareStep?: (step: number) => void,
): Promise<StillsExportResult> {
  const s = stage();
  const { signal } = opts;
  signal?.throwIfAborted();
  const cancelNative = () => void invoke("cancel_stills_export").catch(() => {});
  let begun = false;
  try {
    const run = await s.stillsBegin(stageExportOptions(opts), settings, (step) => {
      onPrepareStep?.(step);
      signal?.throwIfAborted();
    });
    begun = true;
    signal?.throwIfAborted();
    const { width, height } = opts.format;
    const total = run.total;
    const page = stillsPixelSize(opts.format, settings.size);
    const slug = isWorkspaceBackedProjectId(opts.projectId)
      ? nativeProjectSlug(opts.projectId)
      : null;
    await invoke<string>("start_stills_export", {
      options: {
        kind: settings.format,
        projectId: slug ?? opts.projectId,
        projectSlug: slug,
        aspect: opts.format.name.replace(":", "x"),
        outputSuffix: opts.outputSuffix ?? null,
        destination: settings.destination ?? opts.destination ?? null,
        title: settings.title,
        formatWidth: width,
        formatHeight: height,
        pageWidth: page.width,
        pageHeight: page.height,
        totalPages: total,
        reproducible: settings.reproducible === true,
        zipFolder: settings.zipFolder ?? null,
      },
      onProgress: new Channel<ExportProgress>(),
    });
    signal?.addEventListener("abort", cancelNative, { once: true });

    const digests: StillPageDigest[] = [];
    const pageHashes: string[] = [];
    for (let i = 0; i < total; i++) {
      signal?.throwIfAborted();
      const out = await s.stillsPage(i);
      digests.push(out.digest);
      pageHashes.push(out.pageHash);
      await invoke("push_still", out.body, { headers: out.headers });
      onProgress?.({ frame: i + 1, total, stage: "render" });
    }
    signal?.throwIfAborted();
    const native = await invoke<NativeStillsResult>("finish_stills_export");
    return {
      ...native,
      pagesHash: await sha256Hex(new TextEncoder().encode(pageHashes.join("\n"))),
      pageHashes,
      pageTimesMs: run.pageTimesMs,
      warnings: run.warnings as StillsWarning[],
      digests,
    };
  } catch (err) {
    await invoke("cancel_stills_export").catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancelNative);
    if (begun) await s.stillsEnd().catch(() => {});
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first page two stills runs disagree on, at each level. */
export interface StillsDivergence {
  page: number;
  /** 8×8 tile indices (row-major) whose page-stage RGBA differed. */
  tiles: number[];
  text: boolean;
  meta: boolean;
  /** The encoded payload (JPEG or PNG) differed. */
  payload: boolean;
}

export interface StillsVerification {
  identical: boolean;
  /** Output file SHA-256 equal; required for PNG zips, advisory for PDFs. */
  fileIdentical: boolean;
  a: StillsExportResult;
  b: StillsExportResult;
  divergentPages: number[];
  firstDivergence?: StillsDivergence;
}

/** Compares two stills runs: page RGBA tiles, text layers and metadata must match, and a PNG zip's file bytes too; a PDF's JPEG and file bytes are reported but never fail it. */
export function compareStillsRuns(
  a: StillsExportResult,
  b: StillsExportResult,
  format: StillsFormat,
): StillsVerification {
  const fileIdentical = a.sha256 === b.sha256;
  const divergentPages: number[] = [];
  let firstDivergence: StillsDivergence | undefined;
  const pages = Math.max(a.digests.length, b.digests.length);
  for (let i = 0; i < pages; i++) {
    const da = a.digests[i];
    const db = b.digests[i];
    const tiles: number[] = [];
    for (let t = 0; t < 64; t++) if (da?.tiles[t] !== db?.tiles[t]) tiles.push(t);
    const text = da?.text !== db?.text;
    const meta = da?.meta !== db?.meta;
    const payload = a.pageSha256[i] !== b.pageSha256[i];
    const strict = tiles.length > 0 || text || meta || (format === "png-zip" && payload);
    if (strict) {
      divergentPages.push(i);
      firstDivergence ??= { page: i, tiles, text, meta, payload };
    }
  }
  const identical =
    a.pages === b.pages && divergentPages.length === 0 && (format === "pdf" || fileIdentical);
  return {
    identical,
    fileIdentical,
    a,
    b,
    divergentPages,
    ...(firstDivergence ? { firstDivergence } : {}),
  };
}

/** Pass B's output suffix: its own file beside pass A's. */
export function verifyPassBSuffix(suffix: string | undefined): string {
  return suffix ? `${suffix}-b` : "b";
}

/** Stills Verify ×2: two runs in one boot under one export hold (the `verifyDeterminism` rationale: no preview frame lands between the passes). Pass B writes its own `-b` file inside pass A's zip folder, so both files stay for diffing and a PNG zip's bytes still compare. */
export async function verifyStills(
  opts: ExportOptions,
  settings: StillsSettings,
  onProgress?: (p: ExportProgress) => void,
): Promise<StillsVerification> {
  setExporting(true);
  try {
    const a = await exportStills(opts, settings, onProgress);
    const b = await exportStills(
      { ...opts, outputSuffix: verifyPassBSuffix(opts.outputSuffix) },
      { ...settings, zipFolder: a.zipFolder ?? settings.zipFolder },
      onProgress,
    );
    return compareStillsRuns(a, b, settings.format);
  } finally {
    setExporting(false);
  }
}
