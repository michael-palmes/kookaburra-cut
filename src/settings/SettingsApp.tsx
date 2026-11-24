import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  type AllowedProjectRow,
  allowedProjectRows,
  clearAppData,
  forgetAllowedProject,
  revealAppLogs,
  revealLicences,
} from "../engine/appData";
import { exportAppLog } from "../engine/appLog";
import {
  claudeAppInstalled,
  openClaudeDownload,
  openPrivacyPage,
  setClaudePreferences,
} from "../engine/claudeApp";
import { useClaudeConsent } from "../engine/claudeConsent";
import {
  claudeLocked,
  plainError,
  updateChecksLocked,
  updateEndpointUnusable,
  updateServerHost,
  useManagedPolicy,
} from "../engine/managed";
import { setConformNewVideosSetting } from "../engine/media";
import { pickFolder } from "../engine/pickedFolders";
import { revealApp } from "../engine/reveal";
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
import { ClaudeSpark } from "../ui/ClaudeLauncher";
import {
  setSingleKeyShortcuts,
  setTextSize,
  TEXT_SIZES,
  type TextSize,
  useSingleKeyShortcuts,
  useTextSize,
} from "../ui/chromePrefs";
import { SegmentedRow } from "../ui/inspector/rows";
import { LockGlyph, ManagedLock } from "../ui/ManagedLock";
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

function ExportLogIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8.5 1.5h-5v13h9V8M5.5 7h3M5.5 9.5h4.5M5.5 12h4.5M9.5 6.5l5-5M11 1.5h3.5V5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AgentKitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 5.5h11v7.5h-11zM6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M2.5 8.5h11M8 7.5v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UpdateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.4h-2.4M8 5.5V8l1.8 1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
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

function AllowedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5 3 3.5v4c0 3 2.2 5.4 5 6.5 2.8-1.1 5-3.5 5-6.5v-4L8 1.5ZM5.8 8l1.6 1.6 3-3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ForgetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5 3 3.5v4c0 3 2.2 5.4 5 6.5 2.8-1.1 5-3.5 5-6.5v-4L8 1.5ZM6 6l4 4m0-4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OpenNowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 3.5h11v9h-11zM2.5 6h11M6.5 8l2.5 1.5-2.5 1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ResetAllIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.4h2.4M6.5 6.5l3 3m0-3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityLogIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 7.5h5M5.5 10h5M5.5 12.5h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AcknowledgementsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 4c-1.5-1.2-3.5-1.5-5.5-1v10c2-.5 4-.2 5.5 1 1.5-1.2 3.5-1.5 5.5-1V3c-2-.5-4-.2-5.5 1zM8 4v10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FinderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 4.5v8h13v-6.5H7.5L6 4.5zM1.5 4.5V3h4l1 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TextSizeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 13 6 3.5 9.5 13M3.8 9.8h4.4M10.5 13l2-5.5 2 5.5M11.2 11.3h2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LetterIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 13.5 8 2.5l4.5 11M5.2 9.5h5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={16 / size}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KeycapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM6 10.5l2-5 2 5M6.8 8.6h2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TEXT_SIZE_ICON: Record<TextSize, number> = { default: 9, large: 11, larger: 13, largest: 15 };

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
  const [exportingLog, setExportingLog] = useState(false);
  const [logSaved, setLogSaved] = useState<string | null>(null);
  const [hwEnabled, setHwEnabled] = useState<boolean | null>(null);
  const [hwSupport, setHwSupport] = useState<HardwareVideoSupport | null>(null);
  const [lagWarning, setLagWarning] = useState<LagWarningMode | null>(null);
  const [downloadsExport, setDownloadsExport] = useState<boolean | null>(null);
  const [conformNew, setConformNew] = useState<boolean | null>(null);
  const [claudeFirstOpen, setClaudeFirstOpen] = useState<boolean | null>(null);
  const [claudeInstalled, setClaudeInstalled] = useState<boolean | null>(null);
  const [clipsClearDeferred, setClipsClearDeferred] = useState(false);
  const [allowed, setAllowed] = useState<AllowedProjectRow[] | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [publisherEpoch, setPublisherEpoch] = useState(0);
  const textSize = useTextSize();
  const singleKeyShortcuts = useSingleKeyShortcuts();

  const refreshStats = useCallback(() => {
    cacheStats()
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, []);

  const loadSettings = useCallback(() => {
    getSettings()
      .then((s) => {
        setWorkspace(s.workspaceRoot ?? null);
        setHwEnabled(!s.disableHardwareVideo);
        setLagWarning((s.lagWarning as LagWarningMode) ?? "off");
        setDownloadsExport(!s.keepExportsInProject);
        setConformNew(!s.disableConformNewVideos);
        setClaudeFirstOpen(!s.disableClaudeFirstOpen);
      })
      .catch(() => setWorkspace(null));
  }, []);

  // Re-read on focus too: the main window opens and closes projects while this one waits.
  const refreshAllowed = useCallback(() => {
    getSettings()
      .then((s) =>
        setAllowed(allowedProjectRows(s.trustedProjects, s.lastProject, home, Date.now())),
      )
      .catch(() => setAllowed([]));
  }, [home]);

  useEffect(() => {
    refreshAllowed();
    window.addEventListener("focus", refreshAllowed);
    return () => window.removeEventListener("focus", refreshAllowed);
  }, [refreshAllowed]);

  useEffect(() => {
    refreshStats();
    sidecarVersions()
      .then(setVersions)
      .catch(() => setVersions(null));
    loadSettings();
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
  }, [refreshStats, loadSettings]);

  // Every window's localStorage is this one origin's, so one clear here covers them all.
  useEffect(() => {
    const unlisten = listen("kookaburra://app-data-cleared", () => {
      try {
        localStorage.clear();
      } catch {}
      loadSettings();
      refreshAllowed();
      refreshStats();
      setClipsClearDeferred(false);
      setPublisherEpoch((n) => n + 1);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadSettings, refreshAllowed, refreshStats]);

  const forget = useCallback(
    (key: string) => {
      setForgetting(key);
      setError(null);
      forgetAllowedProject(key)
        .catch((e) => setError(String(e)))
        .finally(() => {
          setForgetting(null);
          void refreshAllowed();
        });
    },
    [refreshAllowed],
  );

  const clearAll = useCallback(() => {
    setClearingAll(true);
    setError(null);
    clearAppData()
      .catch((e) => setError(String(e)))
      .finally(() => setClearingAll(false));
  }, []);

  const exportLog = useCallback(() => {
    setExportingLog(true);
    setError(null);
    exportAppLog()
      .then((name) => {
        if (name) setLogSaved(name);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setExportingLog(false));
  }, []);

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

  const toggleClaudeFirstOpen = useCallback((firstOpen: boolean) => {
    setClaudeFirstOpen(firstOpen);
    setClaudePreferences({ firstOpen }).catch((e) => setError(String(e)));
  }, []);

  // Other windows can change this too.
  useEffect(() => {
    const unlisten = listen("kookaburra://claude-preferences-changed", () => {
      getSettings()
        .then((s) => {
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
      const picked = await pickFolder("workspaceLocation");
      if (picked) relocate(picked);
    } catch (e) {
      setError(String(e));
    }
  }, [relocate]);

  // Manual checks only in this window; the launch check belongs to the main window.
  const updates = useUpdateCheck({ autoCheck: false });
  // Rows a configuration profile governs show the lock in place of their control (docs/mdm.md).
  const managed = useManagedPolicy();
  const workspaceLocked = managed?.workspaceRootLocked ?? false;
  const claudeOff = managed !== null && claudeLocked(managed);
  const kitOff = managed?.disableAgentKit ?? false;
  const claude = useClaudeConsent();
  const claudeOn = claude.consent === "on";
  const toggleClaudeConsent = useCallback(
    (on: boolean) => {
      claude.set(on).catch((e) => setError(plainError(e)));
    },
    [claude.set],
  );
  const claudeLockDetail = managed?.disableClaude
    ? "A configuration profile turns Claude off (DisableClaude)."
    : "A configuration profile turns the agent kit off, and Claude with it (DisableAgentKit).";
  const exportsPinned = managed?.exportsInProject ?? false;
  const updatesLocked = updates.managed || (managed !== null && updateChecksLocked(managed));
  const updateServerBroken = managed !== null && updateEndpointUnusable(managed);
  const updateServer = managed ? updateServerHost(managed) : null;
  const updatesLockDetail = updateServerBroken
    ? "A configuration profile names an update server this app can't use, so it never checks (UpdateEndpoint)."
    : "A configuration profile turns update checks off (DisableUpdateCheck).";

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
        <h2>Allowed projects</h2>
        {allowed?.length === 0 && (
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="muted settings-row-detail">
                Projects you allow to run show here. Forget one and it asks again on its next open.
              </span>
            </div>
          </div>
        )}
        {allowed?.map((row) => (
          <div className="settings-row" key={row.key}>
            <div className="settings-row-text">
              <span
                className="settings-row-title"
                style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
              >
                <AllowedIcon />
                {row.name}
              </span>
              <span className="muted settings-row-detail settings-path" title={row.path}>
                {row.detail}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              disabled={row.open || forgetting !== null || clearingAll}
              onClick={() => forget(row.key)}
              title={
                row.open
                  ? "Close it in Kookaburra Cut first, then forget it here"
                  : "Asks again before its scenes run next time"
              }
            >
              {row.open ? <OpenNowIcon /> : <ForgetIcon />}
              {row.open ? "Open now" : forgetting === row.key ? "Forgetting…" : "Forget"}
            </button>
          </div>
        ))}
      </section>

      <section className="settings-section">
        <h2>Accessibility</h2>
        <div className="settings-row stacked">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <TextSizeIcon />
              Text size
            </span>
            <span className="muted settings-row-detail">
              Sizes the words and controls in every window. Your preview and exports stay exactly as
              they are.
            </span>
          </div>
          <div className="settings-row-actions">
            <SegmentedRow
              className="settings-segments"
              ariaLabel="Text size"
              value={textSize}
              onChange={setTextSize}
              options={TEXT_SIZES.map((s) => ({
                value: s.id,
                label: s.label,
                icon: <LetterIcon size={TEXT_SIZE_ICON[s.id]} />,
              }))}
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <KeycapIcon />
              Single-key shortcuts
            </span>
            <span className="muted settings-row-detail">
              Letter keys such as S to split and O for Orbit. Turn them off if you use voice control
              or often brush a key; every action keeps its button.
            </span>
          </div>
          <input
            type="checkbox"
            aria-label="Single-key shortcuts"
            checked={singleKeyShortcuts}
            onChange={(e) => setSingleKeyShortcuts(e.target.checked)}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>Claude</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <span className="titlebar-claude-mark">
                <ClaudeSpark size={13} />
              </span>
              Use Claude
            </span>
            <span className="muted settings-row-detail">
              {claudeOff
                ? "Turned off by your organisation."
                : "Sends the project you open in Claude to Anthropic, under your own account."}
            </span>
          </div>
          {claudeOff ? (
            <ManagedLock detail={claudeLockDetail} />
          ) : (
            <input
              type="checkbox"
              aria-label="Use Claude"
              checked={claudeOn}
              disabled={claude.consent === "loading"}
              onChange={(e) => toggleClaudeConsent(e.target.checked)}
            />
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Claude app</span>
            <span className="muted settings-row-detail">
              {claudeOff
                ? "Turned off by your organisation."
                : claudeInstalled === null
                  ? "Checking…"
                  : claudeInstalled
                    ? "Installed"
                    : "Not found. Edit with Claude opens projects in it."}
            </span>
          </div>
          {claudeOff ? (
            <ManagedLock detail={claudeLockDetail} />
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
          {claudeOff ? (
            <ManagedLock detail={claudeLockDetail} />
          ) : (
            <input
              type="checkbox"
              aria-label="Show on a new project's first open"
              checked={claudeFirstOpen ?? true}
              disabled={claudeFirstOpen === null || !claudeOn}
              onChange={(e) => toggleClaudeFirstOpen(e.target.checked)}
            />
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <AgentKitIcon />
              Agent kit
            </span>
            <span className="muted settings-row-detail">
              {kitOff
                ? "Turned off by your organisation: projects get no agent files and the agent bridge stays closed."
                : claude.allowed
                  ? "The rules, skills and kb tool each project carries for Claude Code."
                  : "Off while Claude is off: projects get no agent files and the agent bridge stays closed."}
            </span>
          </div>
          {kitOff ? (
            <ManagedLock detail="A configuration profile turns the agent kit off (DisableAgentKit)." />
          ) : (
            <span className="muted">{claude.allowed ? "On" : "Off"}</span>
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
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <ResetAllIcon />
              Clear all app data
            </span>
            <span className="muted settings-row-detail">
              Every cache, the projects you allowed, recent projects and preferences. Your projects,
              workspace and pack signing key stay.
            </span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={clearingAll || busy !== null || forgetting !== null}
            onClick={clearAll}
          >
            <ClearDataIcon />
            {clearingAll ? "Clearing…" : "Clear all…"}
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
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <DownloadIcon />
              Save exports to Downloads
            </span>
            <span className="muted settings-row-detail">
              {exportsPinned
                ? "Your organisation keeps finished exports in each project's exports folder."
                : "Finished exports land in your Downloads folder; off keeps them in each project's exports folder. Terminal runs always use the project folder."}
            </span>
          </div>
          {exportsPinned ? (
            <ManagedLock detail="A configuration profile keeps exports in the project (ExportsInProject)." />
          ) : (
            <input
              type="checkbox"
              aria-label="Save exports to Downloads"
              checked={downloadsExport ?? true}
              disabled={downloadsExport === null}
              onChange={(e) => toggleDownloadsExport(e.target.checked)}
            />
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2>Updates</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <UpdateIcon />
              Check for updates automatically
            </span>
            <span className="muted settings-row-detail" title={updateServer ?? undefined}>
              {`Asks ${updateServer ? "your organisation's update server" : "GitHub"} about once a day whether a newer release exists. No identifiers, nothing about your usage.`}
            </span>
          </div>
          {updatesLocked ? (
            <ManagedLock detail={updatesLockDetail} />
          ) : (
            <input
              type="checkbox"
              aria-label="Check for updates automatically"
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
              {updatesLocked
                ? updateServerBroken && !managed?.disableUpdateCheck
                  ? "Off: your organisation's update server address can't be used."
                  : "Turned off by your organisation."
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
          {updatesLocked ? (
            <ManagedLock detail={updatesLockDetail} />
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

      <PublisherPane key={publisherEpoch} />

      <section className="settings-section">
        <h2>About</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Privacy</span>
            <span className="muted settings-row-detail">
              Nothing leaves your Mac unless you choose: an update check or Claude.
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
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <ActivityLogIcon />
              Activity log
            </span>
            <span className="muted settings-row-detail">
              What the app did: projects you allowed, packs, updates. Names and folders, never what
              is in your files, and the app never sends it anywhere.
            </span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void revealAppLogs().catch((e) => setError(String(e)))}
          >
            <FinderIcon />
            Show in Finder
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <ExportLogIcon />
              Export log
            </span>
            <span className="muted settings-row-detail">
              {logSaved
                ? `Saved as ${logSaved}.`
                : "What the app did, as one file for support or your IT team. It names projects and folders, never what is in your files."}
            </span>
            {managed?.auditLogPath && (
              <span
                className="muted settings-row-detail"
                style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
              >
                <LockGlyph size={12} />
                Your organisation&apos;s profile asks for a copy of this log (AuditLogPath).
              </span>
            )}
          </div>
          <button type="button" className="btn" disabled={exportingLog} onClick={exportLog}>
            <DownloadIcon />
            {exportingLog ? "Exporting…" : "Export…"}
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span
              className="settings-row-title"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <AcknowledgementsIcon />
              Acknowledgements
            </span>
            <span className="muted settings-row-detail">
              The open source software and assets inside Kookaburra Cut, with their licences.
            </span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void revealLicences().catch((e) => setError(String(e)))}
          >
            <FinderIcon />
            Show in Finder
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
