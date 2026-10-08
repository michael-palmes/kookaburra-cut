/** A scene's display name, shared by the inspector and the stills export (bookmarks, page names). Pure. */

import type { SceneDoc } from "./sceneDocSchema";

/** The sidecar name, else the scene's largest mounted text (`largestSceneText`), else its file stem, else "Scene N" (1-based). */
export function sceneTitle(
  doc: Pick<SceneDoc, "name"> | null | undefined,
  derived: string | null | undefined,
  stem: string | null | undefined,
  index: number,
): string {
  return doc?.name ?? derived ?? stem ?? `Scene ${index + 1}`;
}
