import type { ComponentType } from "react";
import type { SceneModule } from "../toolkit/types";
import type { SceneLoadPhase } from "./loadDiagnostics";
import { compileSceneModule } from "./sceneCompiler";
import type { SceneCompileEntry, SceneCompileResult } from "./stageProtocol";

/**
 * Scene modules by key. The realm that compiles a module keeps its instance here (the stage
 * worker, or a window with its own canvas); a window that renders through the stage holds keys
 * only, and its `LoadedProject.scenes` carry stand-in components it never mounts. The
 * provider is how `loadProject` asks the right realm to compile.
 */

export interface SceneModuleProvider {
  compile(projectId: string, entries: SceneCompileEntry[]): Promise<SceneCompileResult[]>;
  /** The persistent (hoisted morph) module, compiled like a scene but default-exporting a plain component; rejects with a `SceneModuleError`. */
  compilePersistent(projectId: string, entry: SceneCompileEntry): Promise<{ key: string }>;
}

/** A scene module that failed to load, tagged with where: reading or compiling ("compile"), running its top level ("evaluate"), or its default export ("export"). */
export class SceneModuleError extends Error {
  readonly phase: SceneLoadPhase;
  constructor(phase: SceneLoadPhase, message: string) {
    super(message);
    this.name = "SceneModuleError";
    this.phase = phase;
  }
}

export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message;
}

/** esbuild's diagnostics without the "Scene … failed to compile:" lead line, so the first line names the problem. */
export function compileErrorDetail(message: string): string {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1 && /failed to compile:$/.test(lines[0])) lines.shift();
  return lines.join("\n");
}

type Loaded = { default: unknown };

/** Compiled module instances by key; a rejected compile evicts itself so a fixed scene recompiles on the next load. */
const modules = new Map<string, Promise<Loaded>>();
const settled = new Map<string, Loaded>();

let bundledLoader: ((path: string) => Promise<Loaded> | undefined) | null = null;

/** project.ts hands over its bundled scene glob, which only it can declare (Vite resolves `import.meta.glob` per module). */
export function setBundledSceneLoader(loader: (path: string) => Promise<Loaded> | undefined): void {
  bundledLoader = loader;
}

export function sceneModuleKey(projectId: string, entry: SceneCompileEntry): string {
  return entry.kind === "bundled"
    ? `bundled:${entry.path}`
    : `${projectId}/${entry.file}@${entry.token}`;
}

async function importEntry(entry: SceneCompileEntry): Promise<Loaded> {
  if (entry.kind === "bundled") {
    const load = bundledLoader?.(entry.path);
    if (!load) throw new SceneModuleError("compile", `"${entry.path}" is not a bundled scene`);
    try {
      return await load;
    } catch (e) {
      throw new SceneModuleError("evaluate", errorText(e));
    }
  }
  let url: string;
  try {
    url = await compileSceneModule(entry.source, entry.file);
  } catch (e) {
    throw new SceneModuleError("compile", compileErrorDetail(errorText(e)));
  }
  try {
    return (await import(/* @vite-ignore */ url)) as Loaded;
  } catch (e) {
    throw new SceneModuleError("evaluate", errorText(e));
  } finally {
    // The module is fully instantiated once the import resolves; the URL is done.
    URL.revokeObjectURL(url);
  }
}

function loadKeyed(key: string, entry: SceneCompileEntry): Promise<Loaded> {
  let pending = modules.get(key);
  if (!pending) {
    pending = importEntry(entry).then((loaded) => {
      settled.set(key, loaded);
      return loaded;
    });
    modules.set(key, pending);
    pending.catch(() => modules.delete(key));
  }
  return pending;
}

/** The in-realm provider: compiles here and keeps the instances. */
export const localSceneModuleProvider: SceneModuleProvider = {
  compilePersistent: (projectId, entry) => compilePersistentModule(projectId, entry),
  async compile(projectId, entries) {
    return Promise.all(
      entries.map(async (entry): Promise<SceneCompileResult> => {
        const key = sceneModuleKey(projectId, entry);
        try {
          const scene = (await loadKeyed(key, entry)).default as Partial<SceneModule> | undefined;
          if (!scene || typeof scene.Scene !== "function") {
            return {
              ok: false,
              phase: "export",
              message: "it must default-export defineScene({ id, durationMs, Scene })",
            };
          }
          return { ok: true, id: String(scene.id), durationMs: Number(scene.durationMs), key };
        } catch (e) {
          return e instanceof SceneModuleError
            ? { ok: false, phase: e.phase, message: e.message }
            : { ok: false, phase: "evaluate", message: errorText(e) };
        }
      }),
    );
  },
};

/** The persistent (hoisted morph) module's component for a key, compiled like a scene but default-exporting a plain component. */
export async function compilePersistentModule(
  projectId: string,
  entry: SceneCompileEntry,
): Promise<{ key: string }> {
  const key = sceneModuleKey(projectId, entry);
  const loaded = await loadKeyed(key, entry);
  if (typeof loaded.default !== "function") {
    throw new SceneModuleError("export", "it must default-export a component");
  }
  return { key };
}

/** The module instance behind a key, in the realm that compiled it. */
export function sceneModuleFor(key: string): SceneModule | undefined {
  const loaded = settled.get(key)?.default as Partial<SceneModule> | undefined;
  return loaded && typeof loaded.Scene === "function" ? (loaded as SceneModule) : undefined;
}

export function persistentComponentFor(key: string): ComponentType | undefined {
  const loaded = settled.get(key)?.default;
  return typeof loaded === "function" ? (loaded as ComponentType) : undefined;
}

let provider: SceneModuleProvider = localSceneModuleProvider;

/** A window that renders through the stage compiles there; everything else compiles in its own realm. */
export function setSceneModuleProvider(next: SceneModuleProvider | null): void {
  provider = next ?? localSceneModuleProvider;
}

export function sceneModuleProvider(): SceneModuleProvider {
  return provider;
}

/** The component a window mounts for a scene it does not hold: never rendered, the stage renders the real one. */
export const StageSceneStandIn: ComponentType = () => null;
