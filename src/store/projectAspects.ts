import { type AspectName, FORMATS } from "../engine/format";

/** Each project's last preview aspect, keyed by loaded project id: a per-viewer convenience mirrored to localStorage, so a blocked or corrupt store only costs the memory across relaunches. */
const KEY = "kookaburra:project-aspects";

let cache: Record<string, unknown> | null = null;

function isAspect(value: unknown): value is AspectName {
  return typeof value === "string" && Object.hasOwn(FORMATS, value);
}

function remembered(): Record<string, unknown> {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function rememberedProjectAspect(projectId: string): AspectName | null {
  const last = remembered()[projectId];
  return isAspect(last) ? last : null;
}

/** The aspect a project opens in: the one it was last viewed in, else its first declared format, else 16:9. */
export function projectOpenAspect(projectId: string, formats: readonly string[]): AspectName {
  return rememberedProjectAspect(projectId) ?? formats.find(isAspect) ?? "16:9";
}

export function rememberProjectAspect(projectId: string, aspect: AspectName): void {
  const all = remembered();
  if (all[projectId] === aspect) return;
  all[projectId] = aspect;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the in-memory copy still restores it this session.
  }
}
