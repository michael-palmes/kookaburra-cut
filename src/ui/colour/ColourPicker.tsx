import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTheme } from "../../theme";
import { ContextMenu, type ContextMenuState } from "../ContextMenu";
import { useEscapeClose } from "../useEscapeClose";
import { COLOUR_PRESET_GRID } from "./colourPresets";
import { loadColourRecents, rememberColourPick } from "./colourRecents";
import { colourSwatchMenu } from "./colourSwatchMenu";
import { hexToRgbString, normaliseHex } from "./colourUtils";

/** The app-wide colour selector: a swatch trigger opening an anchored macOS-style popover (theme tokens, recents, preset grid, hex field, the native NSColorPanel via "Show Colors…", live preview). Discrete picks commit immediately; native-panel drags debounce ~250ms because macOS keeps focus on the hidden input while the panel is open, so blur-only commits looked stale. Right-clicking any square offers copy options. */

export interface ColourPickerProps {
  /** Current colour, sRGB hex. */
  value: string;
  /** A settled pick: immediate for discrete picks, debounced during native-panel drags. */
  onCommit: (hex: string) => void;
  /** Accessible name for the trigger swatch and the popover. */
  label: string;
  /** Shown on the Reset affordances so the target of a reset is visible. */
  defaultValue?: string;
  /** Present ⇒ Reset affordances appear; the caller removes its own override. */
  onReset?: () => void;
  size?: "sm" | "md";
  disabled?: boolean;
}

export function ColourPicker({
  value,
  onCommit,
  label,
  defaultValue,
  onReset,
  size = "sm",
  disabled = false,
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
  onClose,
}: {
  value: string;
  onCommit: (hex: string) => void;
  label: string;
  defaultValue?: string;
  onReset?: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const theme = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [draft, setDraft] = useState(() => normaliseHex(value) ?? value.toLowerCase());
  const [hexText, setHexText] = useState(draft);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [recents] = useState(loadColourRecents);

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

  // Anchor below the trigger, flip above on overflow, clamp to the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8));
    let top = a.bottom + 6;
    if (top + r.height > window.innerHeight - 8) top = a.top - r.height - 6;
    setPos({ left, top: Math.max(8, top) });
  }, [anchorRef]);

  // Outside pointerdown closes; the trigger is excluded or its toggle would reopen us.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchorRef, onClose]);

  // Every close path unmounts us: flush a pending debounce and record the final pick.
  useEffect(
    () => () => {
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
    },
    [],
  );

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

  const onNativeChange = (hex: string) => {
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
      <div className="colour-popover-section">
        <span className="popover-group-label">Theme</span>
        <div className="colour-popover-row">
          {THEME_TOKEN_LABELS.map(([token, name]) =>
            chip(theme.colors[token], `${name} ${theme.colors[token]}`, `theme-${token}`),
          )}
        </div>
      </div>
      {recents.length > 0 && (
        <div className="colour-popover-section">
          <span className="popover-group-label">Recent</span>
          <div className="colour-popover-row">
            {recents.map((hex) => chip(hex, hex, `r-${hex}`))}
          </div>
        </div>
      )}
      <div className="colour-popover-grid">
        {COLOUR_PRESET_GRID.map((hex) => chip(hex, hex, hex))}
      </div>
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
          onChange={(e) => onNativeChange(e.target.value)}
        />
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
