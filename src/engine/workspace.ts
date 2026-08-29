import { invoke } from "@tauri-apps/api/core";
import { fsUrl } from "./media";

/** Frontend face of the native workspace module: first-run settings, project listing/creation, snapshots. The native side owns all path resolution and re-asserts the on-disk layout on every call; see src-tauri/src/workspace.rs. */

export interface AppSettings {
  workspaceRoot: string | null;
  /** Project id (`ws:<slug>` or bundled) reopened on boot; null/absent → welcome screen. */
  lastProject?: string | null;
  /** Last export-modal pick per project id + the global fallback. */
  lastExportPresetByProject?: Record<string, string>;
  lastExportPreset?: string | null;
  /** Inverted so absent/false means opening poster frames are enabled app-wide. */
  disableOpeningPosterFrame?: boolean;
  /** Inverted flag so its default (false) means hardware video ON. */
  disableHardwareVideo?: boolean;
  /** Inverted flag so its default (false) means app exports land in ~/Downloads. */
  keepExportsInProject?: boolean;
  /** Playback slowdown-badge sensitivity: "off" | "sustained" | "strict"; absent = "off". */
  lagWarning?: string | null;
  /** Tri-state auto-update consent: absent/null = undecided (first-run ask still owed). */
  updateCheckConsent?: boolean | null;
  /** Unix-ms of the last update check; only persisted while consent is on. */
  lastUpdateCheckMs?: number | null;
  /** Last version offered and declined, so it isn't re-offered every launch. */
  lastOfferedVersion?: string | null;
  /** Last Present-modal pick per project id + the cross-project default. */
  presentOptionsByProject?: Record<string, PresentOptions>;
  presentOptionsDefault?: PresentOptions | null;
}

/** The Present modal's remembered options (mirrors PresentOptionsDoc in workspace.rs). */
export interface PresentOptions {
  mode: "video" | "slideshow";
  quality: "full" | "smooth";
  soundtrack: boolean;
  fullscreen: boolean;
}

export interface WorkspaceProjectInfo {
  slug: string;
  name: string;
  path: string;
  durationMs: number;
  snapshotPath: string | null;
  snapshotMtimeMs: number | null;
  lastOpenedMs: number | null;
  /** Newest content edit (unix ms) across the manifest, scenes and assets. */
  contentMtimeMs: number | null;
  /** Welcome-screen section heading, from project.json. */
  group: string | null;
}

export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/** Create/adopt the workspace under `parent` (omit for ~/Kookaburra Cut) and persist it. */
export function initWorkspace(parent?: string | null): Promise<string> {
  return invoke<string>("init_workspace", { parent: parent ?? null });
}

/** Where a workspace lands with nothing chosen, and what "Reset to default" moves back to. */
export function defaultWorkspaceRoot(): Promise<string> {
  return invoke<string>("default_workspace_root");
}

/** The user's home folder, so a long workspace path can display as `~/…`. */
export function userHomeDir(): Promise<string> {
  return invoke<string>("user_home_dir");
}

/** `~`-abbreviated for display; the real path still belongs in the tooltip. */
export function shortenPath(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Move the whole workspace under `parent` (omit to reset to the default) and repoint settings at it. */
export function moveWorkspace(parent?: string | null): Promise<string> {
  return invoke<string>("move_workspace", { parent: parent ?? null });
}

/** `templateId` is a bundled template slug or `ws:<slug>` for one of the user's own; the manifest itself (`template.json`) is never copied into the new project. Library commands live in engine/library.ts. */
export function createProject(
  name: string,
  templateId: string,
  group?: string | null,
): Promise<WorkspaceProjectInfo> {
  return invoke<WorkspaceProjectInfo>("create_project", { name, templateId, group: group ?? null });
}

/** Set or clear the project's welcome-screen group. */
export function setProjectGroup(slug: string, group: string | null): Promise<void> {
  return invoke("set_project_group", { slug, group });
}

/** Set or clear the project's typography override ("Family@weight" strings; all null clears). `chart` is the project's default chart face. */
export function setProjectTypography(
  slug: string,
  headline: string | null,
  body: string | null,
  chart: string | null,
): Promise<void> {
  return invoke("set_project_typography", { slug, headline, body, chart });
}

export function listProjects(): Promise<WorkspaceProjectInfo[]> {
  return invoke<WorkspaceProjectInfo[]>("list_projects");
}

/** Remember (or clear) the project to reopen on next boot; stamps last-opened for ws projects. */
export function renameProject(slug: string, name: string): Promise<void> {
  return invoke("rename_project", { slug, name });
}

/** Returns the new project's slug. */
export function duplicateProject(slug: string, name: string): Promise<string> {
  return invoke("duplicate_project", { slug, name });
}

/** Moves the project folder to the Trash (recoverable). */
export function deleteProject(slug: string): Promise<void> {
  return invoke("delete_project", { slug });
}

export function setLastProject(projectId: string | null): Promise<void> {
  return invoke<void>("set_last_project", { projectId });
}

/** Toggle hardware video for the everyday paths (thumbnails, clip extraction, editor render); emits `kookaburra://hardware-video-changed`. */
export function setHardwareVideoSetting(enabled: boolean): Promise<void> {
  return invoke<void>("set_hardware_video", { enabled });
}

/** Toggle the Downloads export destination (app-triggered exports only). */
export function setExportToDownloadsSetting(enabled: boolean): Promise<void> {
  return invoke<void>("set_export_to_downloads", { enabled });
}

export type LagWarningMode = "off" | "sustained" | "strict";

/** Set the playback slowdown-badge sensitivity; emits `kookaburra://lag-warning-changed`. */
export function setLagWarningSetting(mode: LagWarningMode): Promise<void> {
  return invoke<void>("set_lag_warning", { mode });
}

// ── Export presets: `~/Kookaburra Cut/export-presets/<slug>.json` ─────────

export interface ExportPresetListing {
  slug: string;
  /** The raw preset JSON text, parsed frontend-side (`parseExportPreset`). */
  json: string;
}

export function listExportPresets(): Promise<ExportPresetListing[]> {
  return invoke<ExportPresetListing[]>("list_export_presets");
}

export function writeExportPreset(slug: string, text: string): Promise<void> {
  return invoke<void>("write_export_preset", { slug, text });
}

export function deleteExportPreset(slug: string): Promise<void> {
  return invoke<void>("delete_export_preset", { slug });
}

/** Remember the export modal's pick, per project, with the global pick as fallback. */
export function setLastExportPreset(projectId: string, presetId: string): Promise<void> {
  return invoke<void>("set_last_export_preset", { projectId, presetId });
}

/** Remember the opening poster-frame choice across projects and app launches. */
export function setOpeningPosterFrame(enabled: boolean): Promise<void> {
  return invoke<void>("set_opening_poster_frame", { enabled });
}

/** Remember the Present modal's pick per project; saveAsDefault also writes the cross-project default. */
export function setPresentOptions(
  projectId: string,
  options: PresentOptions,
  saveAsDefault: boolean,
): Promise<void> {
  return invoke<void>("set_present_options", { projectId, options, saveAsDefault });
}

/** Change fingerprint of a project's sources (project.json + scenes/**); see workspace.rs. */
export function projectFingerprint(slug: string): Promise<string> {
  return invoke<string>("project_fingerprint", { slug });
}

/** Asset-protocol URL for a project's welcome-card snapshot (one seam for dev and packaged), cache-busted by mtime so a fresh capture replaces the cached image. */
export function snapshotUrl(project: WorkspaceProjectInfo): string | null {
  if (!project.snapshotPath || !project.snapshotMtimeMs) return null;
  return `${fsUrl(project.snapshotPath)}?v=${project.snapshotMtimeMs}`;
}

/** Mirror of the native slug rules (workspace.rs `slugify`) for the create dialog's preview. */
export function slugifyName(name: string): string {
  let slug = "";
  let lastHyphen = true; // suppress leading hyphens
  for (const c of name.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(c)) {
      slug += c;
      lastHyphen = false;
    } else if (!lastHyphen) {
      slug += "-";
      lastHyphen = true;
    }
  }
  return slug.replace(/-+$/, "");
}
