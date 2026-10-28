import type { ClipInfo, ClipLane, ClipTier } from "./clips";

/**
 * Which realm this module graph runs in, and the one door the stage worker has to native
 * data. Scene code and the renderer run in the stage worker, which has no Tauri IPC
 * (`docs/architecture.md`, "The stage worker"); every worker-bound engine module that needs
 * the native side asks through `nativePort()`, whose window implementation resolves names
 * against the open project and validates every handle before it invokes anything, and whose
 * worker implementation forwards over the stage protocol. Nothing here touches pixels.
 */

const inWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

/** True inside the stage worker. */
export function isStageWorker(): boolean {
  return inWorker;
}

/** A clip's source, named without a path: the owning project id and the project-relative file. */
export interface ClipSource {
  projectId: string;
  rel: string;
}

/** The registry key for a clip source: `<projectId>\u0001<rel>`. The worker never sees an absolute path; the window resolves one when it serves the request. */
export function clipSourceKey(source: ClipSource): string {
  return `${source.projectId}\u0001${source.rel}`;
}

export function parseClipSourceKey(key: string): ClipSource {
  const at = key.indexOf("\u0001");
  if (at < 0) throw new Error(`not a clip source key: ${key}`);
  return { projectId: key.slice(0, at), rel: key.slice(at + 1) };
}

export interface ConformJobPayload {
  slug: string;
  rel: string;
  frame: number;
  total: number;
}

export interface ConformProgressPayload extends ConformJobPayload {
  stage: string;
  error: string | null;
}

export interface ExtractProgress {
  frame: number;
  total: number;
}

/** What the render path may ask of the native side. Every clip method takes a clip source key or a cache directory the window itself issued through `clipInfo`. */
export interface NativePort {
  clipRevisions(keys: string[]): Promise<(string | null)[]>;
  clipInfo(key: string, lane: ClipLane): Promise<ClipInfo>;
  clipHash(key: string): Promise<string>;
  clipEnsureChunks(
    key: string,
    cacheDir: string,
    chunks: number[],
    onProgress: (p: ExtractProgress) => void,
  ): Promise<void>;
  clipEnsurePreviews(cacheDir: string, chunk: number): Promise<void>;
  clipReadFrame(cacheDir: string, index: number, tier: ClipTier): Promise<ArrayBuffer>;
  clipSetPins(dirs: string[]): Promise<void>;
  clipConformPending(key: string): Promise<ConformJobPayload | null>;
  /** Subscribes to conform progress and the media-changed broadcast; resolves once listening (or once it is known the events are unavailable). */
  watchConforms(handlers: {
    progress: (p: ConformProgressPayload) => void;
    mediaChanged: (slug: unknown, paths: string[]) => void;
  }): Promise<void>;
  /** A conforming clip's poster bytes, or null. */
  conformPoster(slug: string, rel: string): Promise<ArrayBuffer | null>;
  emojiRead(projectId: string, file: string): Promise<ArrayBuffer | null>;
  emojiWrite(projectId: string, key: string, bytes: Uint8Array): Promise<void>;
  /** A workspace 3D object's manifest text plus the URLs the window resolved for its glb and thumbnail. */
  readObject(slug: string): Promise<{ json: string; glbUrl: string; thumbnailUrl?: string }>;
}

let port: NativePort | null = null;

export function setNativePort(next: NativePort): void {
  port = next;
}

export function nativePort(): NativePort {
  if (!port) {
    throw new Error(
      inWorker
        ? "the stage worker's native port is not connected yet"
        : "the window's native port is not installed (engine/windowNativePort)",
    );
  }
  return port;
}
