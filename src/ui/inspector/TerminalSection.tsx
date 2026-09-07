import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useTerminalEditStore } from "../../engine/edit/terminalEditStore";
import {
  resolveSceneTerminal,
  type SceneDocTerminal,
  sanitizeStartCommand,
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_FONT_PX_MAX,
  TERMINAL_FONT_PX_MIN,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
} from "../../engine/panels/sceneTerminal";
import { bakeTerminalSnapshot } from "../../engine/panels/sceneTerminalBake";
import {
  type CaptureTerminal,
  captureTerminalSnapshot,
} from "../../engine/panels/sceneTerminalCapture";
import {
  getSceneTerminalSession,
  killSceneTerminalSession,
  sceneTerminalKey,
  startSceneTerminalSession,
} from "../../engine/panels/sceneTerminalSession";
import {
  resolveTerminalColours,
  TERMINAL_THEME_PRESETS,
} from "../../engine/panels/sceneTerminalTheme";
import { workspaceProjectPath } from "../../engine/project";
import type { Theme } from "../../theme/tokens";
import type { useSceneDocPatch } from "../useSceneDocPatch";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  DrillHeaderAction,
  NumberField,
  SegmentedRow,
} from "./rows";

type Patcher = ReturnType<typeof useSceneDocPatch>;

import type { SceneDoc } from "../../engine/sceneDocSchema";

/** The terminal drill: the live session controls, the grid, fonts and theme, the start path and command, and the snapshot bake the export renders (docs/scene-terminal.md). A SceneTab sibling section; it reads only what it is handed. */
export interface TerminalSectionProps {
  backLabel: string;
  closeDrill: () => void;
  doc: SceneDoc;
  patchDoc: Patcher["patchDoc"];
  projectId: string;
  slug: string;
  stem: string | null;
  /** The theme the terminal renders under: the scene's own, else the project's. */
  terminalTheme: Theme;
}

export function TerminalSection({
  backLabel,
  closeDrill,
  doc,
  patchDoc,
  projectId,
  slug,
  stem,
  terminalTheme,
}: TerminalSectionProps) {
  if (!doc.terminal) return null;
  const terminal = resolveSceneTerminal(doc);
  const sessionKey = stem ? sceneTerminalKey(slug, stem) : null;
  const session = sessionKey ? getSceneTerminalSession(sessionKey) : undefined;
  const running = session?.status === "running";
  const patchTerminal = (mutate: (t: SceneDocTerminal) => void, history: string) =>
    void patchDoc(
      (next) => {
        if (next.terminal) mutate(next.terminal);
      },
      { history },
    );
  const startSession = async () => {
    if (!terminal || !sessionKey) return;
    const cwd = terminal.startPath ?? workspaceProjectPath(slug);
    if (!cwd) return;
    try {
      await startSceneTerminalSession({
        key: sessionKey,
        cwd,
        terminal,
        colours: resolveTerminalColours(terminal.theme, terminalTheme),
      });
    } catch (e) {
      console.warn("[terminal] session start failed:", e);
    }
  };
  const captureSnapshot = async () => {
    const entry = sessionKey ? getSceneTerminalSession(sessionKey) : undefined;
    if (!entry || !terminal || !stem) return;
    const snapshot = captureTerminalSnapshot(entry.term as unknown as CaptureTerminal);
    try {
      const src = await bakeTerminalSnapshot(
        projectId,
        stem,
        { ...terminal, snapshot },
        terminalTheme,
      );
      void patchDoc(
        (next) => {
          if (next.terminal) next.terminal.snapshot = { ...snapshot, src };
        },
        { history: "capture terminal snapshot" },
      );
    } catch (e) {
      console.warn("[terminal] snapshot capture failed:", e);
    }
  };
  const chooseStartFolder = async () => {
    const picked = await openFolderPicker({
      directory: true,
      title: "Choose the session's start folder",
    });
    if (typeof picked === "string" && picked.length > 0) {
      patchTerminal((t) => {
        t.startPath = picked;
      }, "set terminal start path");
    }
  };
  return (
    <div className="inspector-drill">
      <DrillBack
        label={backLabel}
        title="Terminal"
        onClick={closeDrill}
        actions={
          <DrillHeaderAction
            kind="remove"
            label="Remove terminal"
            onClick={() => {
              if (sessionKey) killSceneTerminalSession(sessionKey);
              useTerminalEditStore.getState().select(null);
              void patchDoc((next) => {
                next.terminal = undefined;
              });
              closeDrill();
            }}
          />
        }
      />
      <div className="inspector-drill-body">
        {terminal && (
          <>
            <DrillGroup label="Theme">
              {TERMINAL_THEME_PRESETS.map((preset) => {
                const colours = resolveTerminalColours(preset.id, terminalTheme);
                return (
                  <ActionRow
                    key={preset.id}
                    icon={
                      <TerminalSwatchIcon screen={colours.screen} foreground={colours.foreground} />
                    }
                    label={preset.name}
                    selected={terminal.theme === preset.id}
                    chevron={false}
                    onClick={() =>
                      patchTerminal((t) => {
                        if (preset.id === "match-theme") delete t.theme;
                        else t.theme = preset.id;
                      }, "set terminal theme")
                    }
                  />
                );
              })}
            </DrillGroup>
            <DrillGroup label="Window">
              <SegmentedRow
                ariaLabel="Terminal chrome"
                options={[
                  { value: "mac", label: "Mac window", icon: <TerminalChromeStyleIcon mac /> },
                  { value: "bare", label: "Bare", icon: <TerminalChromeStyleIcon /> },
                ]}
                value={terminal.chrome.style}
                onChange={(style) =>
                  patchTerminal((t) => {
                    t.chrome = { ...(t.chrome ?? {}), style };
                  }, "set terminal chrome")
                }
              />
              {terminal.chrome.style === "mac" && (
                <TerminalTextRow
                  label="Title"
                  value={terminal.chrome.title}
                  placeholder="zsh"
                  onCommit={(title) =>
                    patchTerminal((t) => {
                      t.chrome = { ...(t.chrome ?? {}), title };
                    }, "set terminal title")
                  }
                />
              )}
            </DrillGroup>
            <DrillGroup label="Grid">
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Columns</span>
                <NumberField
                  label="Terminal columns"
                  value={terminal.cols}
                  decimals={0}
                  min={TERMINAL_COLS_MIN}
                  max={TERMINAL_COLS_MAX}
                  step={1}
                  onCommit={(n) =>
                    patchTerminal((t) => {
                      t.cols = Math.round(n);
                    }, "set terminal columns")
                  }
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Rows</span>
                <NumberField
                  label="Terminal rows"
                  value={terminal.rows}
                  decimals={0}
                  min={TERMINAL_ROWS_MIN}
                  max={TERMINAL_ROWS_MAX}
                  step={1}
                  onCommit={(n) =>
                    patchTerminal((t) => {
                      t.rows = Math.round(n);
                    }, "set terminal rows")
                  }
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Font size</span>
                <NumberField
                  label="Terminal font size"
                  value={terminal.fontPx}
                  decimals={0}
                  min={TERMINAL_FONT_PX_MIN}
                  max={TERMINAL_FONT_PX_MAX}
                  step={1}
                  onCommit={(n) =>
                    patchTerminal((t) => {
                      t.fontPx = Math.round(n);
                    }, "set terminal font size")
                  }
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Width %</span>
                <NumberField
                  label="Terminal width"
                  value={Math.round(terminal.size * 100)}
                  decimals={0}
                  min={5}
                  max={150}
                  step={1}
                  onCommit={(n) =>
                    patchTerminal((t) => {
                      t.size = n / 100;
                    }, "resize terminal")
                  }
                />
              </div>
            </DrillGroup>
            <DrillGroup
              label="Session"
              hint="The start command is typed into the prompt, never run."
            >
              <TerminalTextRow
                label="Start path"
                value={terminal.startPath ?? ""}
                placeholder="Project folder"
                onCommit={(value) =>
                  patchTerminal((t) => {
                    const trimmed = value.trim();
                    if (trimmed) t.startPath = trimmed;
                    else delete t.startPath;
                  }, "set terminal start path")
                }
              />
              <ActionRow
                icon={<TerminalActionIcon kind="folder" />}
                label="Choose folder…"
                chevron={false}
                onClick={() => void chooseStartFolder()}
              />
              <TerminalTextRow
                label="Command"
                value={terminal.startCommand ?? ""}
                placeholder="pnpm dev"
                onCommit={(value) =>
                  patchTerminal((t) => {
                    // Stored canonical: the same single-line rule parse and paste enforce.
                    const command = sanitizeStartCommand(value);
                    if (command) t.startCommand = command;
                    else delete t.startCommand;
                  }, "set terminal start command")
                }
              />
              <ActionRow
                icon={<TerminalActionIcon kind="play" />}
                label={running ? "Restart session" : "Start session"}
                chevron={false}
                onClick={() => void startSession()}
              />
            </DrillGroup>
            <DrillGroup
              label="Snapshot"
              hint="Video export renders the captured snapshot. It saves whatever is on screen into the project, and travels with packs, so avoid capturing secrets."
            >
              <ActionRow
                icon={<TerminalActionIcon kind="capture" />}
                label="Capture snapshot"
                value={terminal.snapshot?.src ? "Captured" : "None"}
                chevron={false}
                disabled={!running}
                onClick={() => void captureSnapshot()}
              />
            </DrillGroup>
          </>
        )}
      </div>
    </div>
  );
}

/** A terminal preset's swatch: its screen surface with the prompt chevron in its foreground. */
function TerminalSwatchIcon({ screen, foreground }: { screen: string; foreground: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="12"
        height="12"
        rx="3"
        fill={screen}
        stroke="rgba(255, 255, 255, 0.25)"
      />
      <path
        d="M4 5.2l2 1.8-2 1.8"
        stroke={foreground}
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TerminalChromeStyleIcon({ mac }: { mac?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="15" height="12" rx="2.5" />
      {mac && <path d="M2.5 8h15M5.4 6.1h.01M7.8 6.1h.01M10.2 6.1h.01" strokeLinecap="round" />}
    </svg>
  );
}

function TerminalActionIcon({ kind }: { kind: "folder" | "play" | "capture" }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {kind === "folder" && (
        <path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6A1.5 1.5 0 0 1 17.5 8v7a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15z" />
      )}
      {kind === "play" && <path d="M6.5 4.5v11l9-5.5z" strokeLinejoin="round" />}
      {kind === "capture" && (
        <>
          <rect x="2.5" y="6" width="15" height="10.5" rx="2" />
          <path d="M7 6l1.2-2h3.6L13 6" />
          <circle cx="10" cy="11" r="2.6" />
        </>
      )}
    </svg>
  );
}

/** A committed text row (the copy-field rule: draft while typing, commit on blur or Enter, Escape restores). */
export function TerminalTextRow({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <div className="popover-row">
      <span className="popover-inline slider-row-label">{label}</span>
      <input
        className="modal-input"
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          editing.current = true;
          setDraft(event.target.value);
        }}
        onBlur={() => {
          editing.current = false;
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            editing.current = false;
            onCommit(draft);
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            editing.current = false;
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
