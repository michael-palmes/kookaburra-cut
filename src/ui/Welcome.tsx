import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { listProjectIds } from "../engine/project";
import {
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
  setProjectGroup,
  snapshotUrl,
  type WorkspaceProjectInfo,
} from "../engine/workspace";
import { NamePromptModal } from "./NamePromptModal";
import {
  ALL_PROJECTS,
  filterProjectLibrary,
  projectGroupRows,
  selectedProjectGroup,
  UNGROUPED_PROJECTS,
} from "./projectLibrary";
import { useEscapeClose } from "./useEscapeClose";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatLastOpened(ms: number | null): string | null {
  if (!ms) return null;
  const elapsed = Date.now() - ms;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "Opened just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return `Opened ${rtf.format(-minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Opened ${rtf.format(-hours, "hour")}`;
  return `Opened ${rtf.format(-Math.round(hours / 24), "day")}`;
}

/** Restrained line-art placeholder for cards with no snapshot yet (no emoji, §3.12). */
function PlaceholderArt() {
  return (
    <svg width="72" height="44" viewBox="0 0 72 44" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="69"
        height="41"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M30 15.5v13l11.5-6.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
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
  onOpen,
  onChanged,
}: {
  project: WorkspaceProjectInfo;
  /** Every existing group name, for the move-to-group chips. */
  groups: string[];
  onOpen: () => void;
  /** A management action landed (rename/duplicate/delete); the host re-scans. */
  onChanged: () => void;
}) {
  const url = snapshotUrl(project);
  const meta = [formatDuration(project.durationMs), formatLastOpened(project.lastOpenedMs)]
    .filter(Boolean)
    .join(" · ");
  // The ⋯ management menu: a sibling of the card button, never inside it (nested buttons; the WKWebView img-in-button trap).
  const [menuOpen, setMenuOpen] = useState(false);
  const [prompt, setPrompt] = useState<"rename" | "duplicate" | "group" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
        setError(null);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [menuOpen]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click alias for the ⋯ menu button — keyboard users have the button itself
    <div
      className="project-card-wrap"
      ref={menuRef}
      onContextMenu={(e) => {
        // Right-click = the ⋯ menu.
        e.preventDefault();
        setMenuOpen(true);
        setConfirmDelete(false);
        setError(null);
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
        type="button"
        className="project-card-menu-btn"
        aria-label={`Manage ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen((v) => !v);
          setConfirmDelete(false);
          setError(null);
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="rail-menu project-card-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="rail-menu-item"
            onClick={() => {
              setMenuOpen(false);
              setPrompt("rename");
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            className="rail-menu-item"
            onClick={() => {
              setMenuOpen(false);
              setPrompt("duplicate");
            }}
          >
            Duplicate…
          </button>
          <button
            type="button"
            role="menuitem"
            className="rail-menu-item"
            onClick={() => {
              setMenuOpen(false);
              setPrompt("group");
            }}
          >
            Move to group…
          </button>
          <button
            type="button"
            role="menuitem"
            className={`rail-menu-item${confirmDelete ? " danger" : ""}`}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              setConfirmDelete(false);
              setMenuOpen(false);
              deleteProject(project.slug)
                .then(onChanged)
                .catch((e) => setError(String(e)));
            }}
            title="Moves the project folder to the Trash"
          >
            {confirmDelete ? "Really delete?" : "Delete…"}
          </button>
          {error && <p className="modal-error project-card-menu-error">{error}</p>}
        </div>
      )}
      {prompt === "rename" && (
        <NamePromptModal
          title="Rename project"
          label="Name"
          initial={project.name}
          submitLabel="Rename"
          hint="Changes the display name — the folder keeps its slug."
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

/** The welcome screen: the user's projects as snapshot cards (grouped projects under their own section headings), a New Project affordance, and, behind an ⌥-click on the version label, the bundled dev/gate projects; sorted most-recently-opened first. */
export function Welcome({
  onOpenProject,
  onNewProject,
  refreshKey,
  focusSearchNonce,
}: {
  onOpenProject: (projectId: string) => void;
  onNewProject: (group?: string) => void;
  /** Bump to re-scan the workspace (e.g. after a create). */
  refreshKey: number;
  /** Bump to focus and select the search field (⌘F). */
  focusSearchNonce: number;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectInfo[] | null>(null);
  const [showDevProjects, setShowDevProjects] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroupId, setActiveGroupId] = useState(ALL_PROJECTS);
  const [scrolled, setScrolled] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const groupRailRef = useRef<HTMLFieldSetElement>(null);
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
        list.sort(
          (a, b) => (b.lastOpenedMs ?? 0) - (a.lastOpenedMs ?? 0) || a.name.localeCompare(b.name),
        );
        setLoadError(null);
        setProjects(list);
      })
      .catch((e) => {
        console.warn("[workspace] listing projects failed:", e);
        if (!cancelled) {
          setLoadError(String(e));
          setProjects([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryNonce]);

  const empty = projects !== null && projects.length === 0 && !loadError;
  const trimmedQuery = query.trim().toLowerCase();
  const groupRows = useMemo(() => projectGroupRows(projects ?? []), [projects]);
  const visibleProjects = useMemo(
    () => filterProjectLibrary(projects ?? [], activeGroupId, query),
    [projects, activeGroupId, query],
  );
  const groups = groupRows.slice(2).map((row) => row.label);
  const inheritedGroup = selectedProjectGroup(activeGroupId);

  useEffect(() => {
    if (!groupRows.some((row) => row.id === activeGroupId)) setActiveGroupId(ALL_PROJECTS);
  }, [activeGroupId, groupRows]);

  const onGroupRailKeyDown = (e: React.KeyboardEvent) => {
    const current = Math.max(
      0,
      groupRows.findIndex((row) => row.id === activeGroupId),
    );
    let next = current;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      next = Math.min(groupRows.length - 1, current + 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      next = Math.max(0, current - 1);
    } else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = groupRows.length - 1;
    else return;
    e.preventDefault();
    setActiveGroupId(groupRows[next].id);
    groupRailRef.current?.querySelectorAll<HTMLElement>(".project-library-rail-row")[next]?.focus();
  };

  return (
    <div className="welcome" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
      {projects !== null && projects.length > 0 && (
        <div className={`welcome-search${scrolled ? " scrolled" : ""}`}>
          <input
            ref={searchRef}
            className="modal-input welcome-search-input"
            type="search"
            placeholder="Search projects…"
            aria-label="Search projects"
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
            {empty
              ? "Turn your latest features into polished product films, entirely on this Mac."
              : "Your video projects."}
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
            ref={groupRailRef}
            className="project-library-rail"
            aria-label="Project groups"
            onKeyDown={onGroupRailKeyDown}
          >
            {groupRows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`project-library-rail-row${activeGroupId === row.id ? " selected" : ""}`}
                aria-pressed={activeGroupId === row.id}
                tabIndex={activeGroupId === row.id ? 0 : -1}
                onClick={() => setActiveGroupId(row.id)}
              >
                <span className="project-library-rail-label">{row.label}</span>
                <span className="project-library-rail-count">{row.count}</span>
              </button>
            ))}
          </fieldset>

          <main className="project-library-results">
            {trimmedQuery && visibleProjects.length === 0 && (
              <p className="welcome-no-matches">No projects match “{query.trim()}”.</p>
            )}
            {!trimmedQuery &&
              activeGroupId === UNGROUPED_PROJECTS &&
              visibleProjects.length === 0 && (
                <p className="welcome-no-matches">No ungrouped projects.</p>
              )}
            <div className="project-grid">
              {visibleProjects.map((p) => (
                <ProjectCard
                  key={p.slug}
                  project={p}
                  groups={groups}
                  onOpen={() => onOpenProject(`ws:${p.slug}`)}
                  onChanged={() => setRetryNonce((n) => n + 1)}
                />
              ))}
              <button
                type="button"
                className="project-card new-project"
                onClick={() => onNewProject(inheritedGroup)}
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

            {showDevProjects && (
              <>
                <h2 className="welcome-section">Built-in projects (dev)</h2>
                <div className="project-grid">
                  {listProjectIds().map((id) => (
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
              </>
            )}
          </main>
        </div>
      )}

      <footer className="welcome-footer">
        <p className="welcome-about" title="No early-morning wake-up call required.">
          Built after dark in South Australia. Runs entirely on your Mac.
        </p>
        <p className="welcome-legal">
          "iPhone" is a trademark of Apple Inc. Kookaburra Cut is not affiliated with or endorsed by
          Apple.
        </p>
        <button
          type="button"
          className="version-label"
          title="Kookaburra Cut"
          onClick={(e) => {
            // ⌥-click reveals the bundled gate projects, a dev affordance, not a feature.
            if (e.altKey) setShowDevProjects((v) => !v);
          }}
        >
          Kookaburra Cut {appVersion}
        </button>
      </footer>
    </div>
  );
}
