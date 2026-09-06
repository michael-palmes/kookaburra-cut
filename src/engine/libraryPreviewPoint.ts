import { type AspectName, FORMATS, type FormatSpec } from "./format";
import type { LoadedProject } from "./project";

export type LibraryPreviewPoint =
  | number
  | {
      scene: number;
      atMs?: number;
      aspect?: AspectName;
      sceneFile?: string;
    };

export function parseLibraryPreviewPoint(raw: unknown): LibraryPreviewPoint | null {
  const index = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (index(raw)) return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const point = raw as Record<string, unknown>;
  if (!index(point.scene)) return null;
  if (
    point.atMs !== undefined &&
    (typeof point.atMs !== "number" || !Number.isFinite(point.atMs) || point.atMs < 0)
  )
    return null;
  if (
    point.aspect !== undefined &&
    (typeof point.aspect !== "string" || !Object.hasOwn(FORMATS, point.aspect))
  )
    return null;
  if (
    point.sceneFile !== undefined &&
    (typeof point.sceneFile !== "string" || !/^(\.\/)?scenes\/[^/]+\.tsx$/.test(point.sceneFile))
  )
    return null;
  return {
    scene: point.scene,
    ...(point.atMs === undefined ? {} : { atMs: point.atMs as number }),
    ...(point.aspect === undefined ? {} : { aspect: point.aspect as AspectName }),
    ...(point.sceneFile === undefined ? {} : { sceneFile: point.sceneFile as string }),
  };
}

export function libraryPreviewFormat(aspect: AspectName = "16:9"): FormatSpec {
  const source = FORMATS[aspect];
  const scale = 640 / Math.max(source.width, source.height);
  return {
    name: aspect,
    width: Math.round(source.width * scale),
    height: Math.round(source.height * scale),
  };
}

export function resolveLibraryPreviewPoint(
  raw: LibraryPreviewPoint,
  project: Pick<LoadedProject, "slots" | "sceneFiles">,
): { scene: number; atMs: number; aspect: AspectName } {
  const parsed = parseLibraryPreviewPoint(raw);
  if (parsed === null)
    throw new Error("The saved preview settings are invalid. Recapture this slot.");
  const point = typeof parsed === "number" ? { scene: parsed } : parsed;
  const normalise = (file: string) => file.replace(/^\.\//, "");
  const scene =
    point.sceneFile === undefined
      ? point.scene
      : project.sceneFiles.findIndex(
          (file) => normalise(file) === normalise(point.sceneFile as string),
        );
  const slot = project.slots[scene];
  if (!slot) throw new Error("The saved scene was removed. Recapture this slot.");
  const atMs = point.atMs ?? slot.durationMs * 0.5;
  if (atMs > slot.durationMs)
    throw new Error("The saved time is outside this scene. Recapture this slot.");
  return { scene, atMs, aspect: point.aspect ?? "16:9" };
}
