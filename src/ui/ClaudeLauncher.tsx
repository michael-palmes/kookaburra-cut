import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  CLAUDE_APP_MISSING,
  type ClaudeStarter,
  claudeAppInstalled,
  claudeStarterPrompt,
  openClaudeDownload,
  openInClaude,
  openProjectFolder,
  openSettingsWindow,
} from "../engine/claudeApp";
import { useEscapeClose } from "./useEscapeClose";

/** Edit with Claude (docs/design.md §4.7): the titlebar button and its launcher popover, which hands the project to the Claude desktop app. The Claude guest palette lives only here and in the legacy rail's switch-back button. */

/** Stand-in Claude mark until the official asset is supplied. */
export function ClaudeSpark({
  size = 15,
  strokeWidth = 2.4,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 12H22M12 12L18.06 15.5M12 12L16.5 19.79M12 12V19.5M12 12L7 20.66M12 12L6.37 15.25M12 12H2.5M12 12L5.94 8.5M12 12L7 3.34M12 12V4.5M12 12L16.5 4.21M12 12L17.63 8.75" />
    </svg>
  );
}

function Glyph({ size = 15, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const FOLDER_PATH =
  "M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5z";

export function TerminalGlyph({ size = 15 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M6 8l2.5 2L6 12M10.5 12.5H14" />
    </Glyph>
  );
}

export function CloseGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

/** The titlebar entry beside the project name; in legacy mode it toggles the terminal rail instead. `children` is the launcher, anchored under the button. */
export function EditWithClaudeButton({
  open,
  legacy,
  onToggle,
  buttonRef,
  children,
}: {
  open: boolean;
  legacy: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  children?: ReactNode;
}) {
  return (
    <span className="titlebar-claude-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={`titlebar-claude${open ? " open" : ""}`}
        title="Edit with Claude (⌥⌘E)"
        aria-haspopup={legacy ? undefined : "dialog"}
        aria-expanded={legacy ? undefined : open}
        aria-pressed={legacy ? open : undefined}
        onClick={onToggle}
      >
        <span className="titlebar-claude-mark">{legacy ? <TerminalGlyph /> : <ClaudeSpark />}</span>
        Edit with Claude
        {!legacy && (
          <Glyph size={11}>
            <path d="M5 8l5 5 5-5" />
          </Glyph>
        )}
      </button>
      {children}
    </span>
  );
}

/** What starting a session means for a confidential project, in one line (docs/agent-kit.md, "Stamping"). */
const CLAUDE_DISCLOSURE =
  "Sends this project’s files to Anthropic as you work. Scene edits and kb commands run without asking; other commands ask.";

const STARTERS: { kind: ClaudeStarter; label: string; icon: ReactNode }[] = [
  { kind: "scene", label: "Scene", icon: <path d="M10 4v12M4 10h12" /> },
  {
    kind: "look",
    label: "Look",
    icon: (
      <path d="M10 3.5a6.5 6.5 0 100 13c1 0 1.5-.6 1.5-1.4 0-.9-.7-1.2-.7-2 0-.9.7-1.4 1.6-1.4h1.8a2.8 2.8 0 002.8-2.8C17 5.9 13.9 3.5 10 3.5z" />
    ),
  },
  {
    kind: "pacing",
    label: "Pacing",
    icon: (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="M10 6.5V10l2.5 1.6" />
      </>
    ),
  },
  {
    kind: "media",
    label: "Media",
    icon: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <path d="M3 13l4-3.5 3 2.5 2.5-2 4.5 3.5" />
      </>
    ),
  },
];

/** The launcher popover under the titlebar button. `firstRun` is the larger greeting a project's first open shows. */
export function ClaudeLauncher({
  anchorRef,
  slug,
  sceneName,
  firstRun,
  onClose,
  onUseTerminal,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  /** Native project slug the session opens in. */
  slug: string;
  /** The scene at the playhead, for the Scene starter. */
  sceneName: string | null;
  firstRun: boolean;
  onClose: () => void;
  /** Switch to the legacy built-in terminal. */
  onUseTerminal: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEscapeClose(menuOpen ? () => setMenuOpen(false) : onClose);

  useEffect(() => {
    let cancelled = false;
    claudeAppInstalled()
      .then((v) => {
        if (!cancelled) setInstalled(v);
      })
      .catch(() => {
        if (!cancelled) setInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A click anywhere else dismisses it; the anchor is excluded so the button's own toggle wins.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [anchorRef, onClose]);

  const launch = async (prompt?: string) => {
    setBusy(true);
    setError(null);
    try {
      await openInClaude(slug, prompt);
      onClose();
    } catch (e) {
      if (String(e) === CLAUDE_APP_MISSING) setInstalled(false);
      else setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reportError = (e: unknown) => setError(String(e));

  return (
    <div
      ref={panelRef}
      className={`claude-launcher${firstRun ? " first-run" : ""}`}
      role="dialog"
      aria-label="Edit with Claude"
    >
      <button
        type="button"
        className="claude-launcher-close"
        aria-label="Close"
        title="Close (Esc)"
        onClick={onClose}
      >
        <CloseGlyph />
      </button>

      {firstRun && installed !== false ? (
        <>
          <div className="claude-launcher-hero">
            <ClaudeSpark size={72} strokeWidth={2.1} />
          </div>
          <div className="claude-launcher-title">
            <h2>Edit with Claude</h2>
            <p>Ask there. See it here.</p>
            <p className="claude-launcher-disclosure">{CLAUDE_DISCLOSURE}</p>
          </div>
        </>
      ) : (
        <div className="claude-launcher-head">
          <ClaudeSpark size={34} strokeWidth={2.3} />
          <div>
            <h2>Edit with Claude</h2>
            <p>{installed === false ? "Get the Claude app to start" : "Ask there, see it here"}</p>
            {installed !== false && (
              <p className="claude-launcher-disclosure">{CLAUDE_DISCLOSURE}</p>
            )}
          </div>
        </div>
      )}

      {installed === false ? (
        <>
          <ol className="claude-launcher-steps" aria-label="How to start">
            <li>
              <span className="claude-launcher-step-icon">
                <Glyph size={22}>
                  <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M4 14.5v1a1 1 0 001 1h10a1 1 0 001-1v-1" />
                </Glyph>
              </span>
              Get Claude
            </li>
            <li>
              <span className="claude-launcher-step-icon">
                <Glyph size={22}>
                  <path d={FOLDER_PATH} />
                </Glyph>
              </span>
              Code › this folder
            </li>
            <li>
              <span className="claude-launcher-step-icon">
                <Glyph size={22}>
                  <path d="M4 4.5h12a1 1 0 011 1v7a1 1 0 01-1 1H9l-4 3v-3H4a1 1 0 01-1-1v-7a1 1 0 011-1z" />
                </Glyph>
              </span>
              Ask away
            </li>
          </ol>
          <div className="claude-launcher-cta">
            <button
              type="button"
              className="claude-cta"
              // biome-ignore lint/a11y/noAutofocus: as Open in Claude below
              autoFocus={!firstRun}
              onClick={() => void openClaudeDownload().catch(reportError)}
            >
              <Glyph size={16}>
                <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M4 14.5v1a1 1 0 001 1h10a1 1 0 001-1v-1" />
              </Glyph>
              Get the Claude app
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="claude-launcher-cta">
            <button
              type="button"
              className="claude-cta"
              // biome-ignore lint/a11y/noAutofocus: an opened popover's one primary action takes focus; the automatic first-open greeting leaves Space to the transport
              autoFocus={!firstRun}
              disabled={busy}
              onClick={() => void launch()}
            >
              <ClaudeSpark size={17} strokeWidth={2.6} />
              {busy ? "Opening…" : "Open in Claude"}
            </button>
          </div>
          <div className="claude-launcher-starters">
            <span className="claude-launcher-label">Or start with</span>
            <div className="claude-launcher-starter-grid">
              {STARTERS.map((s) => (
                <button
                  type="button"
                  key={s.kind}
                  className="claude-starter"
                  title="Opens Claude with a starter prompt typed in"
                  disabled={busy}
                  onClick={() => void launch(claudeStarterPrompt(s.kind, sceneName))}
                >
                  <span className="claude-starter-icon">
                    <Glyph size={17}>{s.icon}</Glyph>
                  </span>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {error && (
        <p className="claude-launcher-error" role="alert">
          {error}
        </p>
      )}

      <div className="claude-launcher-foot">
        <button
          type="button"
          className="claude-ghost"
          onClick={() => void openProjectFolder(slug).catch(reportError)}
        >
          <Glyph size={14}>
            <path d={FOLDER_PATH} />
          </Glyph>
          Open in Finder
        </button>
        <div className="claude-launcher-more">
          <button
            type="button"
            className={`claude-icon-btn${menuOpen ? " open" : ""}`}
            aria-label="More options"
            title="More options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <circle cx="4.5" cy="10" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="15.5" cy="10" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div className="claude-launcher-menu" role="menu">
              <button type="button" role="menuitem" onClick={onUseTerminal}>
                <TerminalGlyph />
                <span>Built-in terminal</span>
                <span className="claude-launcher-menu-hint">Legacy</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void openSettingsWindow().catch(reportError);
                }}
              >
                <Glyph>
                  <circle cx="10" cy="10" r="2.5" />
                  <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
                </Glyph>
                Claude settings…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
