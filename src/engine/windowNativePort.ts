import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fsUrl, pendingConformMeta } from "./media";
import { nativeProjectSlug, resolveAssetPath } from "./project";
import {
  type ConformJobPayload,
  type ConformProgressPayload,
  type NativePort,
  parseClipSourceKey,
  setNativePort,
} from "./stageRealm";

/**
 * The window realm's native port: the only code that turns a clip source key into a path.
 * A cache directory is honoured only when this port handed it out (`clipInfo`), so a request
 * from the stage worker can read exactly the frames of the clips the open project registered,
 * nothing else on disk. Installed by every window entry before the stage worker starts.
 */

const issuedCacheDirs = new Set<string>();

function requireIssued(cacheDir: string): string {
  if (!issuedCacheDirs.has(cacheDir)) {
    throw new Error(`clip cache "${cacheDir}" was not issued to this window`);
  }
  return cacheDir;
}

function srcAbs(key: string): string {
  const { projectId, rel } = parseClipSourceKey(key);
  return resolveAssetPath(projectId, rel);
}

function frameFile(index: number, tier: "full" | "preview"): string {
  const stem = `frame-${String(index).padStart(5, "0")}`;
  return tier === "preview" ? `preview/${stem}.jpg` : `${stem}.png`;
}

export const windowNativePort: NativePort = {
  async clipRevisions(keys) {
    if (keys.length === 0) return [];
    const paths = keys.map(srcAbs);
    try {
      const revs = await invoke<(string | null)[]>("file_revisions", { paths });
      if (Array.isArray(revs) && revs.length === paths.length) return revs;
    } catch {
      // Unreadable stamps fall back to the full re-hash.
    }
    return paths.map(() => null);
  },
  async clipInfo(key, lane) {
    const info = await invoke<{ cacheDir: string } & Record<string, unknown>>("clip_info", {
      srcAbs: srcAbs(key),
      sha: null,
      hardware: lane === "hw",
    });
    issuedCacheDirs.add(info.cacheDir);
    return info as unknown as Awaited<ReturnType<NativePort["clipInfo"]>>;
  },
  clipHash(key) {
    return invoke<string>("hash_file", { path: srcAbs(key) });
  },
  async clipEnsureChunks(key, cacheDir, chunks, onProgress) {
    const channel = new Channel<{ frame: number; total: number }>();
    channel.onmessage = onProgress;
    await invoke("ensure_clip_chunks", {
      srcAbs: srcAbs(key),
      cacheDir: requireIssued(cacheDir),
      chunks,
      onProgress: channel,
    });
  },
  async clipEnsurePreviews(cacheDir, chunk) {
    await invoke("ensure_clip_previews", { cacheDir: requireIssued(cacheDir), chunk });
  },
  clipReadFrame(cacheDir, index, tier) {
    // Via the Rust command, not the fs plugin, so it works regardless of webview fs scope; a raw byte response resolves to an ArrayBuffer.
    return invoke<ArrayBuffer>("read_clip_frame", {
      path: `${requireIssued(cacheDir)}/${frameFile(index, tier)}`,
    });
  },
  async clipSetPins(dirs) {
    await invoke("set_clip_cache_pins", { dirs: dirs.map(requireIssued) });
  },
  clipConformPending(key) {
    return invoke<ConformJobPayload | null>("clip_conform_pending", { srcAbs: srcAbs(key) });
  },
  async watchConforms(handlers) {
    await listen<ConformProgressPayload>("kookaburra://conform-progress", ({ payload }) =>
      handlers.progress(payload),
    );
    await listen<{ slug?: string; paths?: string[]; origin?: string } | null>(
      "kookaburra://media-changed",
      ({ payload }) => {
        if (payload?.origin !== "conform" || !Array.isArray(payload.paths)) return;
        handlers.mediaChanged(payload.slug, payload.paths);
      },
    );
  },
  async conformPoster(slug, rel) {
    const meta = await pendingConformMeta(slug, { rel, original: "" });
    return invoke<ArrayBuffer>("read_media_thumb", { path: meta.posterPath });
  },
  async emojiRead(projectId, file) {
    // Through a command, not an asset URL: hidden folders are never served, and the bytes are the same write-once PNG.
    try {
      return await invoke<ArrayBuffer>("read_emoji_raster", {
        slug: nativeProjectSlug(projectId),
        key: file.replace(/\.png$/, ""),
      });
    } catch {
      return null;
    }
  },
  async emojiWrite(projectId, key, bytes) {
    await invoke("write_emoji_raster", bytes, {
      headers: { "x-kookaburra-slug": nativeProjectSlug(projectId), "x-kookaburra-key": key },
    });
  },
  async readObject(slug) {
    const listing = await invoke<{ json: string; dir: string }>("read_object", { slug });
    const manifest = JSON.parse(listing.json) as { glb?: unknown; thumbnail?: unknown };
    if (typeof manifest.glb !== "string" || !manifest.glb) {
      throw new Error(`object "${slug}" names no glb`);
    }
    const thumbnail = typeof manifest.thumbnail === "string" ? manifest.thumbnail : null;
    return {
      json: listing.json,
      glbUrl: fsUrl(`${listing.dir}/${manifest.glb}`),
      ...(thumbnail ? { thumbnailUrl: fsUrl(`${listing.dir}/${thumbnail}`) } : {}),
    };
  },
  decodePng(bytes) {
    return invoke<ArrayBuffer>("decode_png", bytes);
  },
};

/** Installs the port; every window entry calls it before anything renders. */
export function installWindowNativePort(): void {
  setNativePort(windowNativePort);
}
