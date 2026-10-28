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

/** docs/privacy.md in the browser: what leaves the Mac and how to turn each channel off. */
export function openPrivacyPage(): Promise<void> {
  return invoke<void>("open_privacy_page");
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

const LAUNCHER_PENDING_KEY = "kookaburra:claude-launcher-pending";
const LAUNCHER_PENDING_CAP = 50;
/** A pending entry that greets whichever project opens next. */
const NEXT_OPEN = "*";

function readPending(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAUNCHER_PENDING_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writePending(ids: string[]): boolean {
  try {
    localStorage.setItem(LAUNCHER_PENDING_KEY, JSON.stringify(ids.slice(-LAUNCHER_PENDING_CAP)));
    return true;
  } catch {
    // Storage blocked: a missed greeting costs nothing, the titlebar button still opens it.
    return false;
  }
}

/** A project created here greets on its first open; any other project greets only after a re-arm. */
export function queueClaudeLauncherGreeting(projectId: string): void {
  writePending([...readPending().filter((id) => id !== projectId), projectId]);
}

/** Settings turning the greeting back on: the next project open greets once. */
export function rearmClaudeLauncherGreeting(): void {
  queueClaudeLauncherGreeting(NEXT_OPEN);
}

/** True once per queued greeting, and only when consuming it sticks, so a failed write never greets on every open. */
export function claimClaudeLauncherGreeting(projectId: string): boolean {
  const pending = readPending();
  const rest = pending.filter((id) => id !== projectId && id !== NEXT_OPEN);
  if (rest.length === pending.length) return false;
  return writePending(rest);
}
