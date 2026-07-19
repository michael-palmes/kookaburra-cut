import { Canvas, useThree } from "@react-three/fiber";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import {
  type CSSProperties,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AutoRunConfig,
  getAutoRunConfig,
  reportAutoRunError,
  runAutoRun,
} from "./engine/autorun";
import { CompositorDriver } from "./engine/CompositorDriver";
import { useCameraEditStore } from "./engine/cameraEditStore";
import {
  clipExtractionCount,
  evictAllClips,
  invalidateChangedClips,
  setHardwareVideo,
  subscribeClipExtraction,
} from "./engine/clips";
import { useClockStore } from "./engine/clock";
import { listEdits, openEdit, openEditNamed } from "./engine/edit";
import { useEffectsStore } from "./engine/effectsStore";
import { canvasHandle, ExportBridge } from "./engine/exportBridge";
import {
  type ExportProgress,
  exportProject,
  revealInFinder,
  verifyAllFormats,
} from "./engine/exporter";
import { isExporting } from "./engine/exportState";
import { CAMERA, FORMATS, FPS, SHADOW_MAP_TYPE, STANDING_ASPECTS } from "./engine/format";
import {
  bindHistory,
  type HistoryChange,
  pushHistory,
  restoreCursorAfterFailedRedo,
  restoreCursorAfterFailedUndo,
  takeRedo,
  takeUndo,
} from "./engine/history";
import { importMedia } from "./engine/media";
import { PersistentLayer } from "./engine/PersistentLayer";
import {
  setPreviewAudioMuted,
  setPreviewAudioProject,
  syncPreviewAudioPlaying,
} from "./engine/previewAudio";
import { setPreviewClipStride, setPreviewPlaybackActive } from "./engine/previewMedia";
import { SETTLE_STEPS, settleProjectOpen } from "./engine/previewSettle";
import {
  bumpWorkspaceReloadToken,
  isWorkspaceProjectId,
  type LoadedProject,
  listAllProjects,
  loadProject,
  type ProjectListing,
  sceneFileStem,
  WORKSPACE_PROJECT_PREFIX,
  workspaceProjectPath,
  workspaceSlug,
} from "./engine/project";
import {
  duplicateProjectScene,
  moveProjectScene,
  readProjectManifestSnapshot,
  removeProjectScene,
  writeProjectManifestSnapshot,
} from "./engine/projectEdit";
import { TrustDeniedError } from "./engine/projectTrust";
import { revealApp } from "./engine/reveal";
import { SceneHost } from "./engine/SceneHost";
import { ProjectIdContext } from "./engine/sceneContext";
import {
  resyncFollowMediaDuration,
  syncFollowMediaDurations,
  writeSceneDoc,
} from "./engine/sceneDoc";
import type { SceneDoc } from "./engine/sceneDocSchema";
import { planMoves } from "./engine/sceneOrder";
import { ensureSceneThumbs } from "./engine/sceneThumbs";
import { activeSceneIndex } from "./engine/sceneTimeline";
import { captureSnapshot } from "./engine/snapshots";
import { getLiveSession } from "./engine/terminal";
import { ensureUserThemePreviews } from "./engine/themePreviews";
import { useUpdateCheck } from "./engine/updates";
import {
  type AppSettings,
  createProject,
  getSettings,
  initWorkspace,
  type LagWarningMode,
  projectFingerprint,
  setLastExportPreset,
  setLastProject,
  slugifyName,
} from "./engine/workspace";
import { useEditorStore } from "./store/editorStore";
import { useTrustStore } from "./store/trustStore";
import { useUiStore } from "./store/uiStore";
import { resolveTheme, WORKSPACE_THEME_PREFIX } from "./theme/registry";
import { DevicesFallback } from "./toolkit/device/Device";
import { SceneBackground } from "./toolkit/stage/FixedBackdrop";
import { TextFallback } from "./toolkit/text/TitleBlock";
import { AnimationLane } from "./ui/AnimationLane";
import { CameraPill } from "./ui/CameraPill";
import { CameraToolOverlay } from "./ui/CameraToolOverlay";
import { CommandPalette } from "./ui/CommandPalette";
import { FirstRunDialog, NewProjectDialog, TrustGateModal } from "./ui/dialogs";
import { ExportModal, type ExportSelection } from "./ui/ExportModal";
import { InspectorPanel } from "./ui/inspector/InspectorPanel";
import { MediaLibrary } from "./ui/MediaLibrary";
import { PlaybackBar } from "./ui/PlaybackBar";
import { ShortcutsSheet } from "./ui/ShortcutsSheet";
import { TerminalPanel } from "./ui/TerminalPanel";
import { ThemeMode } from "./ui/ThemeMode";
import { TimelineDock } from "./ui/TimelineDock";
import {
  ExportIcon,
  PaletteTrigger,
  Titlebar,
  TitlebarIdentity,
  TitlebarProjects,
} from "./ui/Titlebar";
import { UpdateAvailableDialog, UpdateConsentDialog } from "./ui/updateDialogs";
import { commitSceneDuration } from "./ui/useSceneDocPatch";
import { Welcome } from "./ui/Welcome";

/** A recessed matte over the letterboxed stage while a freshly-opened project settles, with an honest step-based progress bar (no fabricated animation); never rendered in autorun. */
function StageLoadingOverlay({
  active,
  name,
  step,
}: {
  active: boolean;
  name: string;
  step: number;
}) {
  const [mounted, setMounted] = useState(active);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  if (!mounted) return null;
  return (
    <div
      className={`stage-loading${active ? "" : " stage-loading-done"}`}
      role="status"
      aria-label={`Opening ${name}`}
      onTransitionEnd={() => {
        if (!active) setMounted(false);
      }}
    >
      <span className="stage-loading-name">{name}</span>
      <span className="stage-loading-bar" aria-hidden>
        <span
          className="stage-loading-fill"
          style={{
            width: `${Math.round((Math.min(step, SETTLE_STEPS.length) / SETTLE_STEPS.length) * 100)}%`,
          }}
        />
      </span>
      <span className="stage-loading-step">
        {active ? (SETTLE_STEPS[step] ?? "Opening…") : "Ready"}
      </span>
    </div>
  );
}

/** A transient export/verify notification. `path` (success exports) enables Show in Finder. */
type Toast = { kind: "success" | "error"; message: string; path?: string };

/** Re-renders one frame per scrub change; the export path (exporter.ts) has its own frameloop controller reading the same clock store. */
function PreviewClock() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    return useClockStore.subscribe((state, prev) => {
      if (state.currentMs !== prev.currentMs) invalidate();
    });
  }, [invalidate]);
  return null;
}

export default function App() {
  // Fade the UI in on first commit (anti-flash reveal).
  useEffect(() => {
    revealApp();
  }, []);

  const currentMs = useClockStore((s) => s.currentMs);
  const clipsExtracting = useSyncExternalStore(subscribeClipExtraction, clipExtractionCount);
  const durationMs = useClockStore((s) => s.durationMs);
  const setCurrentMs = useClockStore((s) => s.setCurrentMs);
  const theme = useEditorStore((s) => s.theme);
  const format = useEditorStore((s) => s.format);
  const projectId = useEditorStore((s) => s.projectId);
  const setFormat = useEditorStore((s) => s.setFormat);
  const [project, setProject] = useState<LoadedProject | null>(null);
  // Mirrors `project` for effect closures that must not re-run on reload (switch-vs-refresh test, the surgical doc patch).
  const loadedProjectRef = useRef<LoadedProject | null>(null);
  useEffect(() => {
    loadedProjectRef.current = project;
  }, [project]);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // The export modal resolves preset/custom to an EncodeSpec; the Titlebar codec select is subsumed, and Kookaburra Standard is the frozen path.
  const [showExport, setShowExport] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playBtnRef = useRef<HTMLButtonElement>(null);
  // Auto-run latch: `started` guards the single run through StrictMode's double-invoke; error reporting is deduped in engine/autorun.
  const autoRunRef = useRef({ started: false });

  // `settings === null` = still loading; a missing workspaceRoot triggers the first-run dialog, except in auto-run mode which must never block on a dialog nobody can answer.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<ProjectListing[]>([]);
  const [showNewProject, setShowNewProject] = useState(false);
  const isAutoRun = useMemo(() => {
    try {
      return getAutoRunConfig() !== null;
    } catch {
      return true; // malformed config is reported elsewhere; don't also block on first-run
    }
  }, []);

  // The opt-in update lane: launch check in this window only, manual results land as toasts.
  const onUpdateManualResult = useCallback(
    (kind: "upToDate" | "devBuild" | "error", message: string) => {
      setToast({ kind: kind === "error" ? "error" : "success", message });
    },
    [],
  );
  const updates = useUpdateCheck({ autoCheck: !isAutoRun, onManualResult: onUpdateManualResult });

  // View routing: welcome (project gallery) vs editor. Auto-run boots straight into the editor since the export loop needs the canvas mounted and nobody is present to click through Welcome.
  const [view, setView] = useState<"loading" | "welcome" | "editor">(
    isAutoRun ? "editor" : "loading",
  );
  const [welcomeRefresh, setWelcomeRefresh] = useState(0);

  // False from a real project switch until the settle sequence paints the opening frame (the stage loading overlay renders while false); doc/timing/SWR reloads never reset it. Autorun never uses it.
  const [projectReady, setProjectReady] = useState(false);
  const [settleStep, setSettleStep] = useState(0);

  // Opens automatically when a workspace project loads (the panel itself is the "edit in Claude Code" prompt; the session only starts on explicit click), and via the titlebar button or native menu item.
  const [railOpen, setRailOpen] = useState(false);

  // Titlebar-opened modal; refresh bumps re-scan it (e.g. after a drag-drop import while open).
  const [showMedia, setShowMedia] = useState(false);
  // non-null = open, optionally landing on a specific pane/theme (the theme-card context menu's Edit fonts / Duplicate); the refresh key tells open drill-ins to re-list after edits.
  const [themeMode, setThemeMode] = useState<null | {
    view?: "fonts" | "duplicate";
    themeId?: string;
  }>(null);
  const [themesRefreshKey, setThemesRefreshKey] = useState(0);
  const [mediaRefresh, setMediaRefresh] = useState(0);

  // Insert a media path: paste into a live Claude session if one exists, else copy to clipboard and open the rail.
  const handleInsertMedia = useCallback((rel: string) => {
    const currentId = useEditorStore.getState().projectId;
    if (!isWorkspaceProjectId(currentId)) return;
    setShowMedia(false);
    const live = getLiveSession(workspaceSlug(currentId));
    if (live) {
      live.session.paste(rel);
      live.term.focus();
    } else {
      // Only claim success once the clipboard write lands; on failure the path in the toast is the fallback the user can retype.
      const write = navigator.clipboard?.writeText(rel);
      if (write) {
        write
          .then(() =>
            setToast({ kind: "success", message: `Path copied — paste it into Claude: ${rel}` }),
          )
          .catch(() => setToast({ kind: "error", message: `Couldn't copy — the path is: ${rel}` }));
      } else {
        setToast({ kind: "error", message: `Couldn't copy — the path is: ${rel}` });
      }
      setRailOpen(true);
    }
  }, []);

  // "Edit in Claude Code" on a theme card: paste a starter prompt into the live session, the media Insert pattern, never auto-submitted.
  const handleEditThemeInClaude = useCallback((choice: { id: string; name: string }) => {
    const currentId = useEditorStore.getState().projectId;
    if (!isWorkspaceProjectId(currentId)) return;
    const slug = choice.id.startsWith(WORKSPACE_THEME_PREFIX)
      ? choice.id.slice(WORKSPACE_THEME_PREFIX.length)
      : null;
    if (!slug) return;
    const prompt = `Edit my Kookaburra Cut theme "${choice.name}" — its JSON lives at "~/Kookaburra Cut/themes/${slug}/theme.json". I'd like to: `;
    const live = getLiveSession(workspaceSlug(currentId));
    if (live) {
      live.session.paste(prompt);
      live.term.focus();
      setRailOpen(true);
    } else {
      const write = navigator.clipboard?.writeText(prompt);
      if (write) {
        write
          .then(() =>
            setToast({
              kind: "success",
              message: "Starter prompt copied — start a Claude session and paste it.",
            }),
          )
          .catch(() => setToast({ kind: "error", message: `Couldn't copy — prompt: ${prompt}` }));
      } else {
        setToast({ kind: "error", message: `Couldn't copy — prompt: ${prompt}` });
      }
      setRailOpen(true);
    }
  }, []);

  // Drag-drop import (design.md §8.9): files dropped anywhere on the window land in the open workspace project's assets/.
  useEffect(() => {
    if (isAutoRun || view !== "editor") return;
    const unlisten = listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
      const currentId = useEditorStore.getState().projectId;
      if (!isWorkspaceProjectId(currentId)) return;
      const paths = event.payload.paths ?? [];
      if (paths.length === 0) return;
      importMedia(workspaceSlug(currentId), paths)
        .then((imported) => {
          if (imported.length === 0) return;
          setToast({
            kind: "success",
            message: `Added ${imported.length} file${imported.length === 1 ? "" : "s"} to assets`,
          });
          setMediaRefresh((n) => n + 1);
        })
        .catch((e) => setToast({ kind: "error", message: `Import failed: ${String(e)}` }));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [view, isAutoRun]);

  useEffect(() => {
    if (isAutoRun) return;
    const unlisten = listen("kookaburra://edit-in-claude", () => {
      // ⌘E only means something with a workspace project open; say so elsewhere instead of silently doing nothing.
      if (view === "editor" && isWorkspaceProjectId(useEditorStore.getState().projectId)) {
        setRailOpen(true);
      } else {
        setToast({ kind: "error", message: "Open a workspace project to edit with Claude Code." });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isAutoRun, view]);

  // The menu's Keyboard Shortcuts… item (⌘/).
  const [showShortcuts, setShowShortcuts] = useState(false);
  useEffect(() => {
    if (isAutoRun) return;
    const unlisten = listen("kookaburra://show-shortcuts", () => setShowShortcuts(true));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isAutoRun]);

  // The app menu's Check for Updates… item (emitted to this window only).
  useEffect(() => {
    if (isAutoRun) return;
    const unlisten = listen("kookaburra://check-for-updates", () => void updates.runCheck());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isAutoRun, updates.runCheck]);

  // Autorun windows label themselves so a human who wanders past knows not to touch.
  useEffect(() => {
    if (isAutoRun) void getCurrentWindow().setTitle("Kookaburra Cut — automated run");
  }, [isAutoRun]);

  // The editor window announces a finished render; re-scan Media if it's open.
  useEffect(() => {
    if (isAutoRun) return;
    const unlisten = listen("kookaburra://media-changed", () => setMediaRefresh((n) => n + 1));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isAutoRun]);

  // Settings cleared the clip-extraction cache on disk; drop every registered extraction so mounted videos re-extract (the clear is refused mid-export, so this can't race the export loop).
  useEffect(() => {
    if (isAutoRun) return;
    const unlisten = listen("kookaburra://clips-cache-cleared", () => evictAllClips());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isAutoRun]);

  // The everyday clip-decode lane follows the Settings hardware-video toggle: seeded at boot, live-updated from the Settings window (deferred to the export's lane restore mid-run).
  useEffect(() => {
    getSettings()
      .then((s) => setHardwareVideo(!s.disableHardwareVideo))
      .catch(() => {});
    const unlisten = listen<boolean>("kookaburra://hardware-video-changed", (e) =>
      setHardwareVideo(e.payload),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // The slowdown badge's sensitivity follows Settings the same way: seeded at boot, live-updated from the Settings window. Off by default; the badge is opt-in.
  const [lagWarning, setLagWarningMode] = useState<LagWarningMode>("off");
  useEffect(() => {
    getSettings()
      .then((s) => setLagWarningMode((s.lagWarning as LagWarningMode) ?? "off"))
      .catch(() => {});
    const unlisten = listen<string>("kookaburra://lag-warning-changed", (e) =>
      setLagWarningMode(e.payload as LagWarningMode),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Edit-video auto re-point (locked decision 11): armed only when a scene surface (the device edit bar or the Background video picker), not the library, opens the editor; when the edit renders (`kookaburra://media-changed`) the scene re-points to `assets/<name>-edited.mp4` and duration-follow re-syncs (device slot only).
  const pendingRepointRef = useRef<{
    slug: string;
    index: number;
    editName: string;
    slot: "device" | "background";
  } | null>(null);

  // The fingerprint poll's baseline lives in a ref so UI-initiated writes can re-arm it (flicker fix): otherwise an app-made sidecar/project.json write would trigger a redundant reload ~2s later.
  const fpBaselineRef = useRef<string | null>(null);
  const armPollBaseline = useCallback((slug: string) => {
    projectFingerprint(slug)
      .then((fp) => {
        fpBaselineRef.current = fp;
      })
      .catch(() => {});
  }, []);

  // Surgical edit plumbing (flicker fix): UI writes never bump the workspace reload token since app writes only touch sidecars/project.json, never TSX; handleDocChanged patches the doc in memory, handleTimingChanged does a nonce-only refresh.
  const handleDocChanged = useCallback(
    (sceneIndex: number, doc: SceneDoc) => {
      setProject((prev) =>
        prev && sceneIndex < prev.sceneDocs.length
          ? { ...prev, sceneDocs: prev.sceneDocs.map((d, i) => (i === sceneIndex ? doc : d)) }
          : prev,
      );
      const id = loadedProjectRef.current?.id;
      if (id && isWorkspaceProjectId(id)) armPollBaseline(workspaceSlug(id));
    },
    [armPollBaseline],
  );
  /** Audio types the soundtrack picker accepts; keep in sync with Rust AUDIO_EXTENSIONS. */
  const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg"];
  async function handleSetSoundtrack() {
    const current = loadedProjectRef.current;
    if (!current || !isWorkspaceProjectId(current.id)) return;
    const slug = workspaceSlug(current.id);
    const picked = await openFolderPicker({
      multiple: false,
      directory: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (typeof picked !== "string") return;
    try {
      const rel = await invoke<string>("import_audio", { slug, sourcePath: picked });
      const manifestBefore = await readProjectManifestSnapshot(slug);
      await invoke("set_project_audio", { slug, audio: { file: rel } });
      pushHistory({
        label: "soundtrack",
        changes: [
          {
            kind: "manifest",
            slug,
            before: manifestBefore,
            after: await readProjectManifestSnapshot(slug),
            reload: false,
          },
        ],
      });
      handleTimingChanged(); // nonce reload → loadProject probes the track
      setToast({ kind: "success", message: `Soundtrack: ${rel.split("/").pop()}` });
    } catch (e) {
      setToast({ kind: "error", message: `Soundtrack failed: ${String(e)}` });
    }
  }

  async function handleRemoveSoundtrack() {
    const current = loadedProjectRef.current;
    if (!current || !isWorkspaceProjectId(current.id)) return;
    try {
      const slug = workspaceSlug(current.id);
      const manifestBefore = await readProjectManifestSnapshot(slug);
      await invoke("set_project_audio", { slug, audio: null });
      pushHistory({
        label: "soundtrack",
        changes: [
          {
            kind: "manifest",
            slug,
            before: manifestBefore,
            after: await readProjectManifestSnapshot(slug),
            reload: false,
          },
        ],
      });
      handleTimingChanged();
    } catch (e) {
      setToast({ kind: "error", message: `Soundtrack failed: ${String(e)}` });
    }
  }

  const handleTimingChanged = useCallback(() => {
    setLoadNonce((n) => n + 1);
    const id = loadedProjectRef.current?.id;
    if (id && isWorkspaceProjectId(id)) armPollBaseline(workspaceSlug(id));
  }, [armPollBaseline]);

  // Scene management outside the wizard: rename is an in-memory sidecar `name` patch (no reload); delete is a trash-recoverable removal plus a full reload (a scene-set change, the wizard's path).
  const handleRenameScene = useCallback(
    async (sceneIndex: number, name: string) => {
      const current = loadedProjectRef.current;
      if (!current || !isWorkspaceProjectId(current.id)) return;
      const slug = workspaceSlug(current.id);
      const doc = current.sceneDocs[sceneIndex];
      const file = current.sceneFiles[sceneIndex];
      if (!doc || !file) return;
      const trimmed = name.trim();
      if (trimmed === (doc.name ?? "")) return;
      try {
        const before = structuredClone(doc);
        const next = structuredClone(doc);
        if (trimmed) next.name = trimmed;
        else delete next.name;
        await writeSceneDoc(slug, file, next);
        handleDocChanged(sceneIndex, next);
        pushHistory({
          label: "scene name",
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file,
              sceneIndex,
              before,
              after: structuredClone(next),
              reload: false,
            },
          ],
        });
      } catch (e) {
        setToast({ kind: "error", message: `Rename failed: ${String(e)}` });
      }
    },
    [handleDocChanged],
  );

  const handleDeleteScene = useCallback(async (sceneIndex: number) => {
    const current = loadedProjectRef.current;
    if (!current || !isWorkspaceProjectId(current.id)) return;
    try {
      // No history entry, the wizard's delete semantics: recoverable from the Trash, not ⌘Z (a manifest revert can't restore trashed files).
      await removeProjectScene(workspaceSlug(current.id), sceneIndex);
      bumpWorkspaceReloadToken();
      setLoadNonce((n) => n + 1);
    } catch (e) {
      setToast({ kind: "error", message: `Delete failed: ${String(e)}` });
    }
  }, []);

  const handleDuplicateScene = useCallback(async (sceneIndex: number, position?: number) => {
    const current = loadedProjectRef.current;
    if (!current || !isWorkspaceProjectId(current.id)) return;
    try {
      // No history entry (delete's semantics: a manifest revert can't un-create files); a new TSX needs the full module reload.
      await duplicateProjectScene(workspaceSlug(current.id), sceneIndex, position);
      bumpWorkspaceReloadToken();
      setLoadNonce((n) => n + 1);
    } catch (e) {
      setToast({ kind: "error", message: `Duplicate failed: ${String(e)}` });
    }
  }, []);

  // The scene manager's batch ops: sequential manifest edits, one reload at the end.
  const handleReorderScenes = useCallback(async (desired: number[]) => {
    const current = loadedProjectRef.current;
    if (!current || !isWorkspaceProjectId(current.id)) return;
    try {
      for (const { from, to } of planMoves(desired)) {
        await moveProjectScene(workspaceSlug(current.id), from, to);
      }
      bumpWorkspaceReloadToken();
      setLoadNonce((n) => n + 1);
    } catch (e) {
      setToast({ kind: "error", message: `Reorder failed: ${String(e)}` });
    }
  }, []);

  const handleDuplicateScenes = useCallback(async (indices: number[]) => {
    const current = loadedProjectRef.current;
    if (!current || !isWorkspaceProjectId(current.id)) return;
    try {
      // Descending, each copy after its original, so earlier indices stay valid.
      for (const i of [...indices].sort((a, b) => b - a)) {
        await duplicateProjectScene(workspaceSlug(current.id), i, i + 1);
      }
      bumpWorkspaceReloadToken();
      setLoadNonce((n) => n + 1);
    } catch (e) {
      setToast({ kind: "error", message: `Duplicate failed: ${String(e)}` });
    }
  }, []);

  const handleSceneDuration = useCallback(
    async (sceneIndex: number, ms: number) => {
      const current = loadedProjectRef.current;
      if (!current || !isWorkspaceProjectId(current.id)) return;
      try {
        await commitSceneDuration(current, sceneIndex, ms, handleDocChanged, handleTimingChanged);
      } catch (e) {
        setToast({ kind: "error", message: `Scene length failed: ${String(e)}` });
      }
    },
    [handleDocChanged, handleTimingChanged],
  );

  const handlePasteBackground = useCallback(
    async (sceneIndex: number) => {
      const current = loadedProjectRef.current;
      const clip = useUiStore.getState().backgroundClipboard;
      if (!current || !isWorkspaceProjectId(current.id) || !clip) return;
      const slug = workspaceSlug(current.id);
      const file = current.sceneFiles[sceneIndex];
      if (!file) return;
      try {
        const existing = current.sceneDocs[sceneIndex];
        const before = existing ? structuredClone(existing) : null;
        const next: SceneDoc = existing ? structuredClone(existing) : { version: 1 };
        next.background = clip.background ? structuredClone(clip.background) : undefined;
        next.backdrop = clip.backdrop ? structuredClone(clip.backdrop) : undefined;
        await writeSceneDoc(slug, file, next);
        handleDocChanged(sceneIndex, next);
        pushHistory({
          label: "paste background",
          changes: [
            { kind: "sceneDoc", slug, file, sceneIndex, before, after: structuredClone(next) },
          ],
        });
      } catch (e) {
        setToast({ kind: "error", message: `Paste background failed: ${String(e)}` });
      }
    },
    [handleDocChanged],
  );

  // Custom Edit-menu items emit here since native items would swallow ⌘Z before the DOM saw it; a focused text field routes back to WebKit's own undo manager. Replays go through the same writers as fresh edits.
  const applyHistoryChange = useCallback(
    async (change: HistoryChange, dir: "undo" | "redo") => {
      if (change.kind === "sceneDoc") {
        const target = (dir === "undo" ? change.before : change.after) ?? { version: 1 };
        await writeSceneDoc(change.slug, change.file, target);
        handleDocChanged(change.sceneIndex, target);
        // A themeId revert resolves at load; without this the undo lands on disk invisibly until the next reload.
        if (change.reload) handleTimingChanged();
      } else {
        await writeProjectManifestSnapshot(
          change.slug,
          dir === "undo" ? change.before : change.after,
        );
        if (change.reload) bumpWorkspaceReloadToken();
        handleTimingChanged();
      }
    },
    [handleDocChanged, handleTimingChanged],
  );
  const historyBusyRef = useRef(false);
  useEffect(() => {
    if (isAutoRun) return;
    const isTextTarget = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
    };
    const run = async (dir: "undo" | "redo") => {
      if (isTextTarget()) {
        document.execCommand(dir); // the text field's own history
        return;
      }
      if (exporting || isExporting() || historyBusyRef.current) return;
      const entry = dir === "undo" ? takeUndo() : takeRedo();
      if (!entry) return; // nothing to do, silent like an empty native undo
      historyBusyRef.current = true;
      try {
        // Undo reverts a compound entry BACKWARDS; redo replays it forwards.
        const ordered = dir === "undo" ? [...entry.changes].reverse() : entry.changes;
        for (const change of ordered) {
          await applyHistoryChange(change, dir);
        }
        setToast({
          kind: "success",
          message: `${dir === "undo" ? "Undid" : "Redid"}: ${entry.label}`,
        });
      } catch (e) {
        (dir === "undo" ? restoreCursorAfterFailedUndo : restoreCursorAfterFailedRedo)();
        setToast({
          kind: "error",
          message: `${dir === "undo" ? "Undo" : "Redo"} failed: ${String(e)}`,
        });
      } finally {
        historyBusyRef.current = false;
      }
    };
    const u1 = listen("kookaburra://undo", () => void run("undo"));
    const u2 = listen("kookaburra://redo", () => void run("redo"));
    return () => {
      void u1.then((fn) => fn());
      void u2.then((fn) => fn());
    };
  }, [isAutoRun, exporting, applyHistoryChange]);

  // A changed media library may change a follow-media scene's source length; re-probe and rewrite project.json. Keyed on the refresh counter alone since `project` here is just the snapshot the sync reads, and keying on it would loop.
  const mediaRefreshRef = useRef(0);
  useEffect(() => {
    if (isAutoRun || exporting || !project || mediaRefresh === mediaRefreshRef.current) return;
    mediaRefreshRef.current = mediaRefresh;
    void (async () => {
      // Stale-extraction sweep first, so scenes re-bind against fresh frames (an edit render can overwrite an -edited.mp4 in place).
      await invalidateChangedClips().catch((e) =>
        console.warn("[clips] invalidation sweep failed:", e),
      );
      const pending = pendingRepointRef.current;
      if (
        pending &&
        isWorkspaceProjectId(project.id) &&
        workspaceSlug(project.id) === pending.slug
      ) {
        pendingRepointRef.current = null;
        const doc = project.sceneDocs[pending.index];
        const sceneFile = project.sceneFiles[pending.index];
        const rel = `assets/${pending.editName}-edited.mp4`;
        const next = doc ? structuredClone(doc) : null;
        let repointed = false;
        if (pending.slot === "background") {
          if (next?.background?.type === "video") {
            next.background = { ...next.background, src: rel };
            repointed = true;
          }
        } else if (next?.devices?.[0]?.media) {
          const d = next.devices[0];
          if (d.media) d.media = { ...d.media, src: rel };
          repointed = true;
        }
        if (doc && next && sceneFile && repointed) {
          try {
            await writeSceneDoc(pending.slug, sceneFile, next);
            // Surgical (flicker fix): patch the doc in memory since the scene re-binds its clip by src without a reload; only a duration change needs the timing refresh.
            handleDocChanged(pending.index, next);
            pushHistory({
              label: "video re-point",
              changes: [
                {
                  kind: "sceneDoc",
                  slug: pending.slug,
                  file: sceneFile,
                  sceneIndex: pending.index,
                  before: structuredClone(doc),
                  after: structuredClone(next),
                },
              ],
            });
            if (pending.slot === "device") {
              const wrote = await resyncFollowMediaDuration(
                pending.slug,
                pending.index,
                next,
                project.slots[pending.index].durationMs,
              );
              if (wrote) handleTimingChanged();
            }
          } catch (e) {
            console.warn("[edit-video] auto re-point failed:", e);
            setToast({
              kind: "error",
              message: `Couldn't switch the scene to the edited video: ${String(e)}`,
            });
          }
        }
      }
      if (await syncFollowMediaDurations(project)) handleTimingChanged();
    })();
  }, [mediaRefresh, project, isAutoRun, exporting, handleDocChanged, handleTimingChanged]);

  const refreshProjects = useCallback(async () => {
    setProjects(await listAllProjects());
  }, []);

  const openProject = useCallback((id: string) => {
    useEditorStore.getState().setProjectId(id);
    setView("editor");
    setLastProject(id).catch(() => {});
  }, []);

  const backToProjects = useCallback(() => {
    setView("welcome");
    setWelcomeRefresh((n) => n + 1);
    setLastProject(null).catch(() => {});
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    getSettings()
      .then((loaded) => {
        setSettings(loaded);
        if (isAutoRun) return;
        // Reopen where the user left off; otherwise land on the welcome screen.
        if (loaded.lastProject) {
          useEditorStore.getState().setProjectId(loaded.lastProject);
          setView("editor");
        } else {
          setView("welcome");
        }
      })
      .catch((e) => {
        console.warn("[workspace] settings unavailable:", e);
        setSettings({ workspaceRoot: null });
        if (!isAutoRun) setView("welcome");
      });
    void refreshProjects();
  }, [refreshProjects, isAutoRun]);

  const handleWorkspaceChosen = useCallback(
    async (parent: string | null) => {
      const root = await initWorkspace(parent);
      setSettings((prev) => ({ ...(prev ?? {}), workspaceRoot: root }));
      setWelcomeRefresh((n) => n + 1);
      await refreshProjects();
    },
    [refreshProjects],
  );

  // The one project-swap path: the loader effect, the autorun theme-preview batch, and the user-theme preview borrow all apply a loaded project identically (canvas project, active theme, effects store, clock duration).
  const applyLoadedProject = useCallback(
    (loaded: LoadedProject) => {
      setProject(loaded);
      if (!isAutoRun) setPreviewAudioProject(loaded);
      useEditorStore.getState().setTheme(loaded.theme);
      useEffectsStore
        .getState()
        .setProjectEffects(loaded.effects, loaded.effectOverrides, loaded.sceneEffectDefaults);
      const clock = useClockStore.getState();
      clock.setDurationMs(loaded.totalMs);
      // Keep the scrub position within the (possibly shorter) new project.
      clock.setCurrentMs(Math.min(clock.currentMs, loaded.totalMs));
    },
    [isAutoRun],
  );

  const handleCreateProject = useCallback(
    async (name: string, templateId: string, themeId: string) => {
      const project = await createProject(name, templateId);
      // The theme step's pick lands in the copied project.json before the first load, so the project opens already themed.
      await invoke("set_project_theme", { slug: project.slug, themeId });
      await refreshProjects();
      setShowNewProject(false);
      openProject(`${WORKSPACE_PROJECT_PREFIX}${project.slug}`);
    },
    [refreshProjects, openProject],
  );

  // Apply writes project.json.themeId then does a nonce-only reload (stale-while-revalidate; the poll re-arms so the UI write can't double-reload).
  const handleApplyTheme = useCallback(
    async (themeId: string) => {
      if (!project || !isWorkspaceProjectId(project.id)) return;
      const slug = workspaceSlug(project.id);
      const manifestBefore = await readProjectManifestSnapshot(slug);
      await invoke("set_project_theme", { slug, themeId });
      pushHistory({
        label: "project theme",
        changes: [
          {
            kind: "manifest",
            slug,
            before: manifestBefore,
            after: await readProjectManifestSnapshot(slug),
            reload: false,
          },
        ],
      });
      armPollBaseline(slug);
      setLoadNonce((n) => n + 1);
      setThemeMode(null);
    },
    [project, armPollBaseline],
  );

  // Duplicate a theme into `~/Kookaburra Cut/themes/<slug>/theme.json`, then render its previews by borrowing the canvas (theme-starter under the new theme) and restore the project.
  const handleDuplicateTheme = useCallback(
    async (name: string, baseThemeId: string) => {
      const slug = slugifyName(name);
      if (!slug) throw new Error("Give the theme a name.");
      const base = await resolveTheme(baseThemeId);
      const json = JSON.stringify({ version: 2, ...base, id: slug, name: name.trim() }, null, 2);
      await invoke("write_theme", { slug, text: json });
      const wsId = `${WORKSPACE_THEME_PREFIX}${slug}`;
      const current = project;
      void ensureUserThemePreviews(wsId, json, applyLoadedProject, async () => {
        if (current) applyLoadedProject(await loadProject(current.id));
      }).catch((e) => {
        console.warn("[theme] preview generation failed:", e);
        setToast({ kind: "error", message: `Theme preview render failed: ${String(e)}` });
      });
      return wsId;
    },
    [project, applyLoadedProject],
  );

  // A ws theme's JSON changed (fonts pane): regenerate its previews under the new content hash by borrowing the canvas; the restore reload re-resolves themes so an open project using it picks up the change immediately.
  const handleThemeEdited = useCallback(
    async (wsId: string, json: string) => {
      const current = project;
      await ensureUserThemePreviews(wsId, json, applyLoadedProject, async () => {
        if (current) applyLoadedProject(await loadProject(current.id));
      }).catch((e) => {
        console.warn("[theme] preview regeneration failed:", e);
        setToast({ kind: "error", message: `Theme preview render failed: ${String(e)}` });
      });
    },
    [project, applyLoadedProject],
  );

  const handleChooseWorkspace = useCallback(async () => {
    const dir = await openFolderPicker({
      directory: true,
      multiple: false,
      title: "Choose where Kookaburra Cut keeps your projects",
    });
    if (typeof dir === "string") await handleWorkspaceChosen(dir);
  }, [handleWorkspaceChosen]);

  // Bumped by the error panel's Retry: workspace manifest fixes happen outside Vite's module graph, so nothing reloads automatically; the user retries once Claude fixed the file.
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    // Retry (stage error panel) re-runs this load with otherwise-identical inputs.
    void loadNonce;
    // Nothing to render on the welcome screen; the canvas isn't even mounted there.
    if (view !== "editor") return;
    let cancelled = false;
    // Stale-while-revalidate (flicker fix): a same-project reload keeps the old project rendering until the new one swaps in, so nothing unmounts and per-project state survives. Only a real project switch blanks the stage.
    const isSwitch = loadedProjectRef.current?.id !== projectId;
    if (isSwitch) {
      setProject(null);
      setPlaying(false);
      setProjectReady(false);
      setSettleStep(0);
    }
    setError(null);
    loadProject(projectId)
      .then((loaded) => {
        if (cancelled) return;
        applyLoadedProject(loaded);
        if (!isSwitch || isAutoRun) {
          // SWR reload (same project): nothing remounted, the stage never blanked.
          setProjectReady(true);
          return;
        }
        void settleProjectOpen(loaded, (n) => {
          if (!cancelled) setSettleStep(n);
        }).finally(() => {
          if (!cancelled) setProjectReady(true);
        });
      })
      .catch((e) => {
        if (cancelled) return;
        // Declining the trust gate is a choice, not a failure: back to the welcome screen, and don't reopen the project next boot.
        if (e instanceof TrustDeniedError) {
          backToProjects();
          return;
        }
        setError(String(e));
        // An SWR reload failure keeps the previous project on stage so the stage-error panel never renders; say it loudly instead of only in the scrubber readout.
        if (!isSwitch && !isAutoRun) {
          setToast({ kind: "error", message: `Live reload failed: ${String(e)}` });
        }
        // In auto-run mode, a failed load of the target project must self-report (result + non-zero exit) rather than hang until the wrapper's timeout; guarded to the requested project only.
        let cfg: AutoRunConfig | null = null;
        try {
          cfg = getAutoRunConfig();
        } catch {
          cfg = null;
        }
        if (cfg && cfg.project === projectId) reportAutoRunError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, loadNonce, view, applyLoadedProject, isAutoRun, backToProjects]);

  // Auto-open the Claude rail for workspace projects; close it where it can't work.
  useEffect(() => {
    if (!project || isAutoRun) return;
    setRailOpen(isWorkspaceProjectId(project.id));
  }, [project, isAutoRun]);

  // Camera-edit hygiene: a committed drag draft holds the new pose through the async reload, released once the reloaded project lands; the editor's whole state is per-project, so a project switch resets it.
  useEffect(() => {
    void project;
    useCameraEditStore.getState().clearCommittedDraft();
  }, [project]);
  const loadedProjectId = project?.id;
  useEffect(() => {
    void loadedProjectId;
    useCameraEditStore.getState().reset();
  }, [loadedProjectId]);

  // The camera strip and tool overlay follow the playhead's dominant scene, like the edit bar (derive-don't-subscribe: re-renders only when the index changes, not per tick).
  const cameraEditOpen = useCameraEditStore((s) => s.open);
  // The F-001 consent request `loadProject` is currently blocked on, if any.
  const pendingTrust = useTrustStore((s) => s.pending);
  const camSceneIndex = useClockStore((s) =>
    project ? activeSceneIndex(project.slots, s.currentMs) : 0,
  );

  // Live-reload when project sources change on disk (writes happen outside Vite's watch scope): poll a fingerprint every ~1s, debounce one tick so multi-file edits land as one reload, then re-run the load path; kept independent of `project` so it keeps polling through transient load errors.
  useEffect(() => {
    if (view !== "editor" || !isWorkspaceProjectId(projectId) || exporting || isAutoRun) return;
    const slug = workspaceSlug(projectId);
    fpBaselineRef.current = null;
    let pending: string | null = null;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || isExporting()) return;
      projectFingerprint(slug)
        .then((fp) => {
          if (cancelled) return;
          if (fpBaselineRef.current === null) {
            fpBaselineRef.current = fp; // baseline, never reload on the first observation
          } else if (fp !== fpBaselineRef.current) {
            if (pending === fp) {
              // Unchanged since the previous tick; the write burst has settled.
              fpBaselineRef.current = fp;
              pending = null;
              bumpWorkspaceReloadToken();
              setLoadNonce((n) => n + 1);
            } else {
              pending = fp;
            }
          } else {
            pending = null;
          }
        })
        .catch(() => {}); // missing project etc, the load path owns error surfacing
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [view, projectId, exporting, isAutoRun]);

  // Preview soundtrack follows the transport. Muting is preview-only; the flag lives in the ui store so palette commands and the playback bar share one switch.
  const audioMuted = useUiStore((s) => s.audioMuted);
  const previewQuality = useUiStore((s) => s.previewQuality);
  useEffect(() => {
    syncPreviewAudioPlaying(playing);
  }, [playing]);
  useEffect(() => {
    setPreviewAudioMuted(audioMuted);
  }, [audioMuted]);

  // The ⌘K palette key arrives via the native menu item (Project ▸ Find an Action…) because a menu accelerator swallows the key before the DOM sees it; the capture-phase DOM listener is the fallback. Editor view only (decision 14).
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  useEffect(() => {
    if (isAutoRun) return;
    const toggle = () => {
      if (view === "editor") useUiStore.getState().togglePalette();
    };
    const unlisten = listen("kookaburra://find-action", toggle);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      void unlisten.then((fn) => fn());
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isAutoRun, view]);
  useEffect(() => {
    if (view !== "editor") useUiStore.getState().setPaletteOpen(false);
  }, [view]);

  // Welcome-card snapshot: capture shortly after a workspace project renders, debounced so rapid switches don't thrash; never in auto-run mode. Keyed on the project ID, not the object, since every sidecar patch mints a new LoadedProject identity and a recapture borrows the clock (visible playhead blip otherwise).
  const projectIdForSnapshot = project?.id;
  useEffect(() => {
    if (!projectIdForSnapshot || !projectReady || isAutoRun || view !== "editor") return;
    if (!isWorkspaceProjectId(projectIdForSnapshot)) return;
    const timer = window.setTimeout(() => {
      const current = loadedProjectRef.current;
      if (current?.id === projectIdForSnapshot) void captureSnapshot(current);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [projectIdForSnapshot, projectReady, isAutoRun, view]);

  // Auto-run mode (KOOKABURRA_* env via get_autorun_config, prefetched in main.tsx): point the store at the requested project on boot; a malformed config is reported to native (result file + non-zero exit) instead of running the UI.
  useEffect(() => {
    let config: AutoRunConfig | null;
    try {
      config = getAutoRunConfig();
    } catch (e) {
      reportAutoRunError(e);
      return;
    }
    if (config && config.project !== useEditorStore.getState().projectId) {
      useEditorStore.getState().setProjectId(config.project);
    }
  }, []);

  // Once the requested project is loaded and the export canvas has published its handle, fire the auto-run exactly once; the canvas handle is an imperative ref so we poll it. StrictMode mount/cleanup/mount is safe via the `started` latch.
  useEffect(() => {
    if (!project || autoRunRef.current.started) return;
    let config: AutoRunConfig | null;
    try {
      config = getAutoRunConfig();
    } catch {
      return; // already reported by the mount effect
    }
    if (!config || project.id !== config.project) return;
    const cfg = config;

    console.warn(`[autorun] project "${project.id}" loaded — polling for the canvas handle`);
    let timer = 0;
    let cancelled = false;
    const waitForCanvas = () => {
      if (cancelled || autoRunRef.current.started) return;
      if (canvasHandle.current) {
        console.warn("[autorun] canvas handle ready — starting run");
        autoRunRef.current.started = true;
        void runAutoRun(project, cfg, applyLoadedProject);
        return;
      }
      // setTimeout, not requestAnimationFrame: WKWebView suspends rAF while occluded or the display sleeps (the AFK scenario the autorun serves), which silently stalled runs; timers keep firing.
      timer = window.setTimeout(waitForCanvas, 16);
    };
    waitForCanvas();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project, applyLoadedProject]);

  // Toggling play restarts from the start if parked at the end. Guarded on the module export flag too (not just `exporting` state) since autorun-driven exports never set React state, and a stray click during an AFK verify would poison the run.
  /** Bounded replay (the text-motion panel's live preview): play [startMs, endMs) once and auto-pause, seeking back to where the playhead sat when the panel session began (`replayReturnMsRef`), cleared when manual transport takes over. */
  const playUntilRef = useRef<number | null>(null);
  const replayReturnMsRef = useRef<number | null>(null);
  const projectIdLoaded = project?.id;
  // A real project switch orphans any armed return position (never seek another project's clock); keyed on the id since in-memory doc patches swap the project object per pick.
  useEffect(() => {
    replayReturnMsRef.current = null;
    bindHistory(projectIdLoaded ?? null); // the edit history is per-project
    // The background clipboard is per-project too: image/video fills reference project assets.
    useUiStore.getState().setBackgroundClipboard(null);
  }, [projectIdLoaded]);
  const handleReplayScene = useCallback(
    (startMs: number, endMs: number) => {
      if (!project || exporting || isExporting()) return;
      if (replayReturnMsRef.current === null) {
        replayReturnMsRef.current = useClockStore.getState().currentMs;
      }
      playUntilRef.current = endMs;
      useClockStore.getState().setCurrentMs(startMs);
      setPlaying(true);
    },
    [project, exporting],
  );

  /** The text-motion panel closed (Done, Cancel or the bar toggle): return the playhead to where editing began, paused. */
  const handleReplaySessionEnd = useCallback(() => {
    const returnTo = replayReturnMsRef.current;
    replayReturnMsRef.current = null;
    playUntilRef.current = null;
    if (returnTo !== null && !isExporting()) {
      setPlaying(false);
      useClockStore.getState().setCurrentMs(returnTo);
    }
  }, []);

  const togglePlay = useCallback(() => {
    if (!project || exporting || isExporting()) return;
    playUntilRef.current = null; // manual transport clears any bounded replay
    replayReturnMsRef.current = null; // …and owns the playhead from here
    setPlaying((p) => {
      if (!p) {
        const clock = useClockStore.getState();
        if (clock.currentMs >= clock.durationMs) clock.setCurrentMs(0);
      }
      return !p;
    });
  }, [project, exporting]);

  // Balanced/Performance thin preview clip decoding to every 2nd frame; pinned to full whenever an export could be running.
  useEffect(() => {
    setPreviewClipStride(!exporting && previewQuality !== "full" ? 2 : 1);
  }, [exporting, previewQuality]);

  // Playback binds the small preview JPEGs; pausing flips every consumer back to exact full frames.
  useEffect(() => {
    setPreviewPlaybackActive(playing && !exporting);
  }, [playing, exporting]);

  // Slowdown badge state: the EMA lives in refs (per-frame maths, no renders); the badge value updates at most every 200ms so the indicator never adds render work of its own.
  const [lagFps, setLagFps] = useState<number | null>(null);
  const lagEmaRef = useRef(0);
  const lagUpdatedRef = useRef(0);

  // Playback advances the shared clock by real elapsed time so the preview animates. Preview only: the export loop (exporter.ts) drives the clock itself and never runs this, so reading the wall clock here can't affect determinism.
  useEffect(() => {
    if (!playing) {
      lagEmaRef.current = 0;
      lagUpdatedRef.current = 0;
      setLagFps(null);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Stand down mid-flight if an export takes the clock (e.g. an autorun aspect began while playback was running); writing it here would poison the captured frames.
      if (isExporting()) {
        setPlaying(false);
        return;
      }
      const clock = useClockStore.getState();
      const dt = now - last;
      last = now;
      if (lagWarning !== "off") {
        const ema = lagEmaRef.current === 0 ? Math.min(dt, 17) : lagEmaRef.current * 0.9 + dt * 0.1;
        lagEmaRef.current = ema;
        if (now - lagUpdatedRef.current >= 200) {
          lagUpdatedRef.current = now;
          // Enter/exit thresholds differ (hysteresis) so the badge doesn't flicker at the edge.
          const [on, off] = lagWarning === "strict" ? [20, 17.5] : [25, 20];
          setLagFps((prev) => {
            const lagging = prev !== null ? ema > off : ema > on;
            return lagging ? Math.round(1000 / ema) : null;
          });
        }
      }
      let next = clock.currentMs + dt;
      // A bounded replay pauses at its window's end and returns the playhead to where the panel session began; with no session mark it parks on the window's last moment.
      const stopAt = playUntilRef.current;
      if (stopAt !== null && next >= stopAt) {
        playUntilRef.current = null;
        clock.setCurrentMs(replayReturnMsRef.current ?? stopAt);
        setPlaying(false);
        return;
      }
      if (clock.durationMs > 0 && next >= clock.durationMs) next %= clock.durationMs;
      clock.setCurrentMs(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, lagWarning]);

  // Never let preview playback run during an export/verify; they share the clock store.
  useEffect(() => {
    if (exporting) setPlaying(false);
  }, [exporting]);

  // Any pause (spacebar, export, end-of-replay) drops the bounded-replay stop mark.
  useEffect(() => {
    if (!playing) playUntilRef.current = null;
  }, [playing]);

  // Spacebar toggles play/pause; arrows step one frame (shift = 10) on the export frame grid. Skipped while a form control is focused (xterm's hidden textarea included) or a modal is open. Keyframe arbitration: while the camera editor has a selected diamond, arrows nudge that key instead and the playhead step stands down.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space" && !e.repeat) {
        if (target === playBtnRef.current) return;
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (!project || exporting || isExporting()) return;
        if (document.querySelector(".modal-overlay")) return;
        const cam = useCameraEditStore.getState();
        if (cam.open && cam.selectedKeyId) return; // the camera strip owns arrows now
        e.preventDefault();
        setPlaying(false);
        replayReturnMsRef.current = null; // manual frame-step owns the playhead
        const clock = useClockStore.getState();
        const frameMs = 1000 / FPS;
        const direction = e.key === "ArrowLeft" ? -1 : 1;
        const frame = Math.round(clock.currentMs / frameMs) + direction * (e.shiftKey ? 10 : 1);
        clock.setCurrentMs(Math.min(clock.durationMs, Math.max(0, frame * frameMs)));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, project, exporting]);

  // Edit video from a scene surface (device edit bar or Background video picker): open the editor scene-initiated and arm the re-point (the media-changed effect above applies it when the render lands).
  const handleOpenEditVideo = useCallback(
    async (sceneIndex: number, mediaRel: string, slot: "device" | "background" = "device") => {
      if (!project || !isWorkspaceProjectId(project.id)) return;
      const slug = workspaceSlug(project.id);
      try {
        // A rendered output reopens its own edit (and re-renders over the same file) instead of chaining a new -edited derivative.
        const m = /^assets\/(.+)-edited\.mp4$/.exec(mediaRel);
        const editedOf = m && (await listEdits(slug)).includes(m[1]) ? m[1] : null;
        const editName = editedOf
          ? await openEditNamed(slug, editedOf)
          : await openEdit(slug, mediaRel);
        pendingRepointRef.current = { slug, index: sceneIndex, editName, slot };
      } catch (e) {
        console.warn("[edit-video] open failed:", e);
        setToast({ kind: "error", message: `Couldn't open the video editor: ${String(e)}` });
      }
    },
    [project],
  );

  // Run the modal's selection. The chosen aspect sets the editor format first (the canvas FormatContext must commit before the export loop reads pixels); no `encode` means the frozen legacy path (Kookaburra Standard), presets/custom carry their resolved spec + name suffix.
  async function handleExport(sel: ExportSelection) {
    if (!project || exporting) return;
    setShowExport(false);
    setExporting(true);
    setProgress(null);
    setToast(null);
    try {
      const targetFormat = FORMATS[sel.aspect];
      if (format.name !== targetFormat.name) {
        setFormat(targetFormat);
        // Two macrotask hops let React commit the new format into the canvas; deliberately setTimeout-based, never rAF (the autorun nextCommit rationale).
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      }
      // Render at the output rate: a 30fps spec steps the clock at 30 directly since i·(1000/30) is bit-identical to 2i·(1000/60) in float64, giving the same bytes the old fps=30 decimation kept, at half the render.
      const output = await exportProject(
        {
          projectId: project.id,
          fps: sel.encode?.fps ?? FPS,
          durationMs: project.totalMs,
          format: targetFormat,
          slots: project.slots,
          cameraTrack: project.cameraTrack,
          sceneDocs: project.sceneDocs,
          theme: project.theme,
          sceneThemes: project.sceneThemes,
          audio: project.audio,
          codec: "libx264",
          encode: sel.encode,
          outputSuffix: sel.outputSuffix,
        },
        setProgress,
      );
      setToast({
        kind: "success",
        message: "Your cut is ready: identical, frame for frame.",
        path: output,
      });
      void invoke("notify_export_done"); // dock bounce if we're in the background
      // Remember the pick per project (global fallback), restored on next modal open.
      void setLastExportPreset(project.id, sel.presetId).catch(() => {});
      // Refresh the welcome-card snapshot with the just-exported look.
      if (isWorkspaceProjectId(project.id)) void captureSnapshot(project);
    } catch (e) {
      setToast({ kind: "error", message: `Export failed: ${String(e)}` });
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }

  async function handleVerify() {
    if (!project || exporting) return;
    setExporting(true);
    setProgress(null);
    setToast(null);
    try {
      // Determinism gate: Verify ×2 for every standing aspect, pinned to libx264 (the frozen path; presets never change it, ProRes legs ride kookaburra:run --codec).
      const results = await verifyAllFormats(
        {
          projectId: project.id,
          fps: FPS,
          durationMs: project.totalMs,
          slots: project.slots,
          cameraTrack: project.cameraTrack,
          sceneDocs: project.sceneDocs,
          theme: project.theme,
          sceneThemes: project.sceneThemes,
          audio: project.audio,
          codec: "libx264",
        },
        STANDING_ASPECTS.map((a) => FORMATS[a]),
        setProgress,
      );
      const allOk = results.every((r) => r.identical);
      const summary = results.map((r) => `${r.aspect} ${r.identical ? "✓" : "✗"}`).join("  ·  ");
      setToast({
        kind: allOk ? "success" : "error",
        message: `${allOk ? "Deterministic ✓" : "NOT deterministic ✗"} — ${summary}`,
      });
      void invoke("notify_export_done"); // long run either way, bounce if unfocused
    } catch (e) {
      setToast({ kind: "error", message: `Verify failed: ${String(e)}` });
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }

  const pct = progress ? Math.round((progress.frame / progress.total) * 100) : 0;

  // Fixed-width seconds readout: pad to the duration's width so digit count never changes, paired with tabular-nums (CSS) so the scrubber track never jitters.
  const durationSec = (durationMs / 1000).toFixed(2);
  const timeReadout = `${(currentMs / 1000).toFixed(2).padStart(durationSec.length, "0")} / ${durationSec} s`;

  const editorView = view === "editor";

  // The identity line under the project name: the project folder with the home prefix tilde'd, or a plain marker for bundled dev projects.
  const projectDisplayPath = !editorView
    ? null
    : project && isWorkspaceProjectId(project.id)
      ? (workspaceProjectPath(workspaceSlug(project.id))?.replace(/^\/Users\/[^/]+/, "~") ?? null)
      : "Built-in project";

  return (
    <div className="app">
      {/* Titlebar: projects folder + identity left; ⌘K trigger + Export CTA right. The old center strip's actions live in the command palette (commandRegistry pins the vocabulary); Welcome keeps a New project button. */}
      <Titlebar>
        {editorView ? (
          <>
            <TitlebarProjects onClick={backToProjects} disabled={exporting} />
            <TitlebarIdentity
              name={project?.name ?? projectId.replace(WORKSPACE_PROJECT_PREFIX, "")}
              path={projectDisplayPath}
            />
          </>
        ) : (
          <span className="titlebar-title" data-tauri-drag-region>
            Kookaburra Cut
          </span>
        )}
        <span className="spacer" data-tauri-drag-region />
        {editorView && (
          <>
            <PaletteTrigger onOpen={() => useUiStore.getState().togglePalette()} />
            <span className="titlebar-divider" aria-hidden />
            <button
              type="button"
              className="btn primary titlebar-export"
              onClick={() => setShowExport(true)}
              disabled={!project || exporting}
            >
              <ExportIcon />
              {/* Figure-space padding (U+2007 = one tabular-digit width) keeps the label the same width from "  1%" to "100%", no mid-export jitter. */}
              {exporting ? `Exporting… ${String(pct).padStart(3, " ")}%` : "Export"}
            </button>
          </>
        )}
        {view === "welcome" && (
          <button
            type="button"
            className="btn"
            onClick={() => setShowNewProject(true)}
            disabled={!settings?.workspaceRoot}
            title="Create a new project from a template"
          >
            New project
          </button>
        )}
      </Titlebar>

      {view === "welcome" && (
        <Welcome
          onOpenProject={openProject}
          onNewProject={() => setShowNewProject(true)}
          refreshKey={welcomeRefresh}
        />
      )}

      {editorView && (
        <div className="editor-body">
          {/* The rail hides during export (task 24): the live-session registry keeps the PTY and buffer alive through the unmount, so it restores intact when the export ends. */}
          {railOpen && !exporting && project && isWorkspaceProjectId(project.id) && (
            <aside className="terminal-rail">
              <div className="rail-header">
                <span className="rail-title">Claude Code</span>
                <button
                  type="button"
                  className="toast-close"
                  aria-label="Hide the Claude panel"
                  onClick={() => setRailOpen(false)}
                >
                  ×
                </button>
              </div>
              <TerminalPanel
                key={project.id}
                slug={workspaceSlug(project.id)}
                cwd={workspaceProjectPath(workspaceSlug(project.id)) ?? ""}
                scenes={project.slots.map((s, i) => ({
                  index: i,
                  id: s.id,
                  file: project.sceneFiles[i],
                  stem: sceneFileStem(project.sceneFiles[i]),
                  name: project.sceneDocs[i]?.name ?? null,
                  durationMs: s.durationMs,
                  startMs: s.startMs,
                  doc: project.sceneDocs[i],
                }))}
                theme={project.theme}
                getThumbs={() => ensureSceneThumbs(project)}
                onProjectChanged={() => {
                  bumpWorkspaceReloadToken();
                  setLoadNonce((n) => n + 1);
                }}
              />
            </aside>
          )}
          <div className="editor-main">
            <div className="stage">
              {/* Letterbox frame: contain-fit at the export aspect (design.md §7.2); the preview frames exactly like the export and can never overflow the window. */}
              <div
                className="stage-frame"
                style={{ "--stage-aspect": format.width / format.height } as CSSProperties}
              >
                <Canvas
                  frameloop="demand"
                  // Preview-only pixel ratio; the exporter pins its own (setPixelRatio(1)) per run.
                  dpr={
                    previewQuality === "performance"
                      ? 1
                      : previewQuality === "balanced"
                        ? 1.5
                        : [1, 2]
                  }
                  // antialias is a request; WebKit decides silently (ANGLE/Metal). The onCreated truth log below records what the context actually granted, landing in the autorun dev.log on every gated run.
                  gl={{ preserveDrawingBuffer: true, antialias: true }}
                  // Shadow maps: enabled globally, inert until a SceneStage mounts a castShadow key light (see SHADOW_MAP_TYPE; regressions prove the inert case byte-neutral).
                  shadows={{ enabled: true, type: SHADOW_MAP_TYPE }}
                  onCreated={({ gl }) => {
                    console.warn(
                      "[gl] context:",
                      JSON.stringify(gl.getContext().getContextAttributes()),
                      `maxSamples=${gl.capabilities.maxSamples}`,
                      // The fx transition path renders into HalfFloat MSAA targets, so float renderability is part of the truth log.
                      `extColorBufferFloat=${gl.extensions.has("EXT_color_buffer_float")}`,
                    );
                  }}
                  camera={{ position: CAMERA.position, fov: CAMERA.fov }}
                >
                  <color attach="background" args={[theme.colors.background]} />
                  <PreviewClock />
                  <ExportBridge />
                  {project && (
                    <CompositorDriver
                      projectId={project.id}
                      slots={project.slots}
                      cameraTrack={project.cameraTrack}
                      sceneDocs={project.sceneDocs}
                      theme={project.theme}
                      sceneThemes={project.sceneThemes}
                      commitStamp={project}
                    />
                  )}
                  {/* Scenes resolve assets against the project that owns them, the loaded project, which lags the store's projectId by a render during a switch (see ProjectIdContext). */}
                  <ProjectIdContext.Provider value={project?.id ?? null}>
                    <Suspense fallback={null}>
                      {project?.scenes.map((scene, i) => {
                        const slot = project.slots[i];
                        const SceneComponent = scene.Scene;
                        return (
                          <SceneHost
                            key={`${project.id}:${slot.id}`}
                            index={i}
                            id={slot.id}
                            startMs={slot.startMs}
                            durationMs={slot.durationMs}
                            doc={project.sceneDocs[i]}
                            theme={project.sceneThemes[i]}
                          >
                            {/* The fixed background mounts host-side for every scene, staged or not, so Background picks never depend on the scene authoring a <SceneStage> (staging/lighting stays opt-in). */}
                            <SceneBackground />
                            <SceneComponent />
                            {/* Host-side fallbacks so Add device / Add text work on scenes whose TSX never wires the sidecar hooks; the registries suppress them when it does. */}
                            <DevicesFallback />
                            <TextFallback />
                          </SceneHost>
                        );
                      })}
                      {/* The persistent (hoisted morph) layer mounts once as a sibling of the scene hosts, outside every SceneContext, so it reads global time and tweens across scene seams. The compositor owns its per-frame visibility. */}
                      {project?.persistent && (
                        <PersistentLayer key={`${project.id}:persistent`}>
                          <project.persistent />
                        </PersistentLayer>
                      )}
                    </Suspense>
                  </ProjectIdContext.Provider>
                </Canvas>
                {/* Armed move-camera tool drag surface: DOM above the canvas, exactly the letterboxed frame, so drags map 1:1 to rendered pixels. */}
                {project &&
                  isWorkspaceProjectId(project.id) &&
                  !exporting &&
                  !isAutoRun &&
                  cameraEditOpen && (
                    <CameraToolOverlay
                      project={project}
                      sceneIndex={camSceneIndex}
                      onDocChanged={handleDocChanged}
                    />
                  )}
              </div>

              {!isAutoRun && !error && (
                <StageLoadingOverlay
                  active={!project || !projectReady}
                  name={project?.name ?? projectId.replace(/^ws:/, "")}
                  step={settleStep}
                />
              )}

              {/* The camera pill: bottom-left of the stage, z-7, above the tool overlay and below toasts; workspace projects only. */}
              {project &&
                isWorkspaceProjectId(project.id) &&
                projectReady &&
                !exporting &&
                !isAutoRun && (
                  <CameraPill
                    project={project}
                    sceneIndex={camSceneIndex}
                    onDocChanged={handleDocChanged}
                  />
                )}

              {/* Slowdown badge: live fps in an amber warning triangle while playback can't hold full speed; click opens Playback options. */}
              {lagFps !== null && !exporting && !isAutoRun && (
                <button
                  type="button"
                  className="lag-badge"
                  title={`Playback is running at about ${lagFps} fps. Click to open playback options.`}
                  aria-label={`Playback at about ${lagFps} fps; open playback options`}
                  onClick={() => useUiStore.getState().requestPlaybackOptions()}
                >
                  {/* Round-linejoin stroke in the fill colour rounds the triangle's points. */}
                  <svg className="lag-badge-shape" viewBox="0 0 46 40" aria-hidden="true">
                    <path
                      d="M23 3L43 37H3Z"
                      fill="var(--warning)"
                      stroke="var(--warning)"
                      strokeWidth="6"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="lag-badge-fps">{lagFps}</span>
                  <span className="lag-badge-unit">FPS</span>
                </button>
              )}

              {/* A freshly added video extracts its CFR frame sequence before the device screen can show it; say so instead of leaving the screen silently black. */}
              {!isAutoRun && !exporting && clipsExtracting > 0 && (
                <div className="stage-busy-chip">Preparing video…</div>
              )}
              {isAutoRun && <div className="stage-busy-chip">Automated run — hands off</div>}

              {error && !project && (
                <div className="stage-error" role="alert">
                  <h2>This project can’t load right now</h2>
                  <pre>{error}</pre>
                  <p className="muted">Fix the file — or ask Claude Code to — then retry.</p>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => setLoadNonce((n) => n + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}

              {toast && (
                <div className={`toast toast-${toast.kind}`} role="status">
                  <span className="toast-msg" title={toast.message}>
                    {toast.message}
                  </span>
                  {toast.path ? (
                    <button
                      type="button"
                      className="toast-action"
                      onClick={() => {
                        const path = toast.path;
                        if (!path) return;
                        setToast(null);
                        revealInFinder(path).catch((e) =>
                          setToast({
                            kind: "error",
                            message: `Couldn't reveal file: ${String(e)}`,
                          }),
                        );
                      }}
                    >
                      Show in Finder
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="toast-close"
                    aria-label="Dismiss"
                    onClick={() => setToast(null)}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* The timeline dock: the animation lane self-collapses on cameraEditStore.open; the dock draws the lane-to-cell connector. */}
            <TimelineDock
              connectorActive={cameraEditOpen}
              activeIndex={camSceneIndex}
              lane={
                project && isWorkspaceProjectId(project.id) && !exporting && !isAutoRun ? (
                  <AnimationLane
                    project={project}
                    sceneIndex={camSceneIndex}
                    onDocChanged={handleDocChanged}
                    onSceneDuration={(i, ms) => void handleSceneDuration(i, ms)}
                  />
                ) : null
              }
            >
              <PlaybackBar
                project={project}
                playing={playing}
                exporting={exporting}
                currentMs={currentMs}
                durationMs={durationMs}
                readout={error ?? timeReadout}
                hasAudio={!!project?.audio}
                audioMuted={audioMuted}
                isWorkspace={!!project && isWorkspaceProjectId(project.id)}
                playRef={playBtnRef}
                onTogglePlay={togglePlay}
                onToggleMute={() => useUiStore.getState().setAudioMuted(!audioMuted)}
                onScrub={(ms) => {
                  // Module-flag guard: `disabled` only covers UI-button exports, not autorun.
                  if (!isExporting()) {
                    replayReturnMsRef.current = null; // a scrub owns the playhead
                    setCurrentMs(ms);
                  }
                }}
                onNewScene={() => {
                  useUiStore.getState().requestRailWizard("new-scene");
                  setRailOpen(true);
                }}
                onRenameScene={(i, name) => void handleRenameScene(i, name)}
                onDeleteScene={(i) => void handleDeleteScene(i)}
                onDuplicateScene={handleDuplicateScene}
                onSceneDuration={(i, ms) => void handleSceneDuration(i, ms)}
                onPasteBackground={(i) => void handlePasteBackground(i)}
              />
            </TimelineDock>
          </div>

          {/* The right-hand inspector: hidden during export/autorun like the edit bar; bundled projects get its Project tab only (decision 12). */}
          {project && !exporting && !isAutoRun && (
            <InspectorPanel
              project={project}
              aspect={format.name}
              onSetAspect={(name) => setFormat(FORMATS[name])}
              onInsertMedia={handleInsertMedia}
              mediaRefreshKey={mediaRefresh}
              onOpenTheme={(manage) => setThemeMode(manage ?? {})}
              onEditThemeInClaude={handleEditThemeInClaude}
              onThemeEdited={handleThemeEdited}
              themesRefreshKey={themesRefreshKey}
              soundtrackName={project.audio ? (project.audio.file.split("/").pop() ?? null) : null}
              onSetSoundtrack={() => void handleSetSoundtrack()}
              onRemoveSoundtrack={() => void handleRemoveSoundtrack()}
              onOpenEditVideo={(i, rel) => void handleOpenEditVideo(i, rel)}
              onDocChanged={handleDocChanged}
              onTimingChanged={handleTimingChanged}
              onReplayScene={handleReplayScene}
              onReplaySessionEnd={handleReplaySessionEnd}
              onApplyTheme={(id) => void handleApplyTheme(id)}
              onDeleteScene={(i) => void handleDeleteScene(i)}
              onReorderScenes={handleReorderScenes}
              onDuplicateScenes={handleDuplicateScenes}
              onRenameScene={(i, name) => void handleRenameScene(i, name)}
              onSceneDuration={(i, ms) => void handleSceneDuration(i, ms)}
              onPasteBackground={(i) => void handlePasteBackground(i)}
              onDuplicateSceneAt={handleDuplicateScene}
            />
          )}
        </div>
      )}

      {settings && !settings.workspaceRoot && !isAutoRun && (
        <FirstRunDialog
          onContinue={() => handleWorkspaceChosen(null)}
          onChoose={handleChooseWorkspace}
        />
      )}
      {/* Consent ask waits for a workspace so it never stacks on the first-run dialog. */}
      {settings?.workspaceRoot && updates.consent === "undecided" && !isAutoRun && (
        <UpdateConsentDialog onAnswer={(on) => void updates.answerConsent(on)} />
      )}
      {updates.offerVisible && updates.available && !isAutoRun && (
        <UpdateAvailableDialog
          version={updates.available.version}
          notes={updates.available.notes}
          installing={updates.phase === "installing"}
          installError={updates.installError}
          onLater={updates.dismissOffer}
          onInstall={() => void updates.install()}
        />
      )}
      {pendingTrust && (
        <TrustGateModal
          name={pendingTrust.name}
          onAnswer={(allowed) => useTrustStore.getState().answer(allowed)}
        />
      )}
      {showNewProject && (
        <NewProjectDialog
          onCreate={handleCreateProject}
          onCancel={() => setShowNewProject(false)}
        />
      )}
      {showMedia && project && isWorkspaceProjectId(project.id) && (
        <MediaLibrary
          slug={workspaceSlug(project.id)}
          projectPath={workspaceProjectPath(workspaceSlug(project.id)) ?? ""}
          refreshKey={mediaRefresh}
          onInsert={handleInsertMedia}
          onClose={() => setShowMedia(false)}
        />
      )}
      {themeMode && project && isWorkspaceProjectId(project.id) && (
        <ThemeMode
          currentThemeId={project.theme.id}
          initialView={themeMode.view}
          initialThemeId={themeMode.themeId}
          onApply={handleApplyTheme}
          onDuplicate={handleDuplicateTheme}
          onThemeEdited={handleThemeEdited}
          onClose={() => {
            setThemeMode(null);
            // Open theme drill-ins re-list; duplicates/edits made in the modal show up without reopening the drill (Manage keeps it open).
            setThemesRefreshKey((k) => k + 1);
          }}
        />
      )}
      {showShortcuts && <ShortcutsSheet onClose={() => setShowShortcuts(false)} />}
      {paletteOpen && editorView && (
        <CommandPalette
          ctx={{
            view,
            projectId,
            projectLoaded: !!project,
            isWorkspace: !!project && isWorkspaceProjectId(project.id),
            hasAudio: !!project?.audio,
            exporting,
            hasWorkspaceRoot: !!settings?.workspaceRoot,
            playing,
            audioMuted,
            railOpen,
            aspect: format.name,
            projects,
            actions: {
              backToProjects,
              newProject: () => setShowNewProject(true),
              openProject,
              openMedia: () => setShowMedia(true),
              openTheme: () => setThemeMode({}),
              setSoundtrack: () => void handleSetSoundtrack(),
              removeSoundtrack: () => void handleRemoveSoundtrack(),
              toggleRail: () => setRailOpen((v) => !v),
              setAspect: (name) => setFormat(FORMATS[name]),
              togglePlay,
              toggleMute: () => useUiStore.getState().setAudioMuted(!audioMuted),
              openExport: () => setShowExport(true),
              verify: () => void handleVerify(),
              showShortcuts: () => setShowShortcuts(true),
              checkForUpdates: () => void updates.runCheck(),
            },
          }}
          onClose={() => useUiStore.getState().setPaletteOpen(false)}
        />
      )}
      {showExport && project && (
        <ExportModal
          project={project}
          currentAspect={format.name}
          busy={exporting}
          onExport={handleExport}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
