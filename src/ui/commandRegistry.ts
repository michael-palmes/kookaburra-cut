import type { AspectName } from "../engine/format";
import { FORMATS } from "../engine/format";
import type { ProjectListing } from "../engine/project";
import { WORKSPACE_PROJECT_PREFIX } from "../engine/project";

/** Pure command registry for the ⌘K palette: everything it can do is enumerated here as data, built from a snapshot of app state (`CommandContext`), with the vocabulary and enablement rules structure-pinned in unit tests. The palette component renders whatever this module returns and never invents commands of its own; removing the titlebar's center button strip required every action it fronted to exist here first. */

/** Canonical group order: `searchCommands` returns groups in this order. */
export const COMMAND_GROUPS = ["Project", "Playback", "View", "Export", "Help"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** A snapshot of the app state the registry derives commands from (built in App). */
export interface CommandContext {
  view: "loading" | "welcome" | "editor";
  /** The store's current project id (the palette marks/open-skips the current project). */
  projectId: string;
  /** A project finished loading (transport/export commands need one). */
  projectLoaded: boolean;
  /** The loaded project is a workspace project (editing surfaces need native writes). */
  isWorkspace: boolean;
  /** The loaded project has a soundtrack (mute/remove-soundtrack). */
  hasAudio: boolean;
  exporting: boolean;
  hasWorkspaceRoot: boolean;
  playing: boolean;
  audioMuted: boolean;
  railOpen: boolean;
  aspect: AspectName;
  projects: ProjectListing[];
  actions: {
    backToProjects: () => void;
    newProject: () => void;
    openProject: (id: string) => void;
    openMedia: () => void;
    openTheme: () => void;
    setSoundtrack: () => void;
    removeSoundtrack: () => void;
    toggleRail: () => void;
    setAspect: (name: AspectName) => void;
    togglePlay: () => void;
    toggleMute: () => void;
    openExport: () => void;
    verify: () => void;
    showShortcuts: () => void;
    checkForUpdates: () => void;
  };
}

export interface Command {
  /** Stable id (pinned in tests; never derive UI copy from it). */
  id: string;
  title: string;
  group: CommandGroup;
  /** Extra search terms beyond the title (lowercase not required, matching folds case). */
  keywords: string[];
  /** Right-aligned hint: a shortcut ("⌘E") or a state marker ("current"). */
  hint?: string;
  enabled: boolean;
  run: () => void;
}

/** Every command the palette knows, with enablement baked from the context snapshot. */
export function buildCommands(ctx: CommandContext): Command[] {
  const editor = ctx.view === "editor";
  const a = ctx.actions;
  const commands: Command[] = [
    {
      id: "project.new",
      title: "New project…",
      group: "Project",
      keywords: ["create", "template", "start"],
      enabled: !ctx.exporting && ctx.hasWorkspaceRoot,
      run: a.newProject,
    },
    {
      id: "project.browse",
      title: "Back to projects",
      group: "Project",
      keywords: ["welcome", "gallery", "browse", "home", "switch"],
      enabled: editor && !ctx.exporting,
      run: a.backToProjects,
    },
    ...ctx.projects
      .filter((r) => r.id !== ctx.projectId)
      .map<Command>((r) => ({
        id: `project.open:${r.id}`,
        title: `Open project: ${r.name}`,
        group: "Project",
        keywords: [
          "switch",
          "load",
          r.source === "workspace" ? "workspace" : "built-in",
          r.id.replace(WORKSPACE_PROJECT_PREFIX, ""),
        ],
        enabled: !ctx.exporting,
        run: () => a.openProject(r.id),
      })),
    {
      id: "project.media",
      title: "Media library…",
      group: "Project",
      keywords: ["assets", "video", "image", "import", "footage"],
      enabled: editor && ctx.isWorkspace && !ctx.exporting,
      run: a.openMedia,
    },
    {
      id: "project.theme",
      title: "Theme…",
      group: "Project",
      keywords: ["style", "look", "colours", "colors", "fonts", "apply"],
      enabled: editor && ctx.isWorkspace && !ctx.exporting,
      run: a.openTheme,
    },
    {
      id: "project.soundtrack.set",
      title: ctx.hasAudio ? "Replace soundtrack…" : "Choose soundtrack…",
      group: "Project",
      keywords: ["music", "audio", "track", "song", "sound"],
      enabled: editor && ctx.isWorkspace && !ctx.exporting,
      run: a.setSoundtrack,
    },
    {
      id: "project.soundtrack.remove",
      title: "Remove soundtrack",
      group: "Project",
      keywords: ["music", "audio", "track", "delete"],
      enabled: editor && ctx.isWorkspace && ctx.hasAudio && !ctx.exporting,
      run: a.removeSoundtrack,
    },
    {
      id: "playback.toggle",
      title: ctx.playing ? "Pause" : "Play",
      group: "Playback",
      keywords: ["play", "pause", "preview", "transport"],
      hint: "Space",
      enabled: editor && ctx.projectLoaded && !ctx.exporting,
      run: a.togglePlay,
    },
    {
      id: "playback.mute",
      title: ctx.audioMuted ? "Unmute soundtrack" : "Mute soundtrack",
      group: "Playback",
      keywords: ["music", "audio", "sound", "silence", "preview"],
      enabled: editor && ctx.hasAudio,
      run: a.toggleMute,
    },
    {
      id: "view.rail",
      title: ctx.railOpen ? "Hide the Claude Code rail" : "Edit in Claude Code",
      group: "View",
      keywords: ["claude", "terminal", "rail", "panel", "ai", "chat"],
      hint: "⌘E",
      enabled: editor && ctx.isWorkspace,
      run: a.toggleRail,
    },
    ...(Object.keys(FORMATS) as AspectName[]).map<Command>((name) => ({
      id: `view.aspect:${name}`,
      title: `Aspect ratio: ${name}`,
      group: "View",
      keywords: ["format", "orientation", "portrait", "landscape", "square", "ratio"],
      hint: name === ctx.aspect ? "current" : undefined,
      enabled: editor && !ctx.exporting,
      run: () => a.setAspect(name),
    })),
    {
      id: "export.open",
      title: "Export…",
      group: "Export",
      keywords: ["render", "video", "preset", "save", "mp4", "mov"],
      enabled: editor && ctx.projectLoaded && !ctx.exporting,
      run: a.openExport,
    },
    {
      id: "export.verify",
      title: "Verify ×2 (determinism gate)",
      group: "Export",
      keywords: ["deterministic", "hash", "byte-identical", "gate", "check"],
      enabled: editor && ctx.projectLoaded && !ctx.exporting,
      run: a.verify,
    },
    {
      id: "help.shortcuts",
      title: "Keyboard shortcuts",
      group: "Help",
      keywords: ["keys", "hotkeys", "reference", "help", "sheet"],
      hint: "⌘/",
      enabled: true,
      run: a.showShortcuts,
    },
    {
      id: "help.checkForUpdates",
      title: "Check for updates",
      group: "Help",
      keywords: ["update", "version", "upgrade", "release", "new"],
      // Not during an export: a mid-run install-and-relaunch would kill the encode.
      enabled: !ctx.exporting,
      run: a.checkForUpdates,
    },
  ];
  return commands;
}

/**
 * Case-folded subsequence scorer (no dependencies, fully deterministic): every query
 * character must appear in order; word-start matches and consecutive runs score higher;
 * shorter targets win ties. Returns null when the query is not a subsequence.
 */
export function subsequenceScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    score += 2;
    const before = found === 0 ? " " : t[found - 1];
    if (!/[a-z0-9]/.test(before)) score += 3; // word start
    if (found === prevMatch + 1) score += 2; // consecutive run
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer tighter, shorter targets: a stable fractional tiebreak that never reorders a strictly better structural match.
  return score - t.length * 0.01;
}

/** A command's best score across its title and keywords (null = no match). */
export function scoreCommand(query: string, cmd: Command): number | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return 0;
  let best: number | null = null;
  const candidates = [cmd.title, ...cmd.keywords];
  for (const [i, text] of candidates.entries()) {
    const s = subsequenceScore(trimmed, text);
    if (s === null) continue;
    // Title matches outrank keyword matches at equal structure.
    const weighted = i === 0 ? s + 1 : s;
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

export interface CommandGroupResult {
  group: CommandGroup;
  commands: Command[];
}

/** Enabled commands matching the query, grouped in canonical group order. An empty query lists everything (browse mode); otherwise commands rank by score within their group, ties broken by registry order (stable: same input, same output). */
export function searchCommands(query: string, ctx: CommandContext): CommandGroupResult[] {
  const scored: { cmd: Command; score: number; order: number }[] = [];
  buildCommands(ctx).forEach((cmd, order) => {
    if (!cmd.enabled) return;
    const score = scoreCommand(query, cmd);
    if (score === null) return;
    scored.push({ cmd, score, order });
  });
  scored.sort((x, y) => y.score - x.score || x.order - y.order);
  return COMMAND_GROUPS.map((group) => ({
    group,
    commands: scored.filter((s) => s.cmd.group === group).map((s) => s.cmd),
  })).filter((g) => g.commands.length > 0);
}
