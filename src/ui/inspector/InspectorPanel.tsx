import { useEffect, useState } from "react";
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
import { AddMediaButton, MediaBrowser } from "../MediaBrowser";
import { mediaCardMenu } from "../mediaCardMenu";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "../ThemePicker";
import { useThemeCardMenu } from "../themeCardMenu";
import { useEscapeClose } from "../useEscapeClose";
import { ActionRow, DrillBack, RowIcon } from "./rows";
import { SceneTab } from "./SceneTab";

/** The right-hand inspector: a 312px panel with a Project/Scene segmented switch. Gating (decision 12): the host hides the whole panel during export/autorun; bundled dev projects get the Project tab only (no tab switch, no Scene tab) with Aspect ratio live and Theme read-only. The panel is the only scroll container in the chrome (`overflow-y: auto`). */
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
  onSetSoundtrack,
  onRemoveSoundtrack,
  onOpenEditVideo,
  onDocChanged,
  onTimingChanged,
  onReplayScene,
  onReplaySessionEnd,
  onApplyTheme,
  onDeleteScene,
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
  onSetSoundtrack: () => void;
  onRemoveSoundtrack: () => void;
  onOpenEditVideo: (sceneIndex: number, mediaRel: string, slot?: "device" | "background") => void;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onTimingChanged: () => void;
  onReplayScene: (startMs: number, endMs: number) => void;
  onReplaySessionEnd: () => void;
  /** Apply a project theme (the picking drill-in; management stays in the ThemeMode modal behind "Manage themes…"). */
  onApplyTheme: (themeId: string) => void;
  /** Trash-recoverable scene removal (the Scene tab's bottom Delete). */
  onDeleteScene: (sceneIndex: number) => void;
}) {
  const isWorkspace = isWorkspaceProjectId(project.id);
  const tab = useUiStore((s) => s.inspector.tab);
  const setTab = useUiStore((s) => s.setInspectorTab);

  // Which row's popover/menu is open; doubles as the row-selected state ("exactly one row selected at a time").
  const [openRow, setOpenRow] = useState<"aspect" | "music" | null>(null);
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
    useUiStore.getState().setInspectorDrillIn(null);
  }, [project.id, tab]);

  // The music remove confirmation disarms itself (the EditBar pattern).
  useEffect(() => {
    if (!confirmRemoveMusic) return;
    const t = window.setTimeout(() => setConfirmRemoveMusic(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmRemoveMusic]);

  const rows = projectRows({
    isWorkspace,
    themeName: project.theme.name,
    aspect,
    soundtrackName,
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
  const setDrillIn = useUiStore((s) => s.setInspectorDrillIn);
  const [themeChoices, setThemeChoices] = useState<ThemeChoice[]>([]);
  const [themeDraft, setThemeDraft] = useState<string>("");
  // The media drill-in: the modal's library, re-homed as a Project-tab sub-panel like Background ▸ Video.
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  useEscapeClose(
    () => setDrillIn(null),
    drillIn === "project.theme" || drillIn === "project.media",
  );

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
    theme: isWorkspace
      ? () => {
          setThemeDraft(project.theme.id);
          setDrillIn("project.theme");
        }
      : undefined,
    aspect: () => setOpenRow(openRow === "aspect" ? null : "aspect"),
    music: () => setOpenRow(openRow === "music" ? null : "music"),
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
                {t === "project" ? "Project" : "Scene"}
              </button>
            ))}
          </div>
        </div>
      )}

      {(tab === "project" || !isWorkspace) && drillIn === "project.media" && isWorkspace ? (
        <div className="inspector-drill">
          <DrillBack label="Project" onClick={() => setDrillIn(null)} />
          <div className="inspector-drill-title">Media library</div>
          <div className="inspector-drill-body">
            <div className="popover-row">
              <span className="modal-hint bg-media-hint">
                Everything stays in this project's assets folder.
              </span>
              <AddMediaButton
                slug={workspaceSlug(project.id)}
                onImported={() => setMediaRefresh((n) => n + 1)}
              />
            </div>
            {mediaError && <p className="modal-error">{mediaError}</p>}
            <div className="inspector-media-host">
              <MediaBrowser
                slug={workspaceSlug(project.id)}
                projectPath={workspaceProjectPath(workspaceSlug(project.id)) ?? ""}
                kindToggle
                hideAdd
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
          onReplayScene={onReplayScene}
          onReplaySessionEnd={onReplaySessionEnd}
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
