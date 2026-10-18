import { useContext } from "react";
import { useEditorStore } from "../store/editorStore";
import { useAssetRevision } from "./assetRevisions";
import { resolveAssetUrl } from "./project";
import { ProjectIdContext } from "./sceneContext";

/** A project image's loadable URL (`resolveAssetUrl`, revision included) for the owning scene's project (`projectId` overrides it), re-rendering when the file is replaced in place. Null for no source or an unresolvable one, warned under `label` and never thrown, so a missing asset degrades to nothing instead of tearing down the canvas tree. Its own module so assetRevisions.ts stays free of project.ts. */
export function useProjectAssetUrl(
  src: string | null | undefined,
  label: string,
  projectId?: string,
): string | null {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const id = projectId ?? contextProjectId ?? storeProjectId;
  useAssetRevision(id, src);
  if (!src) return null;
  try {
    return resolveAssetUrl(id, src);
  } catch (e) {
    console.warn(`${label} "${src}" unresolved:`, e);
    return null;
  }
}
