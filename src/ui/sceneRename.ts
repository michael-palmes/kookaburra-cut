/** Inline-edit rules for the Project tab's scene manager. A row hosts its own rename and duration fields, so row-level handlers must stand aside while one is live: re-entering the rename would snap the field back to the saved name (a double-click there is macOS word selection), and opening the app's scene menu would replace WKWebView's own Cut/Copy/Paste one. */

export interface SceneEdit {
  index: number;
  text: string;
}

/** The list's inline-edit state: at most one row holds a live field. */
export interface SceneRowEdits {
  /** An op is in flight; interactions disable rather than queue. */
  busy: boolean;
  renaming: SceneEdit | null;
  timing: SceneEdit | null;
}

/** True while the row holds a live rename or duration field. */
function hasLiveEdit(index: number, edits: SceneRowEdits): boolean {
  return edits.renaming?.index === index || edits.timing?.index === index;
}

/** The rename a double-click or the menu's Rename should start, or null when the row must not take one. */
export function nextRename(
  scene: { index: number; name: string; hasDoc: boolean },
  edits: SceneRowEdits,
): SceneEdit | null {
  if (edits.busy || !scene.hasDoc) return null;
  if (hasLiveEdit(scene.index, edits)) return null;
  return { index: scene.index, text: scene.name };
}

/** The name to write on blur or Enter, or null when there is nothing to commit (cancelled, blank or unchanged). */
export function renameCommit(
  edit: SceneEdit | null,
  scenes: { index: number; name: string }[],
  commit: boolean,
): { index: number; name: string } | null {
  if (!commit || !edit) return null;
  const name = edit.text.trim();
  if (!name || name === scenes.find((s) => s.index === edit.index)?.name) return null;
  return { index: edit.index, name };
}

/** True when the row may open the app's scene menu. A row holding a live field lets the event through untouched, so WKWebView shows the field's own editing menu. */
export function canOpenSceneMenu(index: number, edits: SceneRowEdits): boolean {
  return !edits.busy && !hasLiveEdit(index, edits);
}
