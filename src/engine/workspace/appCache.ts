import { invoke } from "@tauri-apps/api/core";

/** Settings-window frontend over src-tauri/src/settings_win.rs: cache sizes/clearing and sidecar version info. */

export interface CacheStats {
  mediaBytes: number;
  mediaEntries: number;
  clipsBytes: number;
  clipsEntries: number;
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

/** Refused while an export is running (the export loop reads extracted frames). */
export function clearClipsCache(): Promise<void> {
  return invoke("clear_clips_cache");
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
