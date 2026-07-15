import { describe, expect, it } from "vitest";
import {
  buildCommands,
  COMMAND_GROUPS,
  type CommandContext,
  scoreCommand,
  searchCommands,
  subsequenceScore,
} from "./commandRegistry";

const noop = () => {};

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    view: "editor",
    projectId: "ws:my-project",
    projectLoaded: true,
    isWorkspace: true,
    hasAudio: true,
    exporting: false,
    hasWorkspaceRoot: true,
    playing: false,
    audioMuted: false,
    railOpen: false,
    aspect: "16:9",
    projects: [
      { id: "ws:my-project", name: "My Project", source: "workspace" },
      { id: "ws:other", name: "Other Project", source: "workspace" },
      { id: "showcase-tour", name: "showcase-tour", source: "bundled" },
    ],
    actions: {
      backToProjects: noop,
      newProject: noop,
      openProject: noop,
      openMedia: noop,
      openTheme: noop,
      setSoundtrack: noop,
      removeSoundtrack: noop,
      toggleRail: noop,
      setAspect: noop,
      togglePlay: noop,
      toggleMute: noop,
      openExport: noop,
      verify: noop,
      showShortcuts: noop,
    },
    ...overrides,
  };
}

describe("buildCommands (the vocabulary pin)", () => {
  it("covers every action the v13 · M2 titlebar strip removal relies on", () => {
    const ids = buildCommands(ctx()).map((c) => c.id);
    // The old center strip's actions (Projects · Claude · Media · Theme · New project · project/aspect select · Verify ×2); Export stays a titlebar CTA too but must be reachable here.
    for (const required of [
      "project.browse",
      "view.rail",
      "project.media",
      "project.theme",
      "project.new",
      "project.open:ws:other",
      "project.open:showcase-tour",
      "view.aspect:16:9",
      "view.aspect:9:16",
      "view.aspect:1:1",
      "view.aspect:4:5",
      "export.verify",
      "export.open",
      // Relocated rail Music menu: the inspector and the palette both own it now.
      "project.soundtrack.set",
      "project.soundtrack.remove",
      "playback.toggle",
      "playback.mute",
      "help.shortcuts",
    ]) {
      expect(ids, `missing command ${required}`).toContain(required);
    }
  });

  it("never lists the CURRENT project as an open target", () => {
    const ids = buildCommands(ctx()).map((c) => c.id);
    expect(ids).not.toContain("project.open:ws:my-project");
  });

  it("marks the current aspect and only that one", () => {
    const hints = buildCommands(ctx({ aspect: "9:16" }))
      .filter((c) => c.id.startsWith("view.aspect:"))
      .map((c) => [c.id, c.hint]);
    expect(hints).toContainEqual(["view.aspect:9:16", "current"]);
    expect(hints.filter(([, h]) => h === "current")).toHaveLength(1);
  });

  it("every command belongs to a canonical group", () => {
    for (const c of buildCommands(ctx())) {
      expect(COMMAND_GROUPS).toContain(c.group);
    }
  });

  it("gates workspace-only commands off for bundled projects", () => {
    const byId = Object.fromEntries(
      buildCommands(ctx({ isWorkspace: false, hasAudio: false })).map((c) => [c.id, c.enabled]),
    );
    expect(byId["project.media"]).toBe(false);
    expect(byId["project.theme"]).toBe(false);
    expect(byId["project.soundtrack.set"]).toBe(false);
    expect(byId["view.rail"]).toBe(false);
    // Aspect/verify/export stay available on bundled projects (dev surface).
    expect(byId["view.aspect:1:1"]).toBe(true);
    expect(byId["export.verify"]).toBe(true);
  });

  it("exporting disables everything that would fight the run (rail/mute/help stay)", () => {
    // The survivors mirror today's titlebar/scrubber: the Claude button and mute toggle carry no disabled={exporting}, and the shortcuts sheet is inert.
    const cmds = buildCommands(ctx({ exporting: true }));
    const enabled = cmds.filter((c) => c.enabled).map((c) => c.id);
    expect(enabled.sort()).toEqual(["help.shortcuts", "playback.mute", "view.rail"].sort());
  });

  it("titles flip with state (play/pause, mute/unmute, rail, soundtrack)", () => {
    const on = Object.fromEntries(
      buildCommands(ctx({ playing: true, audioMuted: true, railOpen: true })).map((c) => [
        c.id,
        c.title,
      ]),
    );
    expect(on["playback.toggle"]).toBe("Pause");
    expect(on["playback.mute"]).toBe("Unmute soundtrack");
    expect(on["view.rail"]).toBe("Hide the Claude Code rail");
    expect(on["project.soundtrack.set"]).toBe("Replace soundtrack…");
    const off = Object.fromEntries(
      buildCommands(ctx({ hasAudio: false })).map((c) => [c.id, c.title]),
    );
    expect(off["project.soundtrack.set"]).toBe("Choose soundtrack…");
  });
});

describe("subsequenceScore (the scorer contract)", () => {
  it("requires an in-order subsequence", () => {
    expect(subsequenceScore("np", "New project…")).not.toBeNull();
    expect(subsequenceScore("pn", "New project…")).toBeNull();
    expect(subsequenceScore("xyz", "Export…")).toBeNull();
  });

  it("folds case", () => {
    expect(subsequenceScore("EXPORT", "Export…")).not.toBeNull();
  });

  it("word starts outrank mid-word hits", () => {
    const wordStart = subsequenceScore("p", "project") ?? 0;
    const midWord = subsequenceScore("p", "export") ?? 0;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("consecutive runs outrank scattered mid-word matches", () => {
    const run = subsequenceScore("exp", "export") ?? 0;
    const scattered = subsequenceScore("exp", "elixir soap") ?? 0;
    expect(run).toBeGreaterThan(scattered);
  });

  it("acronym-style word-start matches beat buried runs (the ⌘K idiom)", () => {
    const acronym = subsequenceScore("np", "New project…") ?? 0;
    const buried = subsequenceScore("np", "opencanopy") ?? 0;
    expect(acronym).toBeGreaterThan(buried);
  });

  it("is deterministic", () => {
    expect(subsequenceScore("media", "Media library…")).toBe(
      subsequenceScore("media", "Media library…"),
    );
  });
});

describe("scoreCommand", () => {
  it("title matches outrank keyword matches at equal structure", () => {
    const base = { id: "x", group: "Help" as const, enabled: true, run: noop };
    const byTitle = scoreCommand("verify", { ...base, title: "verify", keywords: [] });
    const byKeyword = scoreCommand("verify", { ...base, title: "zzzz", keywords: ["verify"] });
    expect(byTitle ?? 0).toBeGreaterThan(byKeyword ?? 0);
  });

  it("empty query matches everything at score 0", () => {
    const cmd = {
      id: "x",
      title: "Anything",
      group: "Help" as const,
      keywords: [],
      enabled: true,
      run: noop,
    };
    expect(scoreCommand("", cmd)).toBe(0);
    expect(scoreCommand("   ", cmd)).toBe(0);
  });
});

describe("searchCommands", () => {
  it("empty query lists every enabled command, groups in canonical order", () => {
    const groups = searchCommands("", ctx());
    const order = groups.map((g) => g.group);
    expect(order).toEqual([...COMMAND_GROUPS].filter((g) => order.includes(g)));
    const total = groups.reduce((n, g) => n + g.commands.length, 0);
    expect(total).toBe(buildCommands(ctx()).filter((c) => c.enabled).length);
  });

  it("finds commands by keyword, not just title", () => {
    const groups = searchCommands("music", ctx());
    const ids = groups.flatMap((g) => g.commands.map((c) => c.id));
    expect(ids).toContain("playback.mute");
    expect(ids).toContain("project.soundtrack.set");
  });

  it("drops non-matches and disabled commands", () => {
    const groups = searchCommands("verify", ctx({ exporting: true }));
    expect(groups.flatMap((g) => g.commands)).toHaveLength(0);
  });

  it("ranks the obvious target first for a prefix query", () => {
    const groups = searchCommands("exp", ctx());
    const first = groups[0]?.commands[0];
    expect(first?.id).toBe("export.open");
  });

  it("is stable — same input, same output", () => {
    const a = searchCommands("pro", ctx()).flatMap((g) => g.commands.map((c) => c.id));
    const b = searchCommands("pro", ctx()).flatMap((g) => g.commands.map((c) => c.id));
    expect(a).toEqual(b);
  });
});
