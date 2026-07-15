import { useEffect, useRef, useState } from "react";
import { listProjectIds } from "../engine/project";
import {
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
  snapshotUrl,
  type WorkspaceProjectInfo,
} from "../engine/workspace";
import { NamePromptModal } from "./NamePromptModal";

const APP_VERSION = "0.1.0";

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

function ProjectCard({
  project,
  onOpen,
  onChanged,
}: {
  project: WorkspaceProjectInfo;
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
  const [prompt, setPrompt] = useState<"rename" | "duplicate" | null>(null);
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
    </div>
  );
}

/** The welcome screen: the user's projects as snapshot cards, a New Project affordance, and, behind an ⌥-click on the version label, the bundled dev/gate projects; sorted most-recently-opened first. */
export function Welcome({
  onOpenProject,
  onNewProject,
  refreshKey,
}: {
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
  /** Bump to re-scan the workspace (e.g. after a create). */
  refreshKey: number;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectInfo[] | null>(null);
  const [showDevProjects, setShowDevProjects] = useState(false);
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

  return (
    <div className="welcome">
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

      <div className="project-grid">
        {(projects ?? []).map((p) => (
          <ProjectCard
            key={p.slug}
            project={p}
            onOpen={() => onOpenProject(`ws:${p.slug}`)}
            onChanged={() => setRetryNonce((n) => n + 1)}
          />
        ))}
        <button type="button" className="project-card new-project" onClick={onNewProject}>
          <span className="new-project-plus" aria-hidden="true">
            +
          </span>
          <span>New project</span>
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
          Kookaburra Cut {APP_VERSION}
        </button>
      </footer>
    </div>
  );
}
