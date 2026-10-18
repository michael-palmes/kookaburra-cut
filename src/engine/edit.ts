import { Channel, invoke } from "@tauri-apps/api/core";

/** Video-editor frontend over the native `edit` module (src-tauri/src/edit.rs): non-destructive edit-document CRUD, the second-window handoff, and the ffmpeg render. Mirrors the Rust `EditDoc` shape (camelCase serde). */

export interface EditSource {
  id: string;
  rel: string;
  /** A still image joins the timeline as freeze clips; absent = "video" (documents written before images were editable). */
  kind?: "video" | "image";
  width: number;
  height: number;
  /** Images probe as 0 fps / 0 ms: they have no span, only the hold their clips carry. */
  fps: number;
  durationMs: number;
}

export interface EditClip {
  id: string;
  sourceId: string;
  inMs: number;
  outMs: number;
  speed: number;
  startMs: number;
  /** Freeze frame: hold the source frame at `inMs` (== `outMs`) for this long on the timeline. Every clip of an image source carries one. */
  holdMs?: number;
  /** Static crop `[x, y, w, h]` normalised 0..1 across the SOURCE frame, on even source pixels; the render letterboxes it into the output. Absent = the whole frame. A cropped doc saves as version 3, which older app versions refuse to open. */
  crop?: [number, number, number, number];
  /** Keyed zoom: the framing glides between keys and holds outside them. Never beside `crop`; one key (or keys that never move) renders exactly like a static crop. Saves as version 3. */
  zoom?: EditZoom;
}

export type EditZoomEase = "linear" | "smooth";

/** One zoom key: the framing at a clip-local OUTPUT moment. */
export interface EditZoomKey {
  /** Integer clip-local output ms on the output frame grid; a split or trim can leave a key before the clip's start or past its end. */
  tMs: number;
  /** `[x, y, w, h]` normalised 0..1 across the SOURCE frame at the output's shape, on even source pixels. */
  rect: [number, number, number, number];
  /** How the glide from this key to the next eases; absent = linear. */
  ease?: EditZoomEase;
}

export interface EditZoom {
  /** Sorted by `tMs`, one key per output frame, at least one. */
  keys: EditZoomKey[];
}

export interface EditSettings {
  width: number;
  height: number;
  fps: number;
}

/** A tap highlight: a glow-dot animation composited over the render at a source moment. Anchored in SOURCE time so it survives re-slicing; a duplicated segment shows it in each copy. */
export interface EditTap {
  id: string;
  sourceId: string;
  /** Integer source ms (persisted times stay integers, u64 on the Rust side). */
  sourceMs: number;
  /** Normalised 0..1 across the SOURCE video frame. */
  pos: [number, number];
}

export type EditMaskStyle = "solid" | "blur" | "pixelate";

/** One mask keyframe: the box at a source moment. */
export interface EditMaskKey {
  /** Integer source ms. */
  sourceMs: number;
  /** `[x, y, w, h]` normalised 0..1 across the SOURCE frame. */
  rect: [number, number, number, number];
}

/** A privacy mask: a box hiding part of a source over the source span `[startMs, endMs)`, gliding linearly between keys (held before the first and after the last). Rendered onto the source before it is cut into clips, so every clip, speed and freeze of that span inherits it. A still's mask ignores the span and uses its first key. */
export interface EditMask {
  id: string;
  sourceId: string;
  style: EditMaskStyle;
  /** 0..1 across the blur/pixelate range above its safe floor; absent = the default. */
  strength?: number;
  /** Solid fill, `#rrggbb`; absent = black. */
  color?: string;
  startMs: number;
  endMs: number;
  /** Integer source ms the mask fades in over from `startMs` and out over before `endMs` (sum <= the span); absent = a hard edge. Still in version 2: an older app drops them and renders hard edges, never less hiding. */
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Sorted by `sourceMs`, unique times. */
  keys: EditMaskKey[];
}

export interface EditDoc {
  version: number;
  name: string;
  sources: EditSource[];
  settings: EditSettings;
  clips: EditClip[];
  taps?: EditTap[];
  /** Tap style (shape) id (tapStyles.generated.ts); absent = the default style. */
  tapStyle?: string;
  /** Tap colour id (tapStyles.generated.ts); absent = the default colour. */
  tapColor?: string;
  /** Tap size multiplier on the default dot size; absent = 1.25. */
  tapSize?: number;
  /** Privacy masks. A masked document saves as version 2 (3 with a crop or zoom), which older app versions refuse to open. */
  masks?: EditMask[];
  /** The side-by-side reference pairing (scene matching); editor convenience, never read by renders. Older app versions strip it on their next autosave, which only forgets the pairing. */
  reference?: { rel: string; offsetMs: number };
}

export interface EditTarget {
  slug: string;
  name: string;
  /** Absolute project folder; source URLs build from it (asset protocol). */
  path: string;
  /** The originating source video; fuels `resetEdit` when the document is corrupt. */
  sourceRel: string;
  /** The scene the edit was opened from; feeds the reference dropdown's media inventory. */
  sceneIndex?: number;
}

export interface RenderProgress {
  frame: number;
  total: number;
}

/** Creates or opens an edit for a source video and opens the editor window on it (main-window side); returns the edit name (the slugified source stem). */
export function openEdit(slug: string, sourceRel: string, sceneIndex?: number): Promise<string> {
  return invoke<string>("open_edit", { slug, sourceRel, sceneIndex: sceneIndex ?? null });
}

/** Open the editor on an EXISTING edit by name ("Open in editor" on a rendered output). */
export function openEditNamed(slug: string, name: string, sceneIndex?: number): Promise<string> {
  return invoke<string>("open_edit_named", { slug, name, sceneIndex: sceneIndex ?? null });
}

/** Recovery: back the broken document up as `.json.bak` and recreate it from the source. */
export function resetEdit(slug: string, name: string, sourceRel: string): Promise<EditDoc> {
  return invoke<EditDoc>("reset_edit", { slug, name, sourceRel });
}

/** The edit the editor window should open (read once on boot). */
export function getEditorTarget(): Promise<EditTarget | null> {
  return invoke<EditTarget | null>("get_editor_target");
}

export function loadEdit(slug: string, name: string): Promise<EditDoc> {
  return invoke<EditDoc>("load_edit", { slug, name });
}

/** A document write: its new content hash and stamp, and the stamp it replaced (null when the file was new). */
export interface EditWrite {
  hash: string;
  stamp: string;
  before: string | null;
}

/** The render record Rust writes beside the doc after every canonical render (`edits/.renders/<name>.json`). */
export interface EditRenderRecord {
  /** sha256 hex of the doc bytes that were rendered. */
  docHash: string;
  atMs: number;
  frames: number;
}

/** A loaded document with the hash and stamp of the bytes read, and its last render. */
export interface EditEntry {
  doc: EditDoc;
  hash: string;
  stamp: string;
  render: EditRenderRecord | null;
}

/** File stamps (`<mtime nanos>:<size>`) of the doc and its render record; null = missing. */
export interface EditStamps {
  doc: string | null;
  render: string | null;
}

/** Save against `baseHash` (the hash the editor last read or wrote); a stale base is refused with a `conflict:` error. A null base writes unconditionally (legacy). */
export function saveEdit(
  slug: string,
  name: string,
  doc: EditDoc,
  baseHash?: string | null,
): Promise<EditWrite> {
  return invoke<EditWrite>("save_edit", { slug, name, doc, baseHash: baseHash ?? null });
}

export function loadEditEntry(slug: string, name: string): Promise<EditEntry> {
  return invoke<EditEntry>("load_edit_entry", { slug, name });
}

export function editStamps(slug: string, name: string): Promise<EditStamps> {
  return invoke<EditStamps>("edit_stamps", { slug, name });
}

export function listEdits(slug: string): Promise<string[]> {
  return invoke<string[]>("list_edits", { slug });
}

/** A finished render: the project-relative output and the hash of the doc bytes it rendered. */
export interface EditRenderResult {
  rel: string;
  docHash: string;
}

/** Flatten an edit to `assets/<name>-edited.mp4`. */
export function renderEdit(
  slug: string,
  name: string,
  onProgress?: (p: RenderProgress) => void,
): Promise<EditRenderResult> {
  const channel = new Channel<RenderProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<EditRenderResult>("render_edit", { slug, name, onProgress: channel });
}
