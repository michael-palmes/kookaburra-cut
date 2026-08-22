import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
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
import { formatUpdateStatus, useUpdateCheck } from "../engine/updates";
import {
  defaultWorkspaceRoot,
  getSettings,
  type LagWarningMode,
  moveWorkspace,
  setExportToDownloadsSetting,
  setHardwareVideoSetting,
  setLagWarningSetting,
  shortenPath,
  userHomeDir,
} from "../engine/workspace";
import { UpdateAvailableDialog } from "../ui/updateDialogs";
import { useNativeTextUndo } from "../ui/useNativeTextUndo";
import { PublisherPane } from "./PublisherPane";

/** The Settings window: native titlebar, opened via the app menu (⌘,). Cache management (media previews + clip extractions), the workspace location (the only place it can be changed, since first run no longer asks), the opt-in update lane (toggle + Check now), and read-only info (sidecar versions, app version). */

export function SettingsApp() {
  useNativeTextUndo();
  // Fade the UI in on first commit (anti-flash reveal).
  useEffect(() => {
    revealApp();
  }, []);

  const [stats, setStats] = useState<CacheStats | null>(null);
  const [versions, setVersions] = useState<SidecarVersions | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [busy, setBusy] = useState<"media" | "clips" | "workspace" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hwEnabled, setHwEnabled] = useState<boolean | null>(null);
  const [hwSupport, setHwSupport] = useState<HardwareVideoSupport | null>(null);
  const [lagWarning, setLagWarning] = useState<LagWarningMode | null>(null);
  const [downloadsExport, setDownloadsExport] = useState<boolean | null>(null);

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
        setLagWarning((s.lagWarning as LagWarningMode) ?? "off");
        setDownloadsExport(!s.keepExportsInProject);
      })
      .catch(() => setWorkspace(null));
    defaultWorkspaceRoot()
      .then(setDefaultRoot)
      .catch(() => setDefaultRoot(null));
    userHomeDir()
      .then(setHome)
      .catch(() => setHome(null));
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

  const changeLagWarning = useCallback((mode: LagWarningMode) => {
    setLagWarning(mode);
    setLagWarningSetting(mode).catch((e) => setError(String(e)));
  }, []);

  const toggleDownloadsExport = useCallback((enabled: boolean) => {
    setDownloadsExport(enabled);
    setExportToDownloadsSetting(enabled).catch((e) => setError(String(e)));
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

  // A move can take a while on a big workspace across volumes, so the whole row goes busy rather than one button.
  const relocate = useCallback((parent: string | null) => {
    setBusy("workspace");
    setError(null);
    moveWorkspace(parent)
      .then(setWorkspace)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null));
  }, []);

  const chooseLocation = useCallback(async () => {
    try {
      const picked = await openFolderPicker({
        directory: true,
        multiple: false,
        title: "Choose where Kookaburra Cut keeps your projects",
      });
      if (typeof picked === "string") relocate(picked);
    } catch (e) {
      setError(String(e));
    }
  }, [relocate]);

  // Manual checks only in this window; the launch check belongs to the main window.
  const updates = useUpdateCheck({ autoCheck: false });

  return (
    <div className="settings-window">
      <section className="settings-section">
        <h2>Workspace</h2>
        <div className="settings-row stacked">
          <div className="settings-row-text">
            <span className="settings-row-title">Location</span>
            <span className="muted settings-row-detail settings-path" title={workspace ?? ""}>
              {busy === "workspace"
                ? "Moving your projects…"
                : workspace
                  ? shortenPath(workspace, home)
                  : "not set up yet"}
            </span>
          </div>
          <div className="settings-row-actions">
            {workspace && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void invoke("reveal_in_finder", { path: workspace })}
              >
                Show in Finder
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy !== null || !workspace}
              onClick={() => void chooseLocation()}
              title="Moves your projects, themes and fonts to the folder you pick"
            >
              Change location…
            </button>
            {workspace && defaultRoot && workspace !== defaultRoot && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => relocate(null)}
                title={`Moves everything back to ${shortenPath(defaultRoot, home)}`}
              >
                Reset to default
              </button>
            )}
          </div>
        </div>
      </section>

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
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Playback slowdown badge</span>
            <span className="muted settings-row-detail">
              Shows the preview's framerate in a red badge when playback can't hold full speed.
              Sustained ignores brief hiccups; Strict flags any missed frames.
            </span>
          </div>
          <select
            className="select"
            aria-label="Playback slowdown badge"
            value={lagWarning ?? "off"}
            disabled={lagWarning === null}
            onChange={(e) => changeLagWarning(e.target.value as LagWarningMode)}
          >
            <option value="off">None</option>
            <option value="sustained">Sustained</option>
            <option value="strict">Strict</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Save exports to Downloads</span>
            <span className="muted settings-row-detail">
              Finished exports land in your Downloads folder; off keeps them in each project's
              exports folder. Terminal runs always use the project folder.
            </span>
          </div>
          <input
            type="checkbox"
            aria-label="Save exports to Downloads"
            checked={downloadsExport ?? true}
            disabled={downloadsExport === null}
            onChange={(e) => toggleDownloadsExport(e.target.checked)}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>Updates</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Check for updates on launch</span>
            <span className="muted settings-row-detail">
              Asks GitHub whether a newer release exists. No identifiers, nothing about your usage.
            </span>
          </div>
          <input
            type="checkbox"
            aria-label="Check for updates on launch"
            checked={updates.consent === "on"}
            disabled={updates.consent === "loading"}
            onChange={(e) => void updates.toggleConsent(e.target.checked)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Status</span>
            <span className="muted settings-row-detail">
              {formatUpdateStatus({
                phase: updates.phase,
                devBuild: updates.devBuild,
                error: updates.error,
                availableVersion: updates.available?.version ?? null,
                lastCheckedMs: updates.lastCheckedMs,
                nowMs: Date.now(),
              })}
            </span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={updates.phase !== "idle"}
            onClick={() => void updates.runCheck()}
            title="A one-off check; works without the launch toggle and stores nothing when it's off"
          >
            {updates.phase === "checking" ? "Checking…" : "Check now"}
          </button>
        </div>
      </section>

      <PublisherPane />

      <section className="settings-section">
        <h2>About</h2>
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
      {updates.offerVisible && updates.available && (
        <UpdateAvailableDialog
          version={updates.available.version}
          notes={updates.available.notes}
          installing={updates.phase === "installing"}
          installError={updates.installError}
          onLater={updates.dismissOffer}
          onInstall={() => void updates.install()}
        />
      )}
      <footer className="settings-footer muted">Kookaburra Cut {appVersion}</footer>
    </div>
  );
}
