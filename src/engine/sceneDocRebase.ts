import { readSceneDocEntry, writeSceneDoc } from "./sceneDoc";
import {
  isAppHash,
  isWriteConflict,
  type OutsideChangeAction,
  reportOutsideChange,
  sceneDocBase,
} from "./sceneDocBase";
import { detachSceneDocMusic, type SceneDocMusicScope } from "./sceneDocMusic";
import type { SceneDoc } from "./sceneDocSchema";

export interface RebasedSceneDocWrite {
  doc: SceneDoc;
  /** The document the written one was built from: `base`, or the fresh disk document after a conflict. */
  from: SceneDoc | undefined;
  rebased: boolean;
  /** The conflict came from outside the app (not the app's own newer write). */
  outside: boolean;
}

/** The conflict-aware sidecar write: writes `build(base)` over `base`'s hash; when the file changed first, re-reads it, rebuilds on the fresh document and writes that instead, reporting an outside change so the editor reloads. Null when `build` aborts. Never writes content derived from a stale document. With a music `scope`, a key whose `tMs` left its `at` position loses the `at` on the way out (the detach rule), so a move survives the next load. */
export async function writeSceneDocRebased(
  slug: string,
  sceneFile: string,
  base: SceneDoc | undefined,
  build: (from: SceneDoc | undefined) => SceneDoc | null,
  scope?: SceneDocMusicScope,
): Promise<RebasedSceneDocWrite | null> {
  const settle = (doc: SceneDoc | null) =>
    doc && scope ? detachSceneDocMusic(doc, scope.music, scope.sceneStartMs) : doc;
  const next = settle(build(base));
  if (!next) return null;
  try {
    await writeSceneDoc(slug, sceneFile, next, sceneDocBase(base));
    return { doc: next, from: base, rebased: false, outside: false };
  } catch (e) {
    if (!isWriteConflict(e)) throw e;
  }
  const docFile = sceneFile.replace(/\.tsx$/, ".json");
  const report = (action: OutsideChangeAction) =>
    reportOutsideChange({ slug, files: [docFile], action });
  let fresh: { doc: SceneDoc | undefined; hash: string };
  try {
    fresh = await readSceneDocEntry(slug, docFile);
  } catch (e) {
    report("dropped");
    throw new Error(`${docFile} changed outside the app and can't be read: ${String(e)}`);
  }
  const outside = !isAppHash(fresh.hash);
  const rebased = settle(build(fresh.doc));
  if (!rebased) {
    if (outside) report("reloaded");
    return null;
  }
  try {
    await writeSceneDoc(slug, sceneFile, rebased, fresh.hash);
  } catch (e) {
    report("dropped");
    throw e;
  }
  if (outside) report("rebased");
  return { doc: rebased, from: fresh.doc, rebased: true, outside };
}
