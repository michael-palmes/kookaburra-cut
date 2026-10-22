import { type ReactNode, useState } from "react";
import type { BrandSummary } from "../../engine/brands";
import { BrandIcon, NoBrandIcon } from "../brandIcons";
import { DrillBack } from "./rows";

/** Colours shown on a brand card; the rest live in the colour picker's Brand section. */
const SWATCH_LIMIT = 10;

export const NO_BRANDS_HINT =
  "Add a brand with Claude: ask it to build a brand pack from your brand folder.";

function BrandChoice({
  icon,
  label,
  description,
  colours,
  active,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  colours?: BrandSummary["colors"];
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`brand-choice${active ? " active" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="brand-choice-icon">{icon}</span>
      <span className="brand-choice-text">
        <span className="brand-choice-label">{label}</span>
        {description && <span className="brand-choice-desc">{description}</span>}
        {colours && colours.length > 0 && (
          <span className="brand-choice-swatches" aria-hidden="true">
            {colours.slice(0, SWATCH_LIMIT).map((colour) => (
              <span
                key={`${colour.name}-${colour.hex}`}
                className="brand-choice-swatch"
                style={{ background: colour.hex }}
                title={colour.name}
              />
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

/** Project ▸ Brand: pick a workspace brand (or None). Applying sets the brand's default theme and fonts and copies its guidelines to BRAND.md; clearing leaves the theme and fonts as they are. */
export function BrandDrill({
  brands,
  value,
  onBack,
  onApply,
}: {
  /** null while the workspace is read. */
  brands: BrandSummary[] | null;
  /** The project's `brand` id, if any. */
  value: string | undefined;
  onBack: () => void;
  onApply: (brandId: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const missing = value && brands && !brands.some((b) => b.id === value);
  const apply = (brandId: string | null) => {
    // Picking the applied brand again re-applies it (fresh guidelines, its theme and fonts back).
    if (busy || (brandId === null && !value)) return;
    setBusy(true);
    void onApply(brandId).finally(() => setBusy(false));
  };
  return (
    <div className="inspector-drill">
      <DrillBack label="Project" title="Brand" onClick={onBack} />
      <div className="inspector-drill-body">
        <p className="modal-hint">
          A brand gives safe defaults and guidance, not hard rules. Picking one applies its theme
          and fonts; its guidelines land in BRAND.md, its images in the Library and its colours in
          the colour picker.
        </p>
        {missing && (
          <p className="modal-warn">
            This project's brand ({value}) is no longer in your workspace.
          </p>
        )}
        {brands === null ? (
          <p className="muted">Reading brands…</p>
        ) : (
          <fieldset className="brand-choices" aria-label="Brand">
            <BrandChoice
              icon={<NoBrandIcon size={17} />}
              label="None"
              description="No brand guidance; the theme and fonts stay as they are."
              active={!value}
              disabled={busy}
              onClick={() => apply(null)}
            />
            {brands.map((brand) => (
              <BrandChoice
                key={brand.id}
                icon={<BrandIcon size={17} />}
                label={brand.name}
                description={brand.description}
                colours={brand.colors}
                active={brand.id === value}
                disabled={busy}
                onClick={() => apply(brand.id)}
              />
            ))}
          </fieldset>
        )}
        {brands?.length === 0 && <p className="modal-hint">{NO_BRANDS_HINT}</p>}
      </div>
    </div>
  );
}
