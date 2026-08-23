import { useEffect, useRef, useState } from "react";
import { useClockStore } from "../../engine/clock";
import { type AspectName, FORMATS } from "../../engine/format";
import {
  isWorkspaceProjectId,
  type LoadedProject,
  sceneFileStem,
  workspaceProjectPath,
  workspaceSlug,
} from "../../engine/project";
import { EXPOSURE_MAX, EXPOSURE_MIN, type RenderSettings } from "../../engine/renderSettings";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { activeSceneIndex } from "../../engine/sceneTimeline";
import { useUiStore } from "../../store/uiStore";
import { formatFontString, parseFontString } from "../../theme/fontRef";
import { CopySceneModal } from "../CopySceneModal";
import { AspectIcon } from "../exportIcons";
import { FontPicker } from "../FontPicker";
import { projectRows } from "../inspectorOptions";
import { MediaBrowser } from "../MediaBrowser";
import { mediaCardMenu } from "../mediaCardMenu";
import { DuplicateSceneDialog } from "../PlaybackBar";
import { DebouncedRange } from "../TextAnimationPicker";
import {
  builtinThemeChoices,
  listThemeChoices,
  recordSuccessfulThemeUse,
  ThemeBrowser,
  type ThemeChoice,
} from "../ThemePicker";
import { commitFocusedInspectorEdit } from "../textEditFocus";
import { useThemeCardMenu } from "../themeCardMenu";
import { useEscapeClose } from "../useEscapeClose";
import { InspectorNavigationShell } from "./InspectorNavigationShell";
import { ActionRow, DrillBack, PopoverChoice, RowIcon } from "./rows";
import { ScenesDrillIn } from "./ScenesDrillIn";
import { SceneTab } from "./SceneTab";

/** The right-hand inspector: a fixed 342px rail with pinned tabs and an internally scrolling, animated page stack. */
/** Option glyphs for the Playback options popover (RowIcon's 20-viewBox stroke style). */
function QualityIcon({ kind }: { kind: "full" | "balanced" | "performance" }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {kind === "full" ? (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M6.5 12.5l2.5-3 2 2 2.5-3.5" />
        </>
      ) : kind === "balanced" ? (
        <>
          <path d="M4 13.5a6 6 0 0112 0" />
          <path d="M10 13.5V9" />
        </>
      ) : (
        <path d="M11 3L5 11.5h4L9 17l6-8.5h-4z" />
      )}
    </svg>
  );
}

/** The manifest `typography` slots the drill edits; `chart` is the project's default chart face. */
type TypographySlot = "headline" | "body" | "chart";
const TYPOGRAPHY_SLOTS: readonly TypographySlot[] = ["headline", "body", "chart"];
const TYPOGRAPHY_SLOT_LABELS: Record<TypographySlot, string> = {
  headline: "Headline",
  body: "Body",
  chart: "Chart",
};

/** Project/Scene tab glyphs: a folder for the project, a clip for the scene. */
function TabIcon({ id }: { id: "project" | "scene" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {id === "project" ? (
        <path d="M2.5 5.5a1 1 0 011-1h3l1.5 1.5h6a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1z" />
      ) : (
        <>
          <rect x="2.5" y="4" width="13" height="10" rx="2" />
          <path d="M7.5 7.3v3.4l3-1.7z" />
        </>
      )}
    </svg>
  );
}

export function InspectorPanel({
  project,
  aspect,
  onSetAspect,
  onInsertMedia,
  mediaRefreshKey,
  onOpenTheme,
  onEditThemeInClaude,
  onThemeEdited,
  themesRefreshKey,
  soundtrackName,
  onSetAppIcon,
  onSetSoundtrack,
  onRemoveSoundtrack,
  onOpenEditVideo,
  onDocChanged,
  onTimingChanged,
  onApplyTheme,
  onDeleteScene,
  onReorderScenes,
  onDuplicateScenes,
  onDeleteScenes,
  onRenameScene,
  onSceneDuration,
  onPasteBackground,
  onDuplicateSceneAt,
  onSetRenderSettings,
  onSetTypography,
}: {
  project: LoadedProject;
  aspect: AspectName;
  onSetAspect: (name: AspectName) => void;
  /** Insert a media path (pastes into a live Claude session, else copies). */
  onInsertMedia: (rel: string) => void;
  /** The host's media bump (drag-drop imports); re-scans the media drill-in. */
  mediaRefreshKey: number;
  /** Open the ThemeMode modal, optionally on a specific pane (the theme context menu's Edit fonts / Duplicate; plain Manage passes nothing). */
  onOpenTheme: (manage?: { view: "fonts" | "duplicate"; themeId: string }) => void;
  /** Paste the theme-editing starter prompt into Claude (the media Insert pattern). */
  onEditThemeInClaude: (choice: { id: string; name: string }) => void;
  /** A ws theme's JSON changed (rename); previews regenerate, project reloads if used. */
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  /** Bumped when the ThemeMode modal closes; open drill-ins re-list their choices. */
  themesRefreshKey: number;
  soundtrackName: string | null;
  /** Make a project image the app icon (`assets/app-icon.png`); App owns the write + reload. */
  onSetAppIcon: (rel: string) => void;
  onSetSoundtrack: () => void;
  onRemoveSoundtrack: () => void;
  onOpenEditVideo: (
    sceneIndex: number,
    mediaRel: string,
    slot?: "device" | "compareDevice" | "background" | "videoWindow",
    deviceId?: string,
  ) => void;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onTimingChanged: () => void;
  /** Apply a project theme (the picking drill-in; management stays in the ThemeMode modal behind "Manage themes…"). */
  onApplyTheme: (themeId: string) => Promise<void>;
  /** Trash-recoverable scene removal (the Scene tab's bottom Delete). */
  onDeleteScene: (sceneIndex: number) => void;
  /** Scene manager: apply a full desired order (original indices) to the manifest. */
  onReorderScenes: (desired: number[]) => Promise<void>;
  /** Scene manager: duplicate these scenes, each copy landing after its original. */
  onDuplicateScenes: (indices: number[]) => Promise<void>;
  /** Scene manager: delete these scenes (descending, one reload; refused when it would empty the project). */
  onDeleteScenes: (indices: number[]) => Promise<void>;
  /** Commit an in-place rename (the host writes `doc.name` + history). */
  onRenameScene: (index: number, name: string) => void;
  /** Commit a scene length in ms (the host writes project.json + the manual-mode flip). */
  onSceneDuration: (index: number, ms: number) => void;
  /** Write the copied background + staging onto a scene (the host owns the write + history). */
  onPasteBackground: (index: number) => void;
  /** Copy one scene to a chosen position (the Duplicate… placement dialog). */
  onDuplicateSceneAt: (index: number, position?: number) => Promise<void>;
  /** Write the project display transform (manifest `render`); App owns the write + history. */
  onSetRenderSettings: (settings: RenderSettings) => void;
  /** Write the project font override (manifest `typography`; all null clears); App owns the write + history. `chart` is the project's default chart face. */
  onSetTypography: (headline: string | null, body: string | null, chart: string | null) => void;
}) {
  const isWorkspace = isWorkspaceProjectId(project.id);
  const tab = useUiStore((s) => s.inspector.tab);
  const setTab = useUiStore((s) => s.setInspectorTab);

  // Which row's popover/menu is open; doubles as the row-selected state ("exactly one row selected at a time").
  const [openRow, setOpenRow] = useState<"aspect" | "music" | "playback" | "render" | null>(null);
  const previewQuality = useUiStore((s) => s.previewQuality);
  const [confirmRemoveMusic, setConfirmRemoveMusic] = useState(false);
  useEscapeClose(() => setOpenRow(null), openRow !== null);

  // The Scene tab follows the playhead's dominant scene (decision 2); same derive-don't-subscribe selector the EditBar uses.
  const sceneIndex = useClockStore((s) => activeSceneIndex(project.slots, s.currentMs));

  useEffect(() => {
    let previous = activeSceneIndex(project.slots, useClockStore.getState().currentMs);
    return useClockStore.subscribe((state) => {
      const next = activeSceneIndex(project.slots, state.currentMs);
      if (next === previous) return;
      previous = next;
      commitFocusedInspectorEdit();
    });
  }, [project.slots]);

  // A bundled project can't show the Scene tab; heal the store if we land there.
  useEffect(() => {
    if (!isWorkspace && tab === "scene") setTab("project");
  }, [isWorkspace, tab, setTab]);

  // Collapse transient state when the project or tab changes; the drill-in state lives in the ui store and would otherwise survive a project switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate reset-on-switch
  useEffect(() => {
    setOpenRow(null);
    setConfirmRemoveMusic(false);
    useUiStore.getState().resetInspectorDrill();
  }, [project.id, tab]);

  // The music remove confirmation disarms itself (the EditBar pattern).
  useEffect(() => {
    if (!confirmRemoveMusic) return;
    const t = window.setTimeout(() => setConfirmRemoveMusic(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmRemoveMusic]);

  // The stage's slowdown badge: land on the Project tab first (the reset-on-switch effect above runs before this one), then open the Playback options popover.
  const playbackNonce = useUiStore((s) => s.playbackOptionsNonce);
  const handledPlaybackNonce = useRef(0);
  useEffect(() => {
    if (playbackNonce === 0 || handledPlaybackNonce.current === playbackNonce) return;
    if (tab !== "project") {
      setTab("project");
      return;
    }
    handledPlaybackNonce.current = playbackNonce;
    useUiStore.getState().resetInspectorDrill();
    setOpenRow("playback");
  }, [playbackNonce, tab, setTab]);

  const rows = projectRows({
    isWorkspace,
    themeName: project.theme.name,
    typographyLabel:
      project.projectTypography?.headline ||
      project.projectTypography?.body ||
      project.projectTypography?.chart
        ? [
            project.projectTypography?.headline,
            project.projectTypography?.body,
            project.projectTypography?.chart,
          ]
            .filter((s): s is string => Boolean(s))
            .map((s) => parseFontString(s).family)
            .filter((family, i, all) => all.indexOf(family) === i)
            .join(" · ")
        : "Theme fonts",
    aspect,
    soundtrackName,
    playbackLabel:
      previewQuality === "performance"
        ? "Performance"
        : previewQuality === "balanced"
          ? "Balanced"
          : "Full quality",
    renderLabel:
      { aces: "ACES", agx: "AgX", neutral: "Neutral", linear: "Linear" }[
        project.renderSettings.toneMapping
      ] + (project.renderSettings.exposure !== 1 ? ` · ` : ""),
    scenesCount: project.slots.length,
  });

  // Any pointer-down outside the open row's anchor dismisses its popover (the
  // menu pattern from §8.8); Esc rides useEscapeClose above.
  useEffect(() => {
    if (openRow === null) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".inspector-row-anchor")) setOpenRow(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [openRow]);

  const drillIn = useUiStore((s) => s.inspector.drillIn);
  const openDrill = useUiStore((s) => s.openInspectorDrill);
  const closeDrill = useUiStore((s) => s.closeInspectorDrill);
  const setDrillIn = (id: string | null) => (id === null ? closeDrill() : openDrill(id));
  const [themeChoices, setThemeChoices] = useState<ThemeChoice[]>(builtinThemeChoices);
  const [themeDraft, setThemeDraft] = useState<string>("");
  // The Duplicate… placement dialog for the Scenes drill-in's context menu.
  const [duplicating, setDuplicating] = useState<number | null>(null);
  const [copyingScenes, setCopyingScenes] = useState<number[] | null>(null);
  const [fontSlot, setFontSlot] = useState<TypographySlot>("headline");
  /** The slot's effective font: the manifest override when set, else the (already-overridden) resolved theme's face; charts fall back to the body face, which is what their labels take unset. */
  const typographyRef = (slot: TypographySlot) => {
    const raw = project.projectTypography?.[slot];
    if (raw) return parseFontString(raw);
    return slot === "chart"
      ? (project.theme.typography.chart ?? project.theme.typography.body)
      : project.theme.typography[slot];
  };
  // The media drill-in: the modal's library, re-homed as a Project-tab sub-panel like Background ▸ Video.
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [scenesBusy, setScenesBusy] = useState(false);

  // Re-list whenever the drill opens or the ThemeMode modal closes over it: Manage no longer closes the drill, so edits must show up in place.
  useEffect(() => {
    void themesRefreshKey; // re-list on ThemeMode close
    if (drillIn === "project.theme") void listThemeChoices().then(setThemeChoices);
  }, [drillIn, themesRefreshKey]);

  // The theme-card right-click menu (shared with the scene-theme drill).
  const applyProjectTheme = (themeId: string) => {
    setThemeDraft(themeId);
    void recordSuccessfulThemeUse(themeId, () => onApplyTheme(themeId));
  };

  const themeMenu = useThemeCardMenu({
    onApply: applyProjectTheme,
    onManage: onOpenTheme,
    onEditInClaude: onEditThemeInClaude,
    onThemeEdited,
    onChanged: () => void listThemeChoices().then(setThemeChoices),
  });

  const rowAction: Record<string, (() => void) | undefined> = {
    media: () => {
      setMediaError(null);
      setDrillIn("project.media");
    },
    scenes: () => setDrillIn("project.scenes"),
    theme: isWorkspace
      ? () => {
          setThemeDraft(project.theme.id);
          setDrillIn("project.theme");
        }
      : undefined,
    typography: () => setDrillIn("project.typography"),
    appIcon: () => {
      setMediaError(null);
      setDrillIn("project.appIcon");
    },
    aspect: () => setOpenRow(openRow === "aspect" ? null : "aspect"),
    music: () => setOpenRow(openRow === "music" ? null : "music"),
    playback: () => setOpenRow(openRow === "playback" ? null : "playback"),
    render: () => setOpenRow(openRow === "render" ? null : "render"),
  };

  return (
    <aside className="inspector" aria-label="Inspector">
      {isWorkspace && (
        <div className="inspector-tabs-wrap">
          <div className="inspector-tabs" role="tablist">
            {(["project", "scene"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`inspector-tab${tab === t ? " active" : ""}`}
                onClick={() => setTab(t)}
              >
                <TabIcon id={t} />
                {t === "project" ? "Project" : "Scene"}
              </button>
            ))}
          </div>
        </div>
      )}

      <InspectorNavigationShell resetKey={`${project.id}:${tab}`}>
        {(tab === "project" || !isWorkspace) && drillIn === "project.appIcon" && isWorkspace ? (
          <div className="inspector-drill">
            <DrillBack label="Project" title="App icon" onClick={() => setDrillIn(null)} />
            <div className="inspector-drill-body">
              <span className="modal-hint">
                Pick an image; it becomes assets/app-icon.png everywhere.
              </span>
              {mediaError && <p className="modal-error">{mediaError}</p>}
              <div className="inspector-media-host">
                <MediaBrowser
                  inspectorPreview
                  slug={workspaceSlug(project.id)}
                  projectPath={workspaceProjectPath(workspaceSlug(project.id)) ?? ""}
                  kinds={["image"]}
                  globalToggle
                  refreshKey={mediaRefreshKey + mediaRefresh}
                  onPick={(rel) => {
                    setDrillIn(null);
                    onSetAppIcon(rel);
                  }}
                  cardMenu={mediaCardMenu({
                    slug: workspaceSlug(project.id),
                    primaryLabel: "Set as icon",
                    onPrimary: (rel) => {
                      setDrillIn(null);
                      onSetAppIcon(rel);
                    },
                    onChanged: () => setMediaRefresh((n) => n + 1),
                    onError: setMediaError,
                  })}
                />
              </div>
            </div>
          </div>
        ) : (tab === "project" || !isWorkspace) && drillIn === "project.media" && isWorkspace ? (
          <div className="inspector-drill">
            <DrillBack label="Project" title="Media library" onClick={() => setDrillIn(null)} />
            <div className="inspector-drill-body">
              {mediaError && <p className="modal-error">{mediaError}</p>}
              <div className="inspector-media-host">
                <MediaBrowser
                  inspectorPreview
                  slug={workspaceSlug(project.id)}
                  projectPath={workspaceProjectPath(workspaceSlug(project.id)) ?? ""}
                  kindToggle
                  globalToggle
                  cleanupUnused
                  refreshKey={mediaRefreshKey + mediaRefresh}
                  cardMenu={mediaCardMenu({
                    slug: workspaceSlug(project.id),
                    primaryLabel: "Insert",
                    onPrimary: (rel) => onInsertMedia(rel),
                    onChanged: () => setMediaRefresh((n) => n + 1),
                    onError: setMediaError,
                  })}
                />
              </div>
            </div>
          </div>
        ) : (tab === "project" || !isWorkspace) && drillIn === "project.theme" && isWorkspace ? (
          <div className="inspector-drill">
            <DrillBack label="Project" title="Theme" onClick={() => setDrillIn(null)} />
            <div className="inspector-drill-body">
              <ThemeBrowser
                layout="compact"
                choices={themeChoices}
                value={themeDraft}
                onChange={(id) => {
                  // Applies on selection; the draft doubles as the same-id de-dupe.
                  if (id === themeDraft) return;
                  applyProjectTheme(id);
                }}
                onCardContextMenu={themeMenu.openMenu}
              />
            </div>
            <div className="inspector-drill-actions">
              <button
                type="button"
                className="btn btn-left"
                title="Duplicate, edit fonts or delete themes"
                onClick={() => onOpenTheme()}
              >
                Manage…
              </button>
            </div>
            {themeMenu.menuElement}
          </div>
        ) : (tab === "project" || !isWorkspace) &&
          drillIn === "project.typography" &&
          isWorkspace ? (
          <div className="inspector-drill">
            <DrillBack label="Project" title="Typography" onClick={() => setDrillIn(null)} />
            <div className="inspector-drill-body">
              <div className="font-slot-row">
                {TYPOGRAPHY_SLOTS.map((slot) => {
                  const ref = typographyRef(slot);
                  return (
                    <button
                      type="button"
                      key={slot}
                      className={`chip${fontSlot === slot ? " selected" : ""}`}
                      onClick={() => setFontSlot(slot)}
                    >
                      {TYPOGRAPHY_SLOT_LABELS[slot]}: {ref.family} · {ref.weight}
                    </button>
                  );
                })}
              </div>
              <FontPicker
                value={typographyRef(fontSlot)}
                onPick={(ref) => {
                  const current = project.projectTypography;
                  const next: Record<TypographySlot, string | null> = {
                    headline: current?.headline ?? null,
                    body: current?.body ?? null,
                    chart: current?.chart ?? null,
                  };
                  next[fontSlot] = formatFontString(ref);
                  onSetTypography(next.headline, next.body, next.chart);
                }}
              />
              <span className="modal-hint">
                Project fonts override the theme for every scene; a text field's own font still
                wins. Charts follow the theme until the Chart slot is set, and a chart's own font
                outranks it.
              </span>
            </div>
            <div className="inspector-drill-actions">
              <button
                type="button"
                className="btn btn-left"
                onClick={() => onSetTypography(null, null, null)}
                disabled={
                  !project.projectTypography?.headline &&
                  !project.projectTypography?.body &&
                  !project.projectTypography?.chart
                }
              >
                Use theme fonts
              </button>
            </div>
          </div>
        ) : (tab === "project" || !isWorkspace) && drillIn === "project.scenes" && isWorkspace ? (
          <>
            <ScenesDrillIn
              scenes={project.slots.map((slot, i) => ({
                index: i,
                name: project.sceneDocs[i]?.name ?? sceneFileStem(project.sceneFiles[i]),
                durationMs: slot.durationMs,
                hasDoc: !!project.sceneDocs[i],
              }))}
              busy={scenesBusy}
              onBack={() => setDrillIn(null)}
              onReorder={(desired) => {
                setScenesBusy(true);
                void onReorderScenes(desired).finally(() => setScenesBusy(false));
              }}
              onDuplicate={(indices) => {
                setScenesBusy(true);
                void onDuplicateScenes(indices).finally(() => setScenesBusy(false));
              }}
              onRename={onRenameScene}
              onDuration={onSceneDuration}
              onDuplicateDialog={setDuplicating}
              onCopyBackground={(i) => {
                const doc = project.sceneDocs[i];
                useUiStore.getState().setBackgroundClipboard({
                  background: doc?.background ? structuredClone(doc.background) : undefined,
                  backdrop: doc?.backdrop ? structuredClone(doc.backdrop) : undefined,
                });
              }}
              onPasteBackground={onPasteBackground}
              onDelete={(indices) => {
                setScenesBusy(true);
                void onDeleteScenes(indices).finally(() => setScenesBusy(false));
              }}
              onCopyToProject={setCopyingScenes}
            />
            {duplicating !== null && (
              <DuplicateSceneDialog
                project={project}
                index={duplicating}
                sourceName={
                  project.sceneDocs[duplicating]?.name ??
                  sceneFileStem(project.sceneFiles[duplicating])
                }
                onClose={() => setDuplicating(null)}
                onDuplicate={onDuplicateSceneAt}
              />
            )}
            {copyingScenes !== null && (
              <CopySceneModal
                slug={workspaceSlug(project.id)}
                indices={copyingScenes}
                sceneLabel={
                  copyingScenes.length > 1
                    ? `${copyingScenes.length} scenes`
                    : `“${
                        project.sceneDocs[copyingScenes[0]]?.name ??
                        sceneFileStem(project.sceneFiles[copyingScenes[0]])
                      }”`
                }
                onDone={() => setCopyingScenes(null)}
                onCancel={() => setCopyingScenes(null)}
              />
            )}
          </>
        ) : tab === "project" || !isWorkspace ? (
          <div className="inspector-rows">
            {rows.map((row) => (
              <div key={row.id} className="inspector-row-anchor">
                <ActionRow
                  icon={<RowIcon id={row.id} />}
                  label={row.label}
                  value={row.value}
                  chevron={row.chevron}
                  selected={openRow === row.id}
                  disabled={!row.chevron}
                  onClick={row.chevron ? rowAction[row.id] : undefined}
                />
                {row.id === "aspect" && openRow === "aspect" && (
                  <div className="inspector-popover" role="menu">
                    {(Object.keys(FORMATS) as AspectName[]).map((name) => (
                      <button
                        key={name}
                        type="button"
                        role="menuitemradio"
                        aria-checked={name === aspect}
                        className={`inspector-popover-item${name === aspect ? " active" : ""}`}
                        onClick={() => {
                          onSetAspect(name);
                          setOpenRow(null);
                        }}
                      >
                        <AspectIcon name={name} />
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                {row.id === "playback" && openRow === "playback" && (
                  <div className="inspector-popover inspector-popover-wide" role="menu">
                    <PopoverChoice
                      icon={<QualityIcon kind="full" />}
                      label="Full quality"
                      description="Sharp preview at your screen's full resolution. The right pick on most Macs."
                      active={previewQuality === "full"}
                      onClick={() => {
                        useUiStore.getState().setPreviewQuality("full");
                        setOpenRow(null);
                      }}
                    />
                    <PopoverChoice
                      icon={<QualityIcon kind="balanced" />}
                      label="Balanced"
                      description="A lighter render with screen video at half rate. Try it when playback stutters now and then."
                      active={previewQuality === "balanced"}
                      onClick={() => {
                        useUiStore.getState().setPreviewQuality("balanced");
                        setOpenRow(null);
                      }}
                    />
                    <PopoverChoice
                      icon={<QualityIcon kind="performance" />}
                      label="Performance"
                      description="Smoothest playback: lowest resolution, screen video at half rate. Great for reviewing timing and pace rather than polish. Exports are always full quality."
                      active={previewQuality === "performance"}
                      onClick={() => {
                        useUiStore.getState().setPreviewQuality("performance");
                        setOpenRow(null);
                      }}
                    />
                  </div>
                )}
                {row.id === "render" && openRow === "render" && (
                  <div className="inspector-popover inspector-popover-wide" role="menu">
                    <PopoverChoice
                      icon={<RowIcon id="theme" />}
                      label="ACES Filmic"
                      description="The cinematic default every existing project was graded under. Changing it re-renders the whole video's colour."
                      active={project.renderSettings.toneMapping === "aces"}
                      onClick={() => {
                        onSetRenderSettings({ ...project.renderSettings, toneMapping: "aces" });
                        setOpenRow(null);
                      }}
                    />
                    <PopoverChoice
                      icon={<RowIcon id="theme" />}
                      label="AgX"
                      description="Modern cinematic curve with gentler highlight desaturation."
                      active={project.renderSettings.toneMapping === "agx"}
                      onClick={() => {
                        onSetRenderSettings({ ...project.renderSettings, toneMapping: "agx" });
                        setOpenRow(null);
                      }}
                    />
                    <PopoverChoice
                      icon={<RowIcon id="theme" />}
                      label="Neutral"
                      description="Khronos PBR Neutral: the recommended pick for product-accurate brand colours."
                      active={project.renderSettings.toneMapping === "neutral"}
                      onClick={() => {
                        onSetRenderSettings({ ...project.renderSettings, toneMapping: "neutral" });
                        setOpenRow(null);
                      }}
                    />
                    <PopoverChoice
                      icon={<RowIcon id="theme" />}
                      label="Linear"
                      description="No curve at all: a diagnostic view, not a look to ship."
                      active={project.renderSettings.toneMapping === "linear"}
                      onClick={() => {
                        onSetRenderSettings({ ...project.renderSettings, toneMapping: "linear" });
                        setOpenRow(null);
                      }}
                    />
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Exposure</span>
                      <DebouncedRange
                        label="Exposure"
                        value={project.renderSettings.exposure}
                        min={EXPOSURE_MIN}
                        max={EXPOSURE_MAX}
                        step={0.05}
                        onCommit={(exposure) =>
                          onSetRenderSettings({ ...project.renderSettings, exposure })
                        }
                      />
                    </div>
                  </div>
                )}
                {row.id === "music" && openRow === "music" && (
                  <div className="inspector-popover" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="inspector-popover-item"
                      onClick={() => {
                        setOpenRow(null);
                        onSetSoundtrack();
                      }}
                    >
                      {soundtrackName ? "Replace track…" : "Choose track…"}
                    </button>
                    {soundtrackName && (
                      <button
                        type="button"
                        role="menuitem"
                        className={`inspector-popover-item${confirmRemoveMusic ? " danger" : ""}`}
                        onClick={() => {
                          if (!confirmRemoveMusic) {
                            setConfirmRemoveMusic(true);
                            return;
                          }
                          setConfirmRemoveMusic(false);
                          setOpenRow(null);
                          onRemoveSoundtrack();
                        }}
                      >
                        {confirmRemoveMusic ? "Really remove?" : `Remove ${soundtrackName}`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <SceneTab
            project={project}
            sceneIndex={sceneIndex}
            sceneTheme={project.sceneThemes[sceneIndex]}
            onOpenEditVideo={onOpenEditVideo}
            onDocChanged={onDocChanged}
            onTimingChanged={onTimingChanged}
            onOpenTheme={onOpenTheme}
            onEditThemeInClaude={onEditThemeInClaude}
            onThemeEdited={onThemeEdited}
            themesRefreshKey={themesRefreshKey}
            mediaRefreshKey={mediaRefreshKey}
            onDeleteScene={onDeleteScene}
          />
        )}
      </InspectorNavigationShell>
    </aside>
  );
}
