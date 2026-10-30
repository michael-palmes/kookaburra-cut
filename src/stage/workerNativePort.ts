import type { PortMethod } from "../engine/stageProtocol";
import type { ConformProgressPayload, NativePort } from "../engine/stageRealm";

/** The stage worker's native port: every method is one request to the window, which resolves names and handles against the open project and performs the native call. Conform events arrive as notices the server feeds back through `deliverConform*`. */
export function createWorkerNativePort(
  call: (
    method: PortMethod,
    args: unknown[],
    onProgress?: (value: unknown) => void,
  ) => Promise<unknown>,
): NativePort & {
  deliverConformProgress(payload: ConformProgressPayload): void;
  deliverConformMediaChanged(slug: unknown, paths: string[]): void;
} {
  const conformHandlers: {
    progress: (p: ConformProgressPayload) => void;
    mediaChanged: (slug: unknown, paths: string[]) => void;
  }[] = [];
  return {
    clipRevisions: (keys) => call("clipRevisions", [keys]) as Promise<(string | null)[]>,
    clipInfo: (key, lane) => call("clipInfo", [key, lane]) as Promise<never>,
    clipHash: (key) => call("clipHash", [key]) as Promise<string>,
    clipEnsureChunks: (key, cacheDir, chunks, onProgress) =>
      call("clipEnsureChunks", [key, cacheDir, chunks], (value) =>
        onProgress(value as { frame: number; total: number }),
      ) as Promise<void>,
    clipEnsurePreviews: (cacheDir, chunk) =>
      call("clipEnsurePreviews", [cacheDir, chunk]) as Promise<void>,
    clipReadFrame: (cacheDir, index, tier) =>
      call("clipReadFrame", [cacheDir, index, tier]) as Promise<ArrayBuffer>,
    clipSetPins: (dirs) => call("clipSetPins", [dirs]) as Promise<void>,
    clipConformPending: (key) => call("clipConformPending", [key]) as Promise<never>,
    async watchConforms(handlers) {
      conformHandlers.push(handlers);
    },
    conformPoster: (slug, rel) => call("conformPoster", [slug, rel]) as Promise<ArrayBuffer | null>,
    emojiRead: (projectId, file) =>
      call("emojiRead", [projectId, file]) as Promise<ArrayBuffer | null>,
    emojiWrite: (projectId, key, bytes) =>
      call("emojiWrite", [projectId, key, bytes]) as Promise<void>,
    readObject: (slug) => call("readObject", [slug]) as Promise<never>,
    decodePng: (bytes) => call("decodePng", [bytes]) as Promise<ArrayBuffer>,
    deliverConformProgress(payload) {
      for (const h of conformHandlers) h.progress(payload);
    },
    deliverConformMediaChanged(slug, paths) {
      for (const h of conformHandlers) h.mediaChanged(slug, paths);
    },
  };
}
