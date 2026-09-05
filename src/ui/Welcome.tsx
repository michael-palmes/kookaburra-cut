import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { convertProjectToTemplate } from "../engine/library";
import { nameCollision, nameCollisionWarning } from "../engine/nameCollision";
import { listAllPresets, refreshUserPresets, subscribePresets } from "../engine/presets";
import { listProjectIds } from "../engine/project";
import { listAllTemplates, refreshUserTemplates, subscribeTemplates } from "../engine/templates";
import {
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
  setProjectGroup,
  snapshotUrl,
  type WorkspaceProjectInfo,
} from "../engine/workspace";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ItemDetailsModal } from "./ItemDetailsModal";
import { LibraryGrid } from "./LibraryGrid";
import type { ItemDetailsTarget } from "./libraryDetails";
import { LibraryRailIcon } from "./libraryIcons";
import { projectCardMenuItems } from "./libraryMenus";
import { NamePromptModal } from "./NamePromptModal";
import {
  ALL_PROJECTS,
  filterProjectLibrary,
  formatLastOpened,
  LIBRARY_APP_PRESETS,
  LIBRARY_APP_TEMPLATES,
  LIBRARY_PRESETS,
  LIBRARY_TEMPLATES,
  librarySection,
  nextWelcomeRailRow,
  PlaceholderArt,
  selectedProjectGroup,
  sortProjectsByRecency,
  UNGROUPED_PROJECTS,
  welcomeRailRows,
  welcomeRailSections,
} from "./projectLibrary";
import { ThemeEditorIcon } from "./theme-editor/icons";
import { useEscapeClose } from "./useEscapeClose";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Pick or type a group for one project; the NamePromptModal shape plus existing-group chips and a remove action. */
function GroupPromptModal({
  current,
  groups,
  onSubmit,
  onCancel,
}: {
  current: string | null;
  groups: string[];
  onSubmit: (group: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onCancel, !busy);
  const submit = (v: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onSubmit(v?.trim() ? v.trim() : null).catch((e) => {
      setError(String(e));
      setBusy(false);
    });
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Move to group">
      <div className="modal">
        <h2>Move to group</h2>
        {groups.length > 0 && (
          <fieldset className="group-chips" aria-label="Existing groups">
            {groups.map((g) => (
              <button
                key={g}
                type="button"
                className={`group-chip${value.trim() === g ? " selected" : ""}`}
                onClick={() => setValue(g)}
              >
                {g}
              </button>
            ))}
          </fieldset>
        )}
        <div className="wizard-field">
          <span className="wizard-label">Group</span>
          <input
            className="modal-input"
            placeholder="e.g. Client work"
            value={value}
            // biome-ignore lint/a11y/noAutofocus: a single-input prompt IS the focus target
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit(value);
            }}
          />
        </div>
        <p className="modal-hint">
          Groups appear as sections on this screen; typing a new name creates it.
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          {current && (
            <button type="button" className="btn" onClick={() => submit(null)} disabled={busy}>
              Remove from group
            </button>
          )}
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => submit(value)}
            disabled={busy || !value.trim()}
          >
            {busy ? "Working…" : "Move"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  groups,
  slugs,
  onOpen,
  onConvert,
  onChanged,
  onError,
}: {
  project: WorkspaceProjectInfo;
  /** Every existing group name, for the move-to-group chips. */
  groups: string[];
  /** Every existing project slug, so rename/duplicate warn on a clash as you type. */
  slugs: readonly string[];
  onOpen: () => void;
  /** Snapshot this project into the user's templates, then name it in the details modal. */
  onConvert: () => void;
  /** A management action landed (rename/duplicate/delete); the host re-scans. */
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const url = snapshotUrl(project);
  const meta = [formatDuration(project.durationMs), formatLastOpened(project.lastOpenedMs)]
    .filter(Boolean)
    .join(" · ");
  // The ⋯ management menu: a sibling of the card button, never inside it (nested buttons; the WKWebView img-in-button trap).
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [prompt, setPrompt] = useState<"rename" | "duplicate" | "group" | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const items = () =>
    projectCardMenuItems({
      onRename: () => setPrompt("rename"),
      onDuplicate: () => setPrompt("duplicate"),
      onGroup: () => setPrompt("group"),
      onConvert,
      onDelete: () => {
        onError(null);
        deleteProject(project.slug)
          .then(onChanged)
          .catch((e) => onError(String(e)));
      },
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click alias for the ⋯ menu button — keyboard users have the button itself
    <div
      className="project-card-wrap"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          ariaLabel: `${project.name} actions`,
          items: items(),
        });
      }}
    >
      <button type="button" className="project-card" onClick={onOpen} title={project.name}>
        <span className="project-card-thumb">
          {url ? <img src={url} alt="" /> : <PlaceholderArt />}
        </span>
        <span className="project-card-body">
          <span className="project-card-name">{project.name}</span>
          <span className="project-card-meta">{meta}</span>
        </span>
      </button>
      <button
        ref={menuButtonRef}
        type="button"
        className="project-card-menu-btn"
        aria-label={`Manage ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const rect = menuButtonRef.current?.getBoundingClientRect();
          setMenu({
            x: rect?.left ?? 0,
            y: rect?.bottom ?? 0,
            ariaLabel: `${project.name} actions`,
            returnFocus: menuButtonRef.current,
            items: items(),
          });
        }}
      >
        ⋯
      </button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {prompt === "rename" && (
        <NamePromptModal
          title="Rename project"
          label="Name"
          initial={project.name}
          submitLabel="Rename"
          hint="Changes the display name — the folder keeps its slug."
          validate={(value) => {
            const { slug, collides } = nameCollision(value, slugs, { selfSlug: project.slug });
            return collides ? `${nameCollisionWarning("project", slug)} Pick another name.` : null;
          }}
          onSubmit={async (name) => {
            await renameProject(project.slug, name);
            setPrompt(null);
            onChanged();
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt === "duplicate" && (
        <NamePromptModal
          title="Duplicate project"
          label="New name"
          initial={`${project.name} copy`}
          submitLabel="Duplicate"
          hint="Copies everything except exports and caches."
          validate={(value) => {
            const { slug, collides } = nameCollision(value, slugs);
            return collides ? `${nameCollisionWarning("project", slug)} Pick another name.` : null;
          }}
          onSubmit={async (name) => {
            await duplicateProject(project.slug, name);
            setPrompt(null);
            onChanged();
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt === "group" && (
        <GroupPromptModal
          current={project.group}
          groups={groups}
          onSubmit={async (group) => {
            await setProjectGroup(project.slug, group);
            setPrompt(null);
            onChanged();
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
    </div>
  );
}

/** The copy under the wordmark, per rail section. */
const SECTION_BLURBS: Record<string, string> = {
  [LIBRARY_TEMPLATES]: "Templates you have saved from your own projects.",
  [LIBRARY_PRESETS]: "Scenes you have saved to drop into any project.",
  [LIBRARY_APP_TEMPLATES]: "The templates that ship with Kookaburra Cut.",
  [LIBRARY_APP_PRESETS]: "The scene presets that ship with Kookaburra Cut.",
};

const SEARCH_LABELS: Record<string, string> = {
  [LIBRARY_TEMPLATES]: "templates",
  [LIBRARY_PRESETS]: "presets",
  [LIBRARY_APP_TEMPLATES]: "app templates",
  [LIBRARY_APP_PRESETS]: "app presets",
};

/** The welcome screen: a rail of project groups above the library catalogues, and the matching grid beside it. Projects are snapshot cards sorted most-recently-opened first; the library rows show the user's saved templates and presets, alongside the bundled catalogues, with the remaining bundled projects visible only in dev. */
export function Welcome({
  onOpenProject,
  onNewProject,
  onOpenThemes,
  refreshKey,
  focusSearchNonce,
}: {
  onOpenProject: (projectId: string) => void;
  onNewProject: (options?: { group?: string | null; templateId?: string }) => void;
  onOpenThemes: () => void;
  /** Bump to re-scan the workspace (e.g. after a create). */
  refreshKey: number;
  /** Bump to focus and select the search field (⌘F). */
  focusSearchNonce: number;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [activeRowId, setActiveRowId] = useState(ALL_PROJECTS);
  const [scrolled, setScrolled] = useState(false);
  const [details, setDetails] = useState<{
    target: ItemDetailsTarget;
    title: string;
    hint?: string;
    submitLabel: string;
    onSaved: () => void;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLFieldSetElement>(null);
  const templates = useSyncExternalStore(subscribeTemplates, listAllTemplates);
  const presets = useSyncExternalStore(subscribePresets, listAllPresets);
  useEffect(() => {
    if (focusSearchNonce === 0) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [focusSearchNonce]);
  // From tauri.conf.json at runtime, the same source Settings shows; never hardcoded.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);
  /** Workspace scan failure, rendered as its own state, not as the empty grid: a broken workspace must not look like "no projects yet". */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    // refreshKey/retryNonce exist purely to re-trigger this scan (create/back-nav; the error block's Retry).
    void refreshKey;
    void retryNonce;
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (cancelled) return;
        setLoadError(null);
        setProjects(sortProjectsByRecency(list));
      })
      .catch((e) => {
        console.warn("[workspace] listing projects failed:", e);
        if (!cancelled) {
          setLoadError(String(e));
          setProjects([]);
        }
      });
    Promise.all([refreshUserTemplates(), refreshUserPresets()])
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryNonce]);

  const empty = projects !== null && projects.length === 0 && !loadError;
  const trimmedQuery = query.trim().toLowerCase();
  const counts = useMemo(
    () => ({
      templates: templates.filter((entry) => entry.source === "user").length,
      presets: presets.filter((entry) => entry.source === "user").length,
      appTemplates: templates.filter((entry) => entry.source !== "user").length,
      appPresets: presets.filter((entry) => entry.source !== "user").length,
    }),
    [templates, presets],
  );
  const sections = useMemo(() => welcomeRailSections(projects ?? [], counts), [projects, counts]);
  const railRows = useMemo(() => welcomeRailRows(sections), [sections]);
  const section = librarySection(activeRowId);
  // Searching projects is global: the rail follows to All while a query is active (the ThemePicker convention); library rows keep their own scoped search.
  const effectiveRowId = trimmedQuery && section === null ? ALL_PROJECTS : activeRowId;
  const visibleProjects = useMemo(
    () => filterProjectLibrary(projects ?? [], effectiveRowId, query),
    [projects, effectiveRowId, query],
  );
  const groups = sections[0].rows.slice(2).map((row) => row.label);
  const slugs = useMemo(() => (projects ?? []).map((p) => p.slug), [projects]);
  const inheritedGroup = selectedProjectGroup(effectiveRowId);

  useEffect(() => {
    if (!railRows.some((row) => row.id === activeRowId)) setActiveRowId(ALL_PROJECTS);
  }, [activeRowId, railRows]);

  /** Crossing between the projects and the library drops the search, which scopes to one of them; picking a project row during a live search also clears it (the search ran global). */
  const selectRow = (id: string) => {
    const targetsLibrary = librarySection(id) !== null;
    if (targetsLibrary !== (section !== null) || (!targetsLibrary && trimmedQuery)) setQuery("");
    setActiveRowId(id);
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    const next = nextWelcomeRailRow(railRows, effectiveRowId, e.key);
    if (!next) return;
    e.preventDefault();
    selectRow(next.id);
    railRef.current
      ?.querySelectorAll<HTMLElement>(".project-library-rail-row")
      [next.index]?.focus();
  };

  /** Snapshot a project into the user's templates, then open the details modal on the copy. */
  const convertProject = (project: WorkspaceProjectInfo) => {
    setError(null);
    convertProjectToTemplate(project.slug)
      .then(async (info) => {
        await refreshUserTemplates();
        const entry = listAllTemplates().find((t) => t.id === `ws:${info.slug}`);
        if (!entry) return;
        setDetails({
          target: { kind: "template", source: "user", slug: info.slug, manifest: entry.manifest },
          title: "New template",
          hint: "The project itself is untouched; this is a snapshot of it.",
          submitLabel: "Save template",
          onSaved: () => setActiveRowId(LIBRARY_TEMPLATES),
        });
      })
      .catch((e) => setError(String(e)));
  };

  const editDetails = (target: ItemDetailsTarget) =>
    setDetails({
      target,
      title: target.kind === "template" ? "Template details" : "Preset details",
      submitLabel: "Save",
      onSaved: () => {},
    });

  const searchNoun = SEARCH_LABELS[activeRowId] ?? "projects";
  const showSearch = section !== null || (projects !== null && projects.length > 0);

  // Bundled projects that are not templates stay reachable from App templates.
  const devProjects = useMemo(() => {
    if (!import.meta.env.DEV || activeRowId !== LIBRARY_APP_TEMPLATES) return [];
    const templateIds = new Set(templates.map((entry) => entry.id));
    return listProjectIds().filter(
      (id) => !templateIds.has(id) && (!trimmedQuery || id.includes(trimmedQuery)),
    );
  }, [activeRowId, templates, trimmedQuery]);

  return (
    <div className="welcome" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
      {showSearch && (
        <div className={`welcome-search${scrolled ? " scrolled" : ""}`}>
          <input
            ref={searchRef}
            className="modal-input welcome-search-input"
            type="search"
            placeholder={`Search ${searchNoun}…`}
            aria-label={`Search ${searchNoun}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      )}
      <header className="welcome-header">
        <h1 aria-label="Kookaburra Cut">
          <span className="wordmark-name">Kookaburra</span>
          <span className="wordmark-gap" aria-hidden="true" />
          <span className="wordmark-word">Cut</span>
        </h1>
        {projects !== null && (
          <p>
            {SECTION_BLURBS[activeRowId] ??
              (empty
                ? "Turn your latest features into polished product films, entirely on this Mac."
                : "Your video projects.")}
          </p>
        )}
      </header>

      {loadError && (
        <div className="welcome-error" role="alert">
          <p className="modal-error">Couldn’t read your workspace: {loadError}</p>
          <button type="button" className="btn" onClick={() => setRetryNonce((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}

      {projects === null && (
        <p className="welcome-loading" role="status">
          Loading projects…
        </p>
      )}

      {projects !== null && !loadError && (
        <div className="project-library">
          <fieldset
            ref={railRef}
            className="project-library-rail"
            aria-label="Projects and library"
            onKeyDown={onRailKeyDown}
          >
            {sections.map((railSection) => (
              <Fragment key={railSection.id}>
                <p className="project-library-rail-heading">{railSection.label}</p>
                {railSection.rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`project-library-rail-row${effectiveRowId === row.id ? " selected" : ""}${row.id === UNGROUPED_PROJECTS ? " spaced" : ""}`}
                    aria-pressed={effectiveRowId === row.id}
                    tabIndex={effectiveRowId === row.id ? 0 : -1}
                    onClick={() => selectRow(row.id)}
                  >
                    <LibraryRailIcon id={row.iconId} />
                    <span className="project-library-rail-label">{row.label}</span>
                    <span className="project-library-rail-count">{row.count}</span>
                  </button>
                ))}
                {railSection.id === "library" && (
                  <button
                    type="button"
                    className="project-library-rail-row"
                    onClick={onOpenThemes}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <ThemeEditorIcon name="colours" />
                    <span className="project-library-rail-label">Themes</span>
                  </button>
                )}
              </Fragment>
            ))}
          </fieldset>

          <main className="project-library-results">
            {error && (
              <div>
                <p className="modal-error" role="alert">
                  {error}
                </p>
                <button type="button" className="btn" onClick={() => setRetryNonce((n) => n + 1)}>
                  <LibraryRailIcon id="templates" />
                  Refresh library
                </button>
              </div>
            )}
            {section ? (
              <LibraryGrid
                kind={section.kind}
                source={section.source}
                query={query}
                onOpen={onOpenProject}
                onNewProjectFrom={(templateId) => onNewProject({ templateId })}
                onEditDetails={editDetails}
                onError={setError}
                extra={
                  devProjects.length > 0 ? (
                    <section className="library-category">
                      <h2 className="library-category-heading">
                        <LibraryRailIcon id="group" />
                        <span>Dev projects</span>
                        <span className="library-category-count">{devProjects.length}</span>
                      </h2>
                      <div className="project-grid">
                        {devProjects.map((id) => (
                          <button
                            type="button"
                            key={id}
                            className="project-card"
                            onClick={() => onOpenProject(id)}
                          >
                            <span className="project-card-thumb">
                              <PlaceholderArt />
                            </span>
                            <span className="project-card-body">
                              <span className="project-card-name">{id}</span>
                              <span className="project-card-meta">bundled</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null
                }
              />
            ) : (
              <>
                {trimmedQuery && visibleProjects.length === 0 && (
                  <p className="welcome-no-matches">No projects match “{query.trim()}”.</p>
                )}
                {!trimmedQuery &&
                  activeRowId === UNGROUPED_PROJECTS &&
                  visibleProjects.length === 0 && (
                    <p className="welcome-no-matches">No ungrouped projects.</p>
                  )}
                <div className="project-grid">
                  {visibleProjects.map((p) => (
                    <ProjectCard
                      key={p.slug}
                      project={p}
                      groups={groups}
                      slugs={slugs}
                      onOpen={() => onOpenProject(`ws:${p.slug}`)}
                      onConvert={() => convertProject(p)}
                      onChanged={() => setRetryNonce((n) => n + 1)}
                      onError={setError}
                    />
                  ))}
                  <button
                    type="button"
                    className="project-card new-project"
                    onClick={() => onNewProject({ group: inheritedGroup })}
                  >
                    <span className="new-project-plus" aria-hidden="true">
                      +
                    </span>
                    <span>New project</span>
                  </button>
                  <button
                    type="button"
                    className="project-card new-project"
                    onClick={() => void invoke("open_pack_import", { path: null })}
                  >
                    <span className="new-project-plus" aria-hidden="true">
                      ↓
                    </span>
                    <span>Import a pack</span>
                  </button>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {details && (
        <ItemDetailsModal
          target={details.target}
          title={details.title}
          hint={details.hint}
          submitLabel={details.submitLabel}
          onSaved={async () => {
            const saved = details;
            setDetails(null);
            await (saved.target.kind === "template"
              ? refreshUserTemplates()
              : refreshUserPresets());
            saved.onSaved();
          }}
          onCancel={() => setDetails(null)}
        />
      )}

      <footer className="welcome-footer">
        <p className="welcome-about" title="No early-morning wake-up call required.">
          Built after dark in South Australia. Runs entirely on your Mac.
        </p>
        <p className="welcome-legal">
          "iPhone" is a trademark of Apple Inc. Kookaburra Cut is not affiliated with or endorsed by
          Apple.
        </p>
        <p className="version-label" title="Kookaburra Cut">
          Kookaburra Cut {appVersion}
        </p>
      </footer>
    </div>
  );
}
