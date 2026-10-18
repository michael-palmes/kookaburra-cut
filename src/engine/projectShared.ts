import { createContext, useContext } from "react";

export type ProjectSharedValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectSharedValue[]
  | { readonly [key: string]: ProjectSharedValue };

/** The manifest's `shared` block: author constants (palette, timings) every scene can read. */
export type ProjectShared = { readonly [key: string]: ProjectSharedValue };

const EMPTY: ProjectShared = Object.freeze({});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A deep-frozen plain copy of `project.json` `shared`; anything but an object drops with a warning. */
export function parseProjectShared(raw: unknown, source: string): ProjectShared | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`[project] ${source}: shared must be an object, ignoring it`);
    return undefined;
  }
  return deepFreeze(JSON.parse(JSON.stringify(raw)) as ProjectShared);
}

/** The loaded project's `shared` block, provided beside `ProjectLightingContext` wherever scenes mount. */
export const ProjectSharedContext = createContext<ProjectShared | null>(null);

/** Walks a dotted path through objects and array indexes; `undefined` when any step is missing. */
export function resolveSharedPath(shared: ProjectShared, path: string): unknown {
  let node: unknown = shared;
  for (const part of path.split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(part)) {
      node = node[Number(part)];
    } else if (
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      Object.hasOwn(node, part)
    ) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

/** `project.json` `shared`: the whole block, or the value at a dotted path (`"palette.accent"`, `"beats.0"`), else `fallback`. */
export function useProjectShared(): ProjectShared;
export function useProjectShared<T = unknown>(path: string, fallback?: T): T;
export function useProjectShared(path?: string, fallback?: unknown): unknown {
  const shared = useContext(ProjectSharedContext) ?? EMPTY;
  if (!path) return shared;
  const value = resolveSharedPath(shared, path);
  return value === undefined ? fallback : value;
}
