import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useMemo, useState } from "react";
import { slugifyName } from "../engine/workspace";
import { GRADIENT_PRESETS, type GradientPreset, gradientCss } from "../theme/gradientPresets";
import { parseGradient } from "../theme/schema";
import type { GradientSpec, Theme, ThemeBackground } from "../theme/tokens";
import { ColourPicker } from "./colour/ColourPicker";
import { useEscapeClose } from "./useEscapeClose";

/** The background gradient picker: a preview grid of the 24 bundled presets (+ the scene theme's own gradient when it has one, + workspace-saved customs from `~/Kookaburra Cut/gradients/`), and a Custom builder for start/end colour, linear + angle or radial, all interpolated perceptually (OKLCH; `theme/oklch.ts`). Applying writes the self-contained spec inline into the sidecar's `background` (theme-independent, a preset survives theme swaps); the theme card writes the v8 name reference. Save-as-preset lands in the workspace via `write_gradient`. */

type GradientValue = Extract<ThemeBackground, { type: "gradient" }>;

interface UserGradient {
  slug: string;
  name: string;
  spec: GradientSpec;
}

async function listUserGradients(): Promise<UserGradient[]> {
  try {
    const listings = await invoke<{ slug: string; json: string }[]>("list_gradients");
    const out: UserGradient[] = [];
    for (const { slug, json } of listings) {
      try {
        const doc = JSON.parse(json) as { name?: unknown; spec?: unknown };
        const spec = parseGradient(doc.spec);
        if (spec) out.push({ slug, name: typeof doc.name === "string" ? doc.name : slug, spec });
        else console.warn(`[gradients] preset "${slug}" has an invalid spec — skipped`);
      } catch (e) {
        console.warn(`[gradients] preset "${slug}" unreadable:`, e);
      }
    }
    return out;
  } catch {
    return []; // no workspace yet, bundled presets only
  }
}

function specKey(spec: GradientSpec): string {
  return JSON.stringify([spec.type, spec.angleDeg, spec.space ?? "srgb", spec.stops]);
}

function Card({
  name,
  spec,
  selected,
  onPick,
}: {
  name: string;
  spec: GradientSpec;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`gradient-card${selected ? " selected" : ""}`}
      onClick={onPick}
    >
      <span className="gradient-card-swatch" style={{ background: gradientCss(spec) }} />
      <span className="gradient-card-name">{name}</span>
    </button>
  );
}

export function GradientPickerModal({
  current,
  theme,
  onCancel,
  onApply,
  embedded = false,
}: {
  /** The scene's current background override (selection highlight). */
  current: ThemeBackground | undefined;
  /** The scene's resolved theme: its own gradient leads the grid when present. */
  theme: Theme | undefined;
  onCancel: () => void;
  onApply: (value: GradientValue) => void;
  /** Render without the modal chrome: the inspector drill-in hosts the same body (decision 8). */
  embedded?: boolean;
}) {
  const titleId = useId();
  const [view, setView] = useState<"grid" | "custom">("grid");
  const [userGradients, setUserGradients] = useState<UserGradient[]>([]);
  useEscapeClose(onCancel);
  useEffect(() => {
    void listUserGradients().then(setUserGradients);
  }, []);
  // Two-step saved-preset delete, for parity with export presets.
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmDeleteSlug) return;
    const timer = window.setTimeout(() => setConfirmDeleteSlug(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteSlug]);
  const deleteGradient = async (slug: string) => {
    try {
      await invoke("delete_gradient", { slug });
      setUserGradients(await listUserGradients());
    } catch (e) {
      console.warn("[gradients] delete failed:", e);
      setDeleteError(`Couldn't delete the preset: ${String(e)}`);
    }
  };

  // Custom builder state, seeded from the current inline spec when there is one.
  const seed = current?.type === "gradient" ? current.spec : undefined;
  const [startHex, setStartHex] = useState(seed?.stops[0]?.[0] ?? "#DCE9F5");
  const [endHex, setEndHex] = useState(seed?.stops[seed.stops.length - 1]?.[0] ?? "#F1DED4");
  const [shape, setShape] = useState<"linear" | "radial">(seed?.type ?? "linear");
  const [angle, setAngle] = useState(seed?.type === "linear" ? seed.angleDeg : 180);
  const [presetName, setPresetName] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const customSpec = useMemo<GradientSpec>(
    () => ({
      type: shape,
      angleDeg: shape === "linear" ? angle : 0,
      space: "oklch",
      stops: [
        [startHex, 0],
        [endHex, 1],
      ],
    }),
    [shape, angle, startHex, endHex],
  );

  const currentKey =
    current?.type === "gradient" && current.spec ? specKey(current.spec) : undefined;
  const themeGradientName = theme?.gradients
    ? Object.keys(theme.gradients).includes("backdrop")
      ? "backdrop"
      : Object.keys(theme.gradients)[0]
    : undefined;
  const themeGradient = themeGradientName ? theme?.gradients?.[themeGradientName] : undefined;

  async function saveAsPreset() {
    const name = presetName.trim();
    const slug = slugifyName(name);
    if (!slug) {
      setError("Give the preset a name.");
      return;
    }
    setError(null);
    setSaveState("saving");
    try {
      await invoke("write_gradient", {
        slug,
        text: JSON.stringify({ version: 1, name, spec: customSpec }, null, 2),
      });
      setUserGradients(await listUserGradients());
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1500);
    } catch (e) {
      setSaveState("idle");
      setError(String(e));
    }
  }

  const content = (
    <>
      {view === "grid" && (
        <>
          <div className="gradient-grid">
            {themeGradient && (
              <Card
                name="Theme gradient"
                spec={themeGradient}
                selected={current?.type === "gradient" && !current.spec}
                onPick={() =>
                  themeGradientName && onApply({ type: "gradient", gradient: themeGradientName })
                }
              />
            )}
            {GRADIENT_PRESETS.map((p: GradientPreset) => (
              <Card
                key={p.name}
                name={p.name}
                spec={p.spec}
                selected={currentKey === specKey(p.spec)}
                onPick={() => onApply({ type: "gradient", spec: p.spec })}
              />
            ))}
            {userGradients.map((g) => (
              <div key={`ws-${g.slug}`} className="gradient-card-wrap">
                <Card
                  name={g.name}
                  spec={g.spec}
                  selected={currentKey === specKey(g.spec)}
                  onPick={() => onApply({ type: "gradient", spec: g.spec })}
                />
                <button
                  type="button"
                  className={`gradient-delete${confirmDeleteSlug === g.slug ? " danger" : ""}`}
                  aria-label={`Delete ${g.name}`}
                  title={
                    confirmDeleteSlug === g.slug ? "Click again to delete" : `Delete ${g.name}`
                  }
                  onClick={() => {
                    if (confirmDeleteSlug !== g.slug) {
                      setConfirmDeleteSlug(g.slug);
                      return;
                    }
                    setConfirmDeleteSlug(null);
                    void deleteGradient(g.slug);
                  }}
                >
                  {confirmDeleteSlug === g.slug ? "Really?" : "✕"}
                </button>
              </div>
            ))}
          </div>
          {deleteError && <p className="modal-error">{deleteError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setView("custom")}>
              Custom…
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {view === "custom" && (
        <>
          <div
            className="gradient-custom-preview"
            style={{ background: gradientCss(customSpec) }}
          />
          <div className="gradient-builder-row">
            <span className="popover-inline">
              Start
              <ColourPicker value={startHex} label="Start colour" onCommit={setStartHex} />
            </span>
            <span className="popover-inline">
              End
              <ColourPicker value={endHex} label="End colour" onCommit={setEndHex} />
            </span>
            <span className="wizard-presets">
              <button
                type="button"
                className={`chip${shape === "linear" ? " selected" : ""}`}
                onClick={() => setShape("linear")}
              >
                Linear
              </button>
              <button
                type="button"
                className={`chip${shape === "radial" ? " selected" : ""}`}
                onClick={() => setShape("radial")}
              >
                Radial
              </button>
            </span>
            {shape === "linear" && (
              <label className="popover-inline">
                Angle
                <input
                  type="number"
                  className="modal-input gradient-angle"
                  min={0}
                  max={360}
                  step={5}
                  value={angle}
                  onChange={(e) => setAngle(Number(e.target.value) || 0)}
                />
                °
              </label>
            )}
          </div>
          <div className="gradient-builder-row">
            <input
              className="modal-input"
              placeholder="Preset name (optional)"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={saveState === "saving" || !presetName.trim()}
              onClick={() => void saveAsPreset()}
            >
              {saveState === "saved" ? "Saved ✓" : "Save as preset"}
            </button>
          </div>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setView("grid")}>
              Back
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => onApply({ type: "gradient", spec: customSpec })}
            >
              Apply
            </button>
          </div>
        </>
      )}
    </>
  );

  if (embedded) return <div className="gradient-embedded">{content}</div>;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal wizard-wide gradient-modal-wide">
        <h2 id={titleId}>Background gradient</h2>
        {content}
      </div>
    </div>
  );
}
