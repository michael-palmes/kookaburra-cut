import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { BUNDLED_FONTS } from "../theme/fonts";
import type { FontRef } from "../theme/tokens";

/** The font picker (locked decision 12): bundled OFL faces first, then every installed system face (Core Text enumeration via `list_system_fonts`), searchable, with recents (localStorage) and free row previews since the DOM renders installed families natively via CSS `font-family`, no pinning needed to preview. Picking returns a `FontRef`; the actual byte-pinning happens on first project load (`ensureThemeFontsPinned`, copy-on-reference into ~/Kookaburra Cut/fonts/). */

interface FaceRow {
  family: string;
  style: string;
  weight: number;
  bundled: boolean;
  /** Variable-font face: pinning instances a static at the face's coordinates. */
  variable?: boolean;
}

const RECENTS_KEY = "kookaburra:font-recents";
const MAX_ROWS = 120;

function loadRecents(): FontRef[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as FontRef[]).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberPick(ref: FontRef): void {
  const rest = loadRecents().filter((r) => r.family !== ref.family || r.weight !== ref.weight);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([ref, ...rest].slice(0, 8)));
}

export function FontPicker({ value, onPick }: { value: FontRef; onPick: (ref: FontRef) => void }) {
  const [faces, setFaces] = useState<FaceRow[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const bundled: FaceRow[] = Object.entries(BUNDLED_FONTS).flatMap(([family, weights]) =>
      Object.keys(weights).map((w) => ({
        family,
        style: `Bundled · ${w}`,
        weight: Number(w),
        bundled: true,
      })),
    );
    setFaces(bundled);
    invoke<{ family: string; style: string; weight: number; italic: boolean; variable: boolean }[]>(
      "list_system_fonts",
    )
      .then((rows) => {
        // Upright faces only, italics aren't theme typography material (yet).
        const system = rows
          .filter((r) => !r.italic)
          .map((r) => ({
            family: r.family,
            style: r.style,
            weight: r.weight,
            bundled: false,
            variable: r.variable,
          }));
        setFaces([...bundled, ...system]);
      })
      .catch((e) => console.warn("[fonts] system enumeration failed:", e));
  }, []);

  const recents = loadRecents();
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = q ? faces.filter((f) => f.family.toLowerCase().includes(q)) : faces;
    return list.slice(0, MAX_ROWS);
  }, [faces, q]);

  const pick = (ref: FontRef) => {
    rememberPick(ref);
    onPick(ref);
  };

  return (
    <div className="font-picker">
      <input
        className="modal-input"
        type="text"
        placeholder="Search fonts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!q && recents.length > 0 && (
        <div className="font-picker-recents">
          {recents.map((r) => (
            <button
              type="button"
              key={`${r.family}:${r.weight}`}
              className="chip"
              onClick={() => pick(r)}
            >
              {r.family} · {r.weight}
            </button>
          ))}
        </div>
      )}
      <div className="font-picker-list">
        {shown.map((f) => {
          const selected = value.family === f.family && value.weight === f.weight;
          return (
            <button
              type="button"
              key={`${f.family}:${f.style}:${f.weight}`}
              className={`font-picker-row${selected ? " selected" : ""}`}
              title={f.variable ? "Variable — pinned as static instance" : undefined}
              onClick={() => pick({ family: f.family, weight: f.weight })}
            >
              <span
                className="font-picker-sample"
                style={{ fontFamily: `"${f.family}"`, fontWeight: f.weight }}
              >
                {f.family}
              </span>
              <span className="font-picker-style">
                {f.variable ? `${f.style} · Variable` : f.style}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && <p className="modal-hint">No fonts match “{query.trim()}”.</p>}
        {shown.length === MAX_ROWS && (
          <p className="modal-hint">Showing the first {MAX_ROWS} — type to narrow.</p>
        )}
      </div>
    </div>
  );
}
