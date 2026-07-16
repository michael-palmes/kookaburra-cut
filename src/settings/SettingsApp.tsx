import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  type CacheStats,
  cacheStats,
  clearClipsCache,
  clearMediaCache,
  formatBytes,
  type HardwareVideoSupport,
  hardwareVideoSupport,
  type SidecarVersions,
  sidecarVersions,
} from "../engine/appCache";
import { revealApp } from "../engine/reveal";
import { getSettings, setHardwareVideoSetting } from "../engine/workspace";

/** The Settings window: native titlebar, opened via the app menu (⌘,). V1: cache management (media previews + clip extractions) and read-only info (workspace path, sidecar versions, app version). */

export function SettingsApp() {
  // Fade the UI in on first commit (anti-flash reveal).
  useEffect(() => {
    revealApp();
  }, []);

  const [stats, setStats] = useState<CacheStats | null>(null);
  const [versions, setVersions] = useState<SidecarVersions | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [busy, setBusy] = useState<"media" | "clips" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hwEnabled, setHwEnabled] = useState<boolean | null>(null);
  const [hwSupport, setHwSupport] = useState<HardwareVideoSupport | null>(null);

  const refreshStats = useCallback(() => {
    cacheStats()
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refreshStats();
    sidecarVersions()
      .then(setVersions)
      .catch(() => setVersions(null));
    getSettings()
      .then((s) => {
        setWorkspace(s.workspaceRoot ?? null);
        setHwEnabled(!s.disableHardwareVideo);
      })
      .catch(() => setWorkspace(null));
    hardwareVideoSupport()
      .then(setHwSupport)
      .catch(() => setHwSupport(null));
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, [refreshStats]);

  const toggleHardware = useCallback((enabled: boolean) => {
    setHwEnabled(enabled);
    setHardwareVideoSetting(enabled).catch((e) => setError(String(e)));
  }, []);

  const hwDetail = hwSupport
    ? [
        hwSupport.h264 && "H.264",
        hwSupport.hevc && "HEVC",
        hwSupport.prores && "ProRes",
        hwSupport.decode && "decode",
      ]
        .filter(Boolean)
        .join(" · ") || "not available in this ffmpeg build"
    : "…";

  const clear = useCallback(
    (which: "media" | "clips") => {
      setBusy(which);
      setError(null);
      (which === "media" ? clearMediaCache() : clearClipsCache())
        .then(refreshStats)
        .catch((e) => setError(String(e)))
        .finally(() => setBusy(null));
    },
    [refreshStats],
  );

  return (
    <div className="settings-window">
      <section className="settings-section">
        <h2>Storage</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Media previews</span>
            <span className="muted settings-row-detail">
              {stats
                ? `${formatBytes(stats.mediaBytes)} · ${stats.mediaEntries} item${stats.mediaEntries === 1 ? "" : "s"}`
                : "…"}
            </span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !stats || stats.mediaBytes === 0}
            onClick={() => clear("media")}
            title="Posters, hover-scrub frames and probe data — regenerated on view"
          >
            {busy === "media" ? "Clearing…" : "Clear"}
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Clip extractions</span>
            <span className="muted settings-row-detail">
              {stats
                ? `${formatBytes(stats.clipsBytes)} · ${stats.clipsEntries} item${stats.clipsEntries === 1 ? "" : "s"}`
                : "…"}
            </span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !stats || stats.clipsBytes === 0}
            onClick={() => clear("clips")}
            title="VideoClip frame sequences — re-extracted on the next export"
          >
            {busy === "clips" ? "Clearing…" : "Clear"}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>Video</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Hardware acceleration</span>
            <span className="muted settings-row-detail">
              {`VideoToolbox: ${hwDetail} — speeds up media previews, video prep and editor renders; deterministic exports always use software`}
            </span>
          </div>
          <input
            type="checkbox"
            aria-label="Hardware acceleration"
            checked={hwEnabled ?? true}
            disabled={hwEnabled === null}
            onChange={(e) => toggleHardware(e.target.checked)}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>About</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Workspace</span>
            <span className="muted settings-row-detail settings-path" title={workspace ?? ""}>
              {workspace ?? "not set up yet"}
            </span>
          </div>
          {workspace && (
            <button
              type="button"
              className="btn"
              onClick={() => void invoke("reveal_in_finder", { path: workspace })}
            >
              Show in Finder
            </button>
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">ffmpeg</span>
            <span className="muted settings-row-detail settings-path" title={versions?.ffmpeg}>
              {versions?.ffmpeg ?? "…"}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">ffprobe</span>
            <span className="muted settings-row-detail settings-path" title={versions?.ffprobe}>
              {versions?.ffprobe ?? "…"}
            </span>
          </div>
        </div>
      </section>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <footer className="settings-footer muted">Kookaburra Cut {appVersion}</footer>
    </div>
  );
}
