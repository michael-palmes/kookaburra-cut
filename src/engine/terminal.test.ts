import { describe, expect, it } from "vitest";
import { binaryDir, claudeSessionCommand, shellQuote } from "./terminal";

// The spawn command is part of the packaged-app contract: the panel execs the detected binary by full path, since login non-interactive shells never source ~/.zshrc, where the default install writes its PATH line.

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("/Users/m/.local/bin/claude")).toBe("'/Users/m/.local/bin/claude'");
  });

  it("survives spaces and metacharacters", () => {
    expect(shellQuote("/Users/m/My Tools/claude")).toBe("'/Users/m/My Tools/claude'");
    expect(shellQuote("$HOME/`x`;rm")).toBe("'$HOME/`x`;rm'");
  });

  it("splices embedded single quotes", () => {
    expect(shellQuote("/Users/m/o'brien/claude")).toBe("'/Users/m/o'\\''brien/claude'");
  });
});

describe("binaryDir", () => {
  it("returns the parent directory of an absolute path", () => {
    expect(binaryDir("/Users/m/.local/bin/claude")).toBe("/Users/m/.local/bin");
  });

  it("returns null for a bare name (nothing to prepend)", () => {
    expect(binaryDir("claude")).toBeNull();
  });

  it("returns null for a root-level file (never prepend an empty string)", () => {
    expect(binaryDir("/claude")).toBeNull();
  });
});

describe("claudeSessionCommand", () => {
  it("execs the detected path quoted, with the pinned permission mode", () => {
    expect(claudeSessionCommand(false, "/Users/m/.local/bin/claude")).toBe(
      "exec '/Users/m/.local/bin/claude' --permission-mode acceptEdits",
    );
  });

  it("adds --continue when resuming", () => {
    expect(claudeSessionCommand(true, "/opt/homebrew/bin/claude")).toBe(
      "exec '/opt/homebrew/bin/claude' --continue --permission-mode acceptEdits",
    );
  });
});
