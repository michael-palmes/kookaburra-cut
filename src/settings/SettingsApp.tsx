import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import {
  type CacheStats,
  cacheStats,
  capGb,
  clearClipsCache,
  clearMediaCache,
  clipCacheCapOptions,
  formatBytes,
  type HardwareVideoSupport,
  hardwareVideoSupport,
  type SidecarVersions,
  setClipCacheCap,
  sidecarVersions,
} from "../engine/appCache";
import {
  claudeAppInstalled,
  openClaudeDownload,
  openPrivacyPage,
  setClaudePreferences,
} from "../engine/claudeApp";
import { useManagedPolicy } from "../engine/managed";
import { setConformNewVideosSetting } from "../engine/media";
import { notePickedFolder } from "../engine/pickedFolders";
import { revealApp } from "../engine/reveal";
import {
  clearWebsiteData,
  listWebsiteData,
  type WebsiteDataRecord,
} from "../engine/sceneWebsiteNative";
import { formatUpdateStatus, useUpdateCheck } from "../engine/updates";
import {
  defaultWorkspaceRoot,
  getSettings,
  initWorkspace,
  type LagWarningMode,
  moveWorkspace,
  setExportToDownloadsSetting,
  setHardwareVideoSetting,
  setLagWarningSetting,
  shortenPath,
  userHomeDir,
} from "../engine/workspace";
import { ClaudeSpark, TerminalGlyph } from "../ui/ClaudeLauncher";
import { ManagedLock } from "../ui/ManagedLock";
import { UpdateAvailableDialog } from "../ui/updateDialogs";
import { useNativeTextUndo } from "../ui/useNativeTextUndo";
import { PublisherPane } from "./PublisherPane";

function ClearDataIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 4.5h9M6 4.5V3.2h4v1.3m-5.5 0 .6 8.3h5.8l.6-8.3M7 6.5v4.2m2-4.2v4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClipCacheIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 3.5h11v9h-11zM2.5 6h11M2.5 10h11M5 3.5v2.5M8 3.5v2.5M11 3.5v2.5M5 10v2.5M8 10v2.5M11 10v2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CacheLimitIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.6 11.5a5.5 5.5 0 1 1 10.8 0M8 10.2 10.6 6M3.5 13.5h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.5v7.5M5 7l3 3 3-3M3 12v1.5h10V12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PrivacyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5 3 3.5v4c0 3 2.2 5.4 5 6.5 2.8-1.1 5-3.5 5-6.5v-4L8 1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ConformIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 6.5A5 5 0 0 0 3.6 4.6M3 9.5a5 5 0 0 0 9.4 1.9M3.4 2.4v2.4h2.4M12.6 13.6v-2.4h-2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  const [conformNew, setConformNew] = useState<boolean | null>(null);
  const [claudeBuiltin, setClaudeBuiltin] = useState<boolean | null>(null);
  const [claudeFirstOpen, setClaudeFirstOpen] = useState<boolean | null>(null);
  const [claudeInstalled, setClaudeInstalled] = useState<boolean | null>(null);
  const [websiteData, setWebsiteData] = useState<WebsiteDataRecord[] | null>(null);
  const [websiteDataBusy, setWebsiteDataBusy] = useState<string | null>(null);
  const [clipsClearDeferred, setClipsClearDeferred] = useState(false);

  const refreshStats = useCallback(() => {
    cacheStats()
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, []);

  const refreshWebsiteData = useCallback(() => {
    listWebsiteData()
      .then(setWebsiteData)
      .catch((e) => {
        setWebsiteData([]);
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    refreshStats();
    refreshWebsiteData();
    sidecarVersions()
      .then(setVersions)
      .catch(() => setVersions(null));
    getSettings()
      .then((s) => {
        setWorkspace(s.workspaceRoot ?? null);
        setHwEnabled(!s.disableHardwareVideo);
        setLagWarning((s.lagWarning as LagWarningMode) ?? "off");
        setDownloadsExport(!s.keepExportsInProject);
        setConformNew(!s.disableConformNewVideos);
        setClaudeBuiltin(s.claudeBuiltinTerminal ?? false);
        setClaudeFirstOpen(!s.disableClaudeFirstOpen);
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
  }, [refreshStats, refreshWebsiteData]);

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

  const toggleConformNew = useCallback((enabled: boolean) => {
    setConformNew(enabled);
    setConformNewVideosSetting(enabled).catch((e) => setError(String(e)));
  }, []);

  const changeClaudeMode = useCallback((builtinTerminal: boolean) => {
    setClaudeBuiltin(builtinTerminal);
    setClaudePreferences({ builtinTerminal }).catch((e) => setError(String(e)));
  }, []);

  const toggleClaudeFirstOpen = useCallback((firstOpen: boolean) => {
    setClaudeFirstOpen(firstOpen);
    setClaudePreferences({ firstOpen }).catch((e) => setError(String(e)));
  }, []);

  // The main window changes these too (the launcher's ⋯ menu, the legacy rail's Use Claude app).
  useEffect(() => {
    const unlisten = listen("kookaburra://claude-preferences-changed", () => {
      getSettings()
        .then((s) => {
          setClaudeBuiltin(s.claudeBuiltinTerminal ?? false);
          setClaudeFirstOpen(!s.disableClaudeFirstOpen);
        })
        .catch(() => {});
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Re-checked on focus, so installing the app while this window waits shows up when the user returns.
  useEffect(() => {
    const check = () => {
      claudeAppInstalled()
        .then(setClaudeInstalled)
        .catch(() => setClaudeInstalled(false));
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
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
      (which === "media"
        ? clearMediaCache()
        : clearClipsCache().then((outcome) => setClipsClearDeferred(outcome.deferred))
      )
        .then(refreshStats)
        .catch((e) => setError(String(e)))
        .finally(() => setBusy(null));
    },
    [refreshStats],
  );

  // A lower cap evicts straight away, so the size refreshes once the native side has had a moment.
  const changeClipCap = useCallback(
    (gb: number) => {
      setError(null);
      setStats((s) => (s ? { ...s, clipsCapBytes: gb * 1024 ** 3 } : s));
      setClipCacheCap(gb)
        .then(() => setTimeout(refreshStats, 1500))
        .catch((e) => setError(String(e)));
    },
    [refreshStats],
  );

  // A move can take a while on a big workspace across volumes, so the whole row goes busy rather than one button. With no workspace yet (the default location failed at first run) the pick creates one instead; Rust confirms either natively, and a cancelled sheet answers null.
  const relocate = useCallback(
    (parent: string | null) => {
      setBusy("workspace");
      setError(null);
      const change = workspace || parent === null ? moveWorkspace(parent) : initWorkspace(parent);
      change
        .then((root) => {
          if (root) setWorkspace(root);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setBusy(null));
    },
    [workspace],
  );

  const chooseLocation = useCallback(async () => {
    try {
      const picked = await openFolderPicker({
        directory: true,
        multiple: false,
        title: "Choose where Kookaburra Cut keeps your projects",
      });
      if (typeof picked === "string") {
        void notePickedFolder(picked);
        relocate(picked);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [relocate]);

  const clearStoredWebsiteData = useCallback(
    async (displayName?: string) => {
      const target = displayName ? ` for ${displayName}` : " for every site";
      const accepted = await ask(
        `Clear Website data${target}? This signs the affected sites out, but does not change project origin approvals.`,
        {
          title: "Clear Website data?",
          kind: "warning",
          okLabel: "Clear data",
          cancelLabel: "Cancel",
        },
      );
      if (!accepted) return;
      const busyKey = displayName ?? "all";
      setWebsiteDataBusy(busyKey);
      setError(null);
      try {
        await clearWebsiteData(displayName);
        refreshWebsiteData();
      } catch (e) {
        setError(String(e));
      } finally {
        setWebsiteDataBusy(null);
      }
    },
    [refreshWebsiteData],
  );

  // Manual checks only in this window; the launch check belongs to the main window.
  const updates = useUpdateCheck({ autoCheck: false });
  // Rows a configuration profile governs show the lock in place of their control (docs/mdm.md).
  const managed = useManagedPolicy();
  const workspaceLocked = managed?.workspaceRootLocked ?? false;
  const claudeLocked = managed?.disableClaude ?? false;

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
            {workspaceLocked ? (
              <ManagedLock detail="A configuration profile sets where projects are kept (WorkspaceRoot)." />
            ) : (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void chooseLocation()}
                  title={
                    workspace
                      ? "Moves your projects, themes and fonts to the folder you pick"
                      : "Keeps your projects in the folder you pick"
                  }
                >
                  {workspace ? "Change location…" : "Choose location…"}
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
              </>
            )}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Claude</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Edit with</span>
            <span className="muted settings-row-detail">
              What the titlebar's Edit with Claude opens. The built-in terminal is the legacy
              option.
            </span>
          </div>
          {claudeLocked ? (
            <ManagedLock detail="A configuration profile turns Claude off (DisableClaude)." />
          ) : (
            <fieldset className="settings-segmented" aria-label="Edit with">
              <button
                type="button"
                aria-pressed={claudeBuiltin === false}
                className={claudeBuiltin === false ? "active" : undefined}
                disabled={claudeBuiltin === null}
                onClick={() => changeClaudeMode(false)}
              >
                <span className="titlebar-claude-mark">
                  <ClaudeSpark size={13} />
                </span>
                Claude app
              </button>
              <button
                type="button"
                aria-pressed={claudeBuiltin === true}
                className={claudeBuiltin === true ? "active" : undefined}
                disabled={claudeBuiltin === null}
                onClick={() => changeClaudeMode(true)}
              >
                <TerminalGlyph size={13} />
                Built-in terminal
              </button>
            </fieldset>
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Claude app</span>
            <span className="muted settings-row-detail">
              {claudeLocked
                ? "Turned off by your organisation."
                : claudeInstalled === null
                  ? "Checking…"
                  : claudeInstalled
                    ? "Installed"
                    : "Not found. Edit with Claude opens projects in it."}
            </span>
          </div>
          {claudeLocked ? (
            <ManagedLock />
          ) : (
            claudeInstalled === false && (
              <button
                type="button"
                className="btn"
                onClick={() => void openClaudeDownload().catch((e) => setError(String(e)))}
              >
                <DownloadIcon />
                Get Claude
              </button>
            )
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <span className="titlebar-claude-mark">
                <ClaudeSpark size={13} />
              </span>
              Show on a new project's first open
            </span>
            <span className="muted settings-row-detail">
              Turning it on also shows it on the next project you open. Open it any time from the
              titlebar or with ⌥⌘E.
            </span>
          </div>
          {claudeLocked ? (
            <ManagedLock />
          ) : (
            <input
              type="checkbox"
              aria-label="Show on a new project's first open"
              checked={claudeFirstOpen ?? true}
              disabled={claudeFirstOpen === null || claudeBuiltin === true}
              onChange={(e) => toggleClaudeFirstOpen(e.target.checked)}
            />
          )}
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
        <div className="settings-row stacked">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <ClipCacheIcon />
              Clip cache
            </span>
            <span className="muted settings-row-detail">
              {stats
                ? `${formatBytes(stats.clipsBytes)} of ${capGb(stats.clipsCapBytes)} GB · ${stats.clipsEntries} item${stats.clipsEntries === 1 ? "" : "s"}`
                : "…"}
            </span>
            <span className="muted settings-row-detail">
              {clipsClearDeferred
                ? "Clears once the terminal run using it finishes."
                : "Decoded frames of your footage, extracted as scenes need them and readable only by your account. Past the limit the least recently used go first; clips in an open project or a running export stay, and a deleted project's go with it."}
            </span>
          </div>
          <div className="settings-row-actions">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
              <CacheLimitIcon />
              <select
                className="select"
                aria-label="Clip cache limit"
                value={stats ? capGb(stats.clipsCapBytes) : ""}
                disabled={!stats}
                onChange={(e) => changeClipCap(Number(e.target.value))}
              >
                {stats &&
                  clipCacheCapOptions(capGb(stats.clipsCapBytes)).map((gb) => (
                    <option key={gb} value={gb}>
                      {`${gb} GB limit`}
                    </option>
                  ))}
              </select>
            </span>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || !stats || stats.clipsBytes === 0}
              onClick={() => clear("clips")}
              title="Removes every extracted video frame; scenes extract them again as they need them"
            >
              <ClearDataIcon />
              {busy === "clips" ? "Clearing…" : "Clear"}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Website data</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Dedicated browser profile</span>
            <span className="muted settings-row-detail">
              {websiteData === null
                ? "Loading…"
                : websiteData.length === 0
                  ? "No stored site data"
                  : `${websiteData.length} site${websiteData.length === 1 ? "" : "s"} with cookies or local data`}
            </span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={websiteDataBusy !== null || !websiteData?.length}
            onClick={() => void clearStoredWebsiteData()}
          >
            <ClearDataIcon />
            {websiteDataBusy === "all" ? "Clearing…" : "Clear all"}
          </button>
        </div>
        {websiteData?.map((record) => (
          <div className="settings-row" key={record.displayName}>
            <div className="settings-row-text">
              <span className="settings-row-title">{record.displayName}</span>
              <span className="muted settings-row-detail">
                {record.dataTypes.length} stored data type
                {record.dataTypes.length === 1 ? "" : "s"}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              disabled={websiteDataBusy !== null}
              onClick={() => void clearStoredWebsiteData(record.displayName)}
            >
              <ClearDataIcon />
              {websiteDataBusy === record.displayName ? "Clearing…" : "Clear"}
            </button>
          </div>
        ))}
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
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <ConformIcon />
              Conform new videos
            </span>
            <span className="muted settings-row-detail">
              Added videos with uneven frame timing, trims or wide colour become a steady 60 fps
              copy that plays the frames QuickTime shows. The original stays in the project's
              assets/.originals folder.
            </span>
          </div>
          <input
            type="checkbox"
            aria-label="Conform new videos"
            checked={conformNew ?? true}
            disabled={conformNew === null}
            onChange={(e) => toggleConformNew(e.target.checked)}
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
          {updates.managed ? (
            <ManagedLock detail="A configuration profile turns update checks off (DisableUpdateCheck)." />
          ) : (
            <input
              type="checkbox"
              aria-label="Check for updates on launch"
              checked={updates.consent === "on"}
              disabled={updates.consent === "loading"}
              onChange={(e) => void updates.toggleConsent(e.target.checked)}
            />
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Status</span>
            <span className="muted settings-row-detail">
              {updates.managed
                ? "Turned off by your organisation."
                : formatUpdateStatus({
                    phase: updates.phase,
                    devBuild: updates.devBuild,
                    error: updates.error,
                    availableVersion: updates.available?.version ?? null,
                    lastCheckedMs: updates.lastCheckedMs,
                    nowMs: Date.now(),
                  })}
            </span>
          </div>
          {updates.managed ? (
            <ManagedLock />
          ) : (
            <button
              type="button"
              className="btn"
              disabled={updates.phase !== "idle"}
              onClick={() => void updates.runCheck()}
              title="A one-off check; works without the launch toggle and stores nothing when it's off"
            >
              {updates.phase === "checking" ? "Checking…" : "Check now"}
            </button>
          )}
        </div>
      </section>

      <PublisherPane />

      <section className="settings-section">
        <h2>About</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Privacy</span>
            <span className="muted settings-row-detail">
              Nothing leaves your Mac unless you start it: an update check, Claude, a live website.
            </span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void openPrivacyPage().catch((e) => setError(String(e)))}
          >
            <PrivacyIcon />
            What leaves your Mac
          </button>
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
