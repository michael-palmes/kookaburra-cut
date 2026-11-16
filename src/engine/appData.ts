import { invoke } from "@tauri-apps/api/core";
import { formatAgo } from "./updates";
import { shortenPath, type TrustRecord } from "./workspace";

/** Settings' reach into what the app keeps about the person: one project's Allow, the full reset and the log folder (settings_win.rs). */

export interface AllowedProjectRow {
  /** The settings key: a workspace slug, or a `ws-template:` / `ws-preset:` id. */
  key: string;
  name: string;
  path: string;
  detail: string;
  /** Open in the main window now, so forgetting it would ask mid-session. */
  open: boolean;
}

const SCOPES: Record<string, string> = {
  "ws-template": "Template",
  "ws-preset": "Scene preset",
};

function nameFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

/** Workspace projects are `ws:<slug>` in the main window and a bare slug in settings; library ids match as they are. */
function editorId(key: string): string {
  return key.includes(":") ? key : `ws:${key}`;
}

export function allowedProjectRows(
  trusted: Record<string, TrustRecord> | undefined,
  lastProject: string | null | undefined,
  home: string | null,
  nowMs: number,
): AllowedProjectRow[] {
  return Object.entries(trusted ?? {})
    .map(([key, record]) => {
      const [scope, slug] = key.includes(":") ? key.split(":", 2) : ["", key];
      const kind = SCOPES[scope];
      const where = shortenPath(record.path, home);
      const when = `allowed ${formatAgo(record.allowedAtMs, nowMs)}`;
      return {
        key,
        name: nameFromSlug(slug),
        path: record.path,
        detail: [kind, where, when].filter(Boolean).join(" · "),
        open: editorId(key) === lastProject,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export function forgetAllowedProject(slug: string): Promise<void> {
  return invoke<void>("forget_allowed_project", { slug });
}

/** Rust asks on a native sheet first (Return cancels); false is the cancel. */
export function clearAppData(): Promise<boolean> {
  return invoke<boolean>("clear_app_data");
}

export function revealAppLogs(): Promise<void> {
  return invoke<void>("reveal_app_logs");
}

export function revealLicences(): Promise<void> {
  return invoke<void>("reveal_licences");
}
