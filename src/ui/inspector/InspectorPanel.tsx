import { useEffect, useRef, useState } from "react";
import { useClockStore } from "../../engine/clock";
import { type AspectName, FORMATS } from "../../engine/format";
import {
  isWorkspaceProjectId,
  type LoadedProject,
  workspaceProjectPath,
  workspaceSlug,
} from "../../engine/project";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { activeSceneIndex } from "../../engine/sceneTimeline";
import { useUiStore } from "../../store/uiStore";
import { projectRows } from "../inspectorOptions";
import { MediaBrowser } from "../MediaBrowser";
import { mediaCardMenu } from "../mediaCardMenu";
import { DuplicateSceneDialog } from "../PlaybackBar";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "../ThemePicker";
import { useThemeCardMenu } from "../themeCardMenu";
import { useEscapeClose } from "../useEscapeClose";
import { ActionRow, DrillBack, PopoverChoice, RowIcon } from "./rows";
import { ScenesDrillIn } from "./ScenesDrillIn";
import { SceneTab } from "./SceneTab";

/** The right-hand inspector: a 312px panel with a Project/Scene segmented switch. Gating (decision 12): the host hides the whole panel during export/autorun; bundled dev projects get the Project tab only (no tab switch, no Scene tab) with Aspect ratio live and Theme read-only. The panel is the only scroll container in the chrome (`overflow-y: auto`). */
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
  onRenameScene,
  onSceneDuration,
  onPasteBackground,
  onDuplicateSceneAt,
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
  onOpenEditVideo: (sceneIndex: number, mediaRel: string, slot?: "device" | "background") => void;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onTimingChanged: () => void;
  /** Apply a project theme (the picking drill-in; management stays in the ThemeMode modal behind "Manage themes…"). */
  onApplyTheme: (themeId: string) => void;
  /** Trash-recoverable scene removal (the Scene tab's bottom Delete). */
  onDeleteScene: (sceneIndex: number) => void;
  /** Scene manager: apply a full desired order (original indices) to the manifest. */
  onReorderScenes: (desired: number[]) => Promise<void>;
  /** Scene manager: duplicate these scenes, each copy landing after its original. */
  onDuplicateScenes: (indices: number[]) => Promise<void>;
  /** Commit an in-place rename (the host writes `doc.name` + history). */
  onRenameScene: (index: number, name: string) => void;
  /** Commit a scene length in ms (the host writes project.json + the manual-mode flip). */
  onSceneDuration: (index: number, ms: number) => void;
  /** Write the copied background + staging onto a scene (the host owns the write + history). */
  onPasteBackground: (index: number) => void;
  /** Copy one scene to a chosen position (the Duplicate… placement dialog). */
  onDuplicateSceneAt: (index: number, position?: number) => Promise<void>;
}) {
  const isWorkspace = isWorkspaceProjectId(project.id);
  const tab = useUiStore((s) => s.inspector.tab);
  const setTab = useUiStore((s) => s.setInspectorTab);

  // Which row's popover/menu is open; doubles as the row-selected state ("exactly one row selected at a time").
  const [openRow, setOpenRow] = useState<"aspect" | "music" | "playback" | null>(null);
  const previewQuality = useUiStore((s) => s.previewQuality);
  const [confirmRemoveMusic, setConfirmRemoveMusic] = useState(false);
  useEscapeClose(() => setOpenRow(null), openRow !== null);

  // The Scene tab follows the playhead's dominant scene (decision 2); same derive-don't-subscribe selector the EditBar uses.
  const sceneIndex = useClockStore((s) => activeSceneIndex(project.slots, s.currentMs));

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
    aspect,
    soundtrackName,
    playbackLabel:
      previewQuality === "performance"
        ? "Performance"
        : previewQuality === "balanced"
          ? "Balanced"
          : "Full quality",
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
  const [themeChoices, setThemeChoices] = useState<ThemeChoice[]>([]);
  const [themeDraft, setThemeDraft] = useState<string>("");
  // The Duplicate… placement dialog for the Scenes drill-in's context menu.
  const [duplicating, setDuplicating] = useState<number | null>(null);
  // The media drill-in: the modal's library, re-homed as a Project-tab sub-panel like Background ▸ Video.
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  useEscapeClose(
    () => setDrillIn(null),
    drillIn === "project.theme" || drillIn === "project.media" || drillIn === "project.scenes",
  );
  const [scenesBusy, setScenesBusy] = useState(false);

  // Re-list whenever the drill opens or the ThemeMode modal closes over it: Manage no longer closes the drill, so edits must show up in place.
  useEffect(() => {
    void themesRefreshKey; // re-list on ThemeMode close
    if (drillIn === "project.theme") void listThemeChoices().then(setThemeChoices);
  }, [drillIn, themesRefreshKey]);

  // The theme-card right-click menu (shared with the scene-theme drill).
  const themeMenu = useThemeCardMenu({
    onApply: (themeId) => {
      setThemeDraft(themeId);
      onApplyTheme(themeId);
    },
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
    appIcon: () => {
      setMediaError(null);
      setDrillIn("project.appIcon");
    },
    aspect: () => setOpenRow(openRow === "aspect" ? null : "aspect"),
    music: () => setOpenRow(openRow === "music" ? null : "music"),
    playback: () => setOpenRow(openRow === "playback" ? null : "playback"),
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

      {(tab === "project" || !isWorkspace) && drillIn === "project.appIcon" && isWorkspace ? (
        <div className="inspector-drill">
          <DrillBack label="Project" onClick={() => setDrillIn(null)} />
          <div className="inspector-drill-title">App icon</div>
          <div className="inspector-drill-body">
            <span className="modal-hint">
              Pick an image; it becomes assets/app-icon.png everywhere.
            </span>
            {mediaError && <p className="modal-error">{mediaError}</p>}
            <div className="inspector-media-host">
              <MediaBrowser
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
          <DrillBack label="Project" onClick={() => setDrillIn(null)} />
          <div className="inspector-drill-title">Media library</div>
          <div className="inspector-drill-body">
            {mediaError && <p className="modal-error">{mediaError}</p>}
            <div className="inspector-media-host">
              <MediaBrowser
                slug={workspaceSlug(project.id)}
                projectPath={workspaceProjectPath(workspaceSlug(project.id)) ?? ""}
                kindToggle
                globalToggle
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
          <DrillBack label="Project" onClick={() => setDrillIn(null)} />
          <div className="inspector-drill-title">Theme</div>
          <div className="inspector-drill-body">
            <ThemeGrid
              choices={themeChoices}
              value={themeDraft}
              onChange={setThemeDraft}
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
            <button type="button" className="btn" onClick={() => setDrillIn(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={themeDraft === project.theme.id}
              onClick={() => {
                setDrillIn(null);
                onApplyTheme(themeDraft);
              }}
            >
              Apply
            </button>
          </div>
          {themeMenu.menuElement}
        </div>
      ) : (tab === "project" || !isWorkspace) && drillIn === "project.scenes" && isWorkspace ? (
        <>
          <ScenesDrillIn
            scenes={project.slots.map((slot, i) => ({
              index: i,
              name: project.sceneDocs[i]?.name ?? slot.id,
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
            onDelete={onDeleteScene}
          />
          {duplicating !== null && (
            <DuplicateSceneDialog
              project={project}
              index={duplicating}
              sourceName={project.sceneDocs[duplicating]?.name ?? project.slots[duplicating]?.id}
              onClose={() => setDuplicating(null)}
              onDuplicate={onDuplicateSceneAt}
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
          onDeleteScene={onDeleteScene}
        />
      )}
    </aside>
  );
}
