import { invoke } from "@tauri-apps/api/core";

/** Frontend face of claude_app.rs: hand a workspace project to the Claude desktop app, with Finder and the download page as the fallbacks; see src-tauri/src/claude_app.rs. */

/** `openInClaude` rejects with exactly this when no app handles `claude://`. */
export const CLAUDE_APP_MISSING = "claude-app-missing";

export function claudeAppInstalled(): Promise<boolean> {
  return invoke<boolean>("claude_app_status");
}

/** A new Claude Code session in the project's folder; `prompt` is typed in, never sent. */
export function openInClaude(slug: string, prompt?: string): Promise<void> {
  return invoke<void>("open_in_claude", { slug, prompt: prompt ?? null });
}

export function openProjectFolder(slug: string): Promise<void> {
  return invoke<void>("open_project_folder", { slug });
}

export function openClaudeDownload(): Promise<void> {
  return invoke<void>("open_claude_download");
}

export function openSettingsWindow(): Promise<void> {
  return invoke<void>("open_settings");
}

/** Either field alone updates just that preference; emits `kookaburra://claude-preferences-changed`. */
export function setClaudePreferences(prefs: {
  builtinTerminal?: boolean;
  firstOpen?: boolean;
}): Promise<void> {
  return invoke<void>("set_claude_preferences", {
    builtinTerminal: prefs.builtinTerminal ?? null,
    firstOpen: prefs.firstOpen ?? null,
  });
}

export type ClaudeStarter = "scene" | "look" | "pacing" | "media";

/** Starters stop mid-sentence so the user finishes the thought in Claude before sending. */
export function claudeStarterPrompt(kind: ClaudeStarter, sceneName: string | null): string {
  switch (kind) {
    case "scene":
      return sceneName ? `Add a new scene after "${sceneName}" that ` : "Add a new scene that ";
    case "look":
      return "Change the look of this video: ";
    case "pacing":
      return "Change the pacing of this video: ";
    case "media":
      return "Use my media from assets/ in this video: ";
  }
}

const LAUNCHER_SEEN_KEY = "kookaburra:claude-launcher-seen";
const LAUNCHER_SEEN_CAP = 500;

function readSeen(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAUNCHER_SEEN_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The launcher opens by itself only on a project's first open; this records that it has. */
export function claimClaudeLauncherFirstOpen(projectId: string): boolean {
  const seen = readSeen();
  if (seen.includes(projectId)) return false;
  try {
    localStorage.setItem(
      LAUNCHER_SEEN_KEY,
      JSON.stringify([...seen, projectId].slice(-LAUNCHER_SEEN_CAP)),
    );
  } catch {
    // Storage blocked: greeting again next time beats never greeting.
  }
  return true;
}
