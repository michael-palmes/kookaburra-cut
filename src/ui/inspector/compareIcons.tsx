import type { ReactNode } from "react";
import type { ComparePreset } from "../../engine/comparePresets";
import type { CompareMaskType } from "../../engine/sceneCompare";

/** Comparison-drill glyphs (docs/design.md section 10): hand-authored line icons on a 16px grid, 1.5px stroke, `currentColor`, `aria-hidden`, drawn from what each choice DOES (a split rect, a window, a sweep, a ghosted overlap) so the mask row, the motion chips and the chrome toggles wear one face. The maps are pinned complete against the mask catalogue and the preset catalogue in tests; the engine keeps owning the data, this file only paints it. */

/** Motion-preset ids plus the manual choice, which has no catalogue entry (it clears the keys rather than writing them). */
export type ComparePresetIconId = ComparePreset["id"] | "manual";

/** Divider-chrome toggles: the line itself, its grip, and the before/after label chips. */
export type CompareToggleIconId = "line" | "grip" | "chips";

export const COMPARE_MASK_GLYPHS: Record<CompareMaskType, ReactNode> = {
  linear: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M8 3.5v9" />
    </>
  ),
  circle: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <circle cx="8" cy="8" r="2.6" />
    </>
  ),
  radial: (
    <>
      <circle cx="8" cy="8" r="5.3" />
      <path d="M8 8V2.7A5.3 5.3 0 0 1 12.6 5.4Z" fill="currentColor" fillOpacity="0.28" />
    </>
  ),
  blend: (
    <>
      <rect x="2.25" y="2.75" width="8.5" height="8.5" rx="1.5" />
      <rect
        x="5.25"
        y="4.75"
        width="8.5"
        height="8.5"
        rx="1.5"
        fill="currentColor"
        fillOpacity="0.18"
      />
    </>
  ),
};

export const COMPARE_PRESET_GLYPHS: Record<ComparePresetIconId, ReactNode> = {
  manual: (
    <>
      <path d="M2.5 8h3.2M10.3 8h3.2" />
      <circle cx="8" cy="8" r="2.3" />
    </>
  ),
  reveal: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M6.2 3.5v9" />
      <path d="M8.1 8h3.3M9.9 6.4 11.5 8l-1.6 1.6" />
    </>
  ),
  "sweep-settle": (
    <>
      <path d="M8 2.6v10.8" />
      <path d="M4.2 6.2 6.1 8l-1.9 1.8" />
      <path d="M11.8 6.2 9.9 8l1.9 1.8" />
    </>
  ),
  peek: (
    <>
      <path d="M3.2 6h8.2M9.6 4.2 11.4 6 9.6 7.8" />
      <path d="M12.8 10.6H4.6M6.4 8.8 4.6 10.6l1.8 1.8" />
    </>
  ),
  hold: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <rect
        x="8"
        y="4.25"
        width="5.25"
        height="7.5"
        fill="currentColor"
        fillOpacity="0.28"
        stroke="none"
      />
      <path d="M8 3.5v9" />
    </>
  ),
};

export const COMPARE_TOGGLE_GLYPHS: Record<CompareToggleIconId, ReactNode> = {
  line: (
    <>
      <path d="M8 2.6v10.8" />
      <path d="M3.2 6h2.6M3.2 10h2.6M10.2 6h2.6M10.2 10h2.6" opacity="0.45" />
    </>
  ),
  grip: (
    <>
      <path d="M8 2.6v10.8" />
      <circle cx="8" cy="8" r="1.9" fill="currentColor" />
      <path d="M3.2 6h2.6M3.2 10h2.6M10.2 6h2.6M10.2 10h2.6" opacity="0.45" />
    </>
  ),
  chips: (
    <>
      <rect x="2" y="3.4" width="7" height="4" rx="2" />
      <rect x="7" y="8.6" width="7" height="4" rx="2" />
    </>
  ),
};

function CompareGlyph({ glyph, size }: { glyph: ReactNode; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

export function CompareMaskIcon({ id, size = 16 }: { id: CompareMaskType; size?: number }) {
  return <CompareGlyph glyph={COMPARE_MASK_GLYPHS[id]} size={size} />;
}

export function ComparePresetIcon({ id, size = 16 }: { id: ComparePresetIconId; size?: number }) {
  return <CompareGlyph glyph={COMPARE_PRESET_GLYPHS[id]} size={size} />;
}

export function CompareToggleIcon({ id, size = 16 }: { id: CompareToggleIconId; size?: number }) {
  return <CompareGlyph glyph={COMPARE_TOGGLE_GLYPHS[id]} size={size} />;
}
