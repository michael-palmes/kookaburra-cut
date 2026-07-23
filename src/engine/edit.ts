import { Channel, invoke } from "@tauri-apps/api/core";

/** Video-editor frontend over the native `edit` module (src-tauri/src/edit.rs): non-destructive edit-document CRUD, the second-window handoff, and the ffmpeg render. Mirrors the Rust `EditDoc` shape (camelCase serde). */

export interface EditSource {
  id: string;
  rel: string;
  width: number;
  height: number;
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
  /** Freeze frame: hold the source frame at `inMs` (== `outMs`) for this long on the timeline. */
  holdMs?: number;
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

export interface EditDoc {
  version: number;
  name: string;
  sources: EditSource[];
  settings: EditSettings;
  clips: EditClip[];
  taps?: EditTap[];
  /** Tap style preset id (tapPresets.generated.ts); absent = the default preset. */
  tapStyle?: string;
}

export interface EditTarget {
  slug: string;
  name: string;
  /** Absolute project folder; source URLs build from it (asset protocol). */
  path: string;
  /** The originating source video; fuels `resetEdit` when the document is corrupt. */
  sourceRel: string;
}

export interface RenderProgress {
  frame: number;
  total: number;
}

/** Creates or opens an edit for a source video and opens the editor window on it (main-window side); returns the edit name (the slugified source stem). */
export function openEdit(slug: string, sourceRel: string): Promise<string> {
  return invoke<string>("open_edit", { slug, sourceRel });
}

/** Open the editor on an EXISTING edit by name ("Open in editor" on a rendered output). */
export function openEditNamed(slug: string, name: string): Promise<string> {
  return invoke<string>("open_edit_named", { slug, name });
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

export function saveEdit(slug: string, name: string, doc: EditDoc): Promise<void> {
  return invoke("save_edit", { slug, name, doc });
}

export function listEdits(slug: string): Promise<string[]> {
  return invoke<string[]>("list_edits", { slug });
}

/** Flatten an edit to `assets/<name>-edited.mp4`; resolves to the project-relative path. */
export function renderEdit(
  slug: string,
  name: string,
  onProgress?: (p: RenderProgress) => void,
): Promise<string> {
  const channel = new Channel<RenderProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<string>("render_edit", { slug, name, onProgress: channel });
}
