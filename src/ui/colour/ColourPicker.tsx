import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTheme } from "../../theme";
import type { Theme } from "../../theme/tokens";
import { ContextMenu, type ContextMenuState } from "../ContextMenu";
import { useEscapeClose } from "../useEscapeClose";
import { ColourSpectrum } from "./ColourSpectrum";
import { POPOVER_MARGIN, placeColourPopover } from "./colourPopoverLayout";
import { COLOUR_PRESET_GRID } from "./colourPresets";
import { loadColourRecents, rememberColourPick } from "./colourRecents";
import { colourSwatchMenu } from "./colourSwatchMenu";
import { type Hsv, hexToHsv, hexToRgbString, hsvToHex, normaliseHex } from "./colourUtils";
import { projectPaletteColours } from "./projectPalette";
import { sampleScreenColour } from "./screenSampler";

/** The app-wide colour selector: a swatch trigger opening an anchored macOS-style popover (a saturation/brightness spectrum, hex field, a native eyedropper, the native NSColorPanel via "Show Colors…", theme tokens, the project's own colours, recents, a 96-swatch palette, live preview). Discrete picks commit immediately; spectrum and native-panel drags debounce ~250ms into one commit, so a gesture costs one undo entry and one recents entry. Right-clicking any square offers copy options. */

export interface ColourPickerProps {
  /** Current colour, sRGB hex. */
  value: string;
  /** A settled pick: immediate for discrete picks, debounced during spectrum and native-panel drags. */
  onCommit: (hex: string) => void;
  /** Accessible name for the trigger swatch and the popover. */
  label: string;
  /** Shown on the Reset affordances so the target of a reset is visible. */
  defaultValue?: string;
  /** Present ⇒ Reset affordances appear; the caller removes its own override. */
  onReset?: () => void;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Optional toggle state when the swatch participates in a labelled choice group. */
  pressed?: boolean;
  /** Scene-resolved theme for inspector pickers mounted outside SceneHost. */
  theme?: Theme;
}

export function ColourPicker({
  value,
  onCommit,
  label,
  defaultValue,
  onReset,
  size = "sm",
  disabled = false,
  pressed,
  theme,
}: ColourPickerProps) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`colour-swatch-trigger${size === "md" ? " size-md" : ""}`}
        style={{ background: value }}
        aria-label={label}
        aria-expanded={open}
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: colourSwatchMenu({ hex: normaliseHex(value) ?? value, onReset }),
          });
        }}
      />
      {open && (
        <ColourPopover
          value={value}
          onCommit={onCommit}
          label={label}
          defaultValue={defaultValue}
          onReset={onReset}
          anchorRef={triggerRef}
          themeOverride={theme}
          onClose={() => setOpen(false)}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

const THEME_TOKEN_LABELS = [
  ["background", "Background"],
  ["text", "Text"],
  ["accent", "Accent"],
  ["muted", "Muted"],
] as const;

function ColourPopover({
  value,
  onCommit,
  label,
  defaultValue,
  onReset,
  anchorRef,
  themeOverride,
  onClose,
}: {
  value: string;
  onCommit: (hex: string) => void;
  label: string;
  defaultValue?: string;
  onReset?: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  themeOverride?: Theme;
  onClose: () => void;
}) {
  const contextTheme = useTheme();
  const theme = themeOverride ?? contextTheme;
  const ref = useRef<HTMLDivElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState(() => ({
    left: 0,
    top: 0,
    maxHeight: window.innerHeight - 2 * POPOVER_MARGIN,
  }));
  const [draft, setDraft] = useState(() => normaliseHex(value) ?? value.toLowerCase());
  const [hexText, setHexText] = useState(draft);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [recents] = useState(loadColourRecents);
  const [projectColours] = useState(projectPaletteColours);
  const [hsv, setHsv] = useState(() => hexToHsv(draft));
  const [sampling, setSampling] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  // The hex the spectrum last produced: without it a drag into black or white would re-derive HSV and lose the hue.
  const hsvHex = useRef(draft);
  const samplingRef = useRef(false);
  const alive = useRef(true);

  // Refs so the unmount flush sees the latest state whatever path closed us.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const committed = useRef(draft);
  const openedWith = useRef(draft);
  const pending = useRef<number | null>(null);
  const skipFlush = useRef(false);

  useEscapeClose(onClose);

  // Anchor below the trigger, flip above when that side is roomier, cap the height to the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setPos(placeColourPopover(a, r, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchorRef]);

  // Reverse sync: a chip, a typed hex or the native panel moved the draft, so re-derive HSV.
  useEffect(() => {
    if (draft === hsvHex.current) return;
    hsvHex.current = draft;
    setHsv(hexToHsv(draft));
  }, [draft]);

  // Outside pointerdown closes; the trigger is excluded or its toggle would reopen us.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      // The click that dismisses NSColorSampler lands here while the app is not frontmost.
      if (samplingRef.current) return;
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchorRef, onClose]);

  // Every close path unmounts us: flush a pending debounce and record the final pick.
  // Setting the latch in the body, not just the cleanup, is what survives StrictMode's remount.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
        pending.current = null;
        if (!skipFlush.current && draftRef.current !== committed.current) {
          commitRef.current(draftRef.current);
        }
      }
      if (!skipFlush.current && draftRef.current !== openedWith.current) {
        rememberColourPick(draftRef.current);
      }
    };
  }, []);

  const commit = (hex: string) => {
    committed.current = hex;
    commitRef.current(hex);
  };

  const pick = (raw: string) => {
    const hex = normaliseHex(raw) ?? raw.toLowerCase();
    if (pending.current !== null) {
      window.clearTimeout(pending.current);
      pending.current = null;
    }
    setDraft(hex);
    setHexText(hex);
    if (hex !== committed.current) commit(hex);
    rememberColourPick(hex);
  };

  // The debounced path, shared by the spectrum and the native panel: one commit per gesture.
  const commitLater = (hex: string) => {
    setDraft(hex);
    setHexText(hex);
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      if (hex !== committed.current) commit(hex);
    }, 250);
  };

  const applyHexText = () => {
    const hex = normaliseHex(hexText);
    if (hex) pick(hex);
    else setHexText(draft);
  };

  const showNative = () => {
    const el = nativeRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.click();
    }
  };

  const sample = async () => {
    if (samplingRef.current) return;
    setSampling(true);
    setSampleError(null);
    samplingRef.current = true;
    try {
      const hex = await sampleScreenColour((message) => {
        if (alive.current) setSampleError(message);
      });
      if (hex && alive.current) pick(hex);
    } finally {
      samplingRef.current = false;
      if (alive.current) setSampling(false);
    }
  };

  const reset = () => {
    if (!onReset) return;
    if (pending.current !== null) {
      window.clearTimeout(pending.current);
      pending.current = null;
    }
    skipFlush.current = true;
    onReset();
    onClose();
  };

  const openChipMenu = (e: ReactMouseEvent, hex: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: colourSwatchMenu({ hex }) });
  };

  const onSpectrumChange = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    hsvHex.current = hex;
    commitLater(hex);
  };

  const chip = (rawHex: string, title: string, key: string) => {
    const hex = normaliseHex(rawHex) ?? rawHex.toLowerCase();
    return (
      <button
        key={key}
        type="button"
        className={`colour-swatch-chip${draft === hex ? " selected" : ""}`}
        style={{ background: hex }}
        title={title}
        aria-label={title}
        onClick={() => pick(hex)}
        onContextMenu={(e) => openChipMenu(e, hex)}
      />
    );
  };

  return (
    <div ref={ref} className="colour-popover" role="dialog" aria-label={label} style={pos}>
      <div className="colour-popover-scroll">
        <ColourSpectrum hsv={hsv} onChange={onSpectrumChange} />
        <div className="colour-popover-hex-row">
          <input
            className="modal-input colour-popover-hex-input"
            value={hexText}
            aria-label={`${label} hex value`}
            spellCheck={false}
            onChange={(e) => setHexText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyHexText();
            }}
            onBlur={applyHexText}
          />
          <button
            type="button"
            className="colour-popover-icon-btn"
            aria-label="Pick a colour from the screen"
            title="Pick a colour from the screen"
            aria-pressed={sampling}
            disabled={sampling}
            onClick={() => void sample()}
          >
            <EyedropperIcon />
          </button>
          <button type="button" className="btn btn-small" onClick={showNative}>
            Show Colors…
          </button>
          <input
            ref={nativeRef}
            type="color"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            value={draft}
            onChange={(e) => commitLater(e.target.value)}
          />
        </div>
        {sampleError && <p className="colour-popover-error">{sampleError}</p>}
        <div className="colour-popover-section">
          <span className="popover-group-label">Theme</span>
          <div className="colour-popover-row">
            {THEME_TOKEN_LABELS.map(([token, name]) =>
              chip(theme.colors[token], `${name} ${theme.colors[token]}`, `theme-${token}`),
            )}
          </div>
        </div>
        {projectColours.length > 0 && (
          <div className="colour-popover-section">
            <span className="popover-group-label">Used in this project</span>
            <div className="colour-popover-row">
              {projectColours.map((hex) => chip(hex, hex, `p-${hex}`))}
            </div>
          </div>
        )}
        {recents.length > 0 && (
          <div className="colour-popover-section">
            <span className="popover-group-label">Recent</span>
            <div className="colour-popover-row">
              {recents.map((hex) => chip(hex, hex, `r-${hex}`))}
            </div>
          </div>
        )}
        <div className="colour-popover-section">
          <span className="popover-group-label">Palette</span>
          <div className="colour-popover-grid">
            {COLOUR_PRESET_GRID.map((hex) => chip(hex, hex, hex))}
          </div>
        </div>
        {onReset && (
          <div className="colour-popover-hex-row">
            <button
              type="button"
              className="btn btn-small"
              title={defaultValue ? `Default ${defaultValue}` : undefined}
              onClick={reset}
            >
              Reset to default
            </button>
            {defaultValue && (
              <span
                className="colour-swatch-chip"
                style={{ background: defaultValue }}
                title={`Default ${defaultValue}`}
              />
            )}
          </div>
        )}
      </div>
      <div className="colour-popover-preview">
        <span className="colour-popover-preview-swatch" style={{ background: draft }} />
        <span className="colour-popover-preview-details">
          {draft.toUpperCase()} · {hexToRgbString(draft)}
        </span>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function EyedropperIcon() {
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
      <path d="M13.4 3.6a2.2 2.2 0 0 1 3.1 3.1l-1.7 1.7-3.1-3.1 1.7-1.7Z" />
      <path d="M11.7 5.3 5 12v3h3l6.7-6.7" />
    </svg>
  );
}
