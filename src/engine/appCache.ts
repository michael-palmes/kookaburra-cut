import { invoke } from "@tauri-apps/api/core";

/** Settings-window frontend over src-tauri/src/settings_win.rs: cache sizes/clearing and sidecar version info. */

export interface CacheStats {
  mediaBytes: number;
  mediaEntries: number;
  clipsBytes: number;
  clipsEntries: number;
  /** The clip cache's cap; least recently used chunks go past it, never ones an open project or export needs. */
  clipsCapBytes: number;
}

/** The cap Settings starts at (native `DEFAULT_CAP_GB`). */
export const DEFAULT_CLIP_CACHE_CAP_GB = 20;

/** The caps Settings offers, in GB. */
export const CLIP_CACHE_CAP_OPTIONS_GB = [5, 10, 20, 50, 100, 200] as const;

/** A cap in whole GB from the native byte figure (GiB, the unit `formatBytes` prints as GB). */
export function capGb(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1024 ** 3));
}

/** The cap options with the current one included, in order. */
export function clipCacheCapOptions(current: number): number[] {
  return [...new Set<number>([...CLIP_CACHE_CAP_OPTIONS_GB, current])].sort((a, b) => a - b);
}

export function setClipCacheCap(gb: number): Promise<void> {
  return invoke("set_clip_cache_cap", { gb });
}

/** How a Clear went: done now, or deferred while a terminal run (another session's gate) is using the clip cache. */
export interface ClearOutcome {
  deferred: boolean;
}

export interface SidecarVersions {
  ffmpeg: string;
  ffprobe: string;
}

export function cacheStats(): Promise<CacheStats> {
  return invoke<CacheStats>("cache_stats");
}

export function clearMediaCache(): Promise<void> {
  return invoke("clear_media_cache");
}

/** Refused while an export is running (the export loop reads extracted frames); deferred while a terminal run is queued. */
export function clearClipsCache(): Promise<ClearOutcome> {
  return invoke<ClearOutcome>("clear_clips_cache");
}

export function sidecarVersions(): Promise<SidecarVersions> {
  return invoke<SidecarVersions>("sidecar_versions");
}

/** What the bundled sidecar's VideoToolbox support covers, probed live. */
export interface HardwareVideoSupport {
  decode: boolean;
  h264: boolean;
  hevc: boolean;
  prores: boolean;
}

export function hardwareVideoSupport(): Promise<HardwareVideoSupport> {
  return invoke<HardwareVideoSupport>("hardware_video_support");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
