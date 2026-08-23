import { type ReactElement, useState } from "react";
import { PRESET_CATEGORIES } from "../engine/presets";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_LEVELS,
  TEMPLATE_STATUSES,
  TEMPLATE_TIERS,
  type TemplateLevel,
  type TemplateStatus,
  type TemplateTier,
} from "../engine/templates";
import {
  type ItemDetailsDraft,
  type ItemDetailsTarget,
  itemDetailsDraft,
  writeItemDetails,
} from "./libraryDetails";
import { PRESET_CATEGORY_ICONS, TEMPLATE_CATEGORY_ICONS } from "./libraryIcons";
import { useEscapeClose } from "./useEscapeClose";

/** The one details editor behind every library item: a freshly converted template arrives here to be named and filed, and "Edit details…" reopens it later. Fields the modal does not show survive the write untouched (`libraryDetails.ts` owns the patch), and bundled items in a dev checkout additionally expose the authoring facets, which the user's own items simply default. */

interface CategoryChoice {
  id: string;
  label: string;
  icon: ReactElement | undefined;
}

function categoryChoices(kind: ItemDetailsTarget["kind"]): CategoryChoice[] {
  const source = kind === "template" ? TEMPLATE_CATEGORIES : PRESET_CATEGORIES;
  const icons = kind === "template" ? TEMPLATE_CATEGORY_ICONS : PRESET_CATEGORY_ICONS;
  return source.map((category) => ({
    id: category.id,
    label: category.label,
    icon: icons[category.id],
  }));
}

/** Tags as chips: Enter or a comma commits the typed term, Backspace on an empty field takes the last one back. */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (!tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) onChange([...tags, value]);
    setDraft("");
  };
  return (
    <div className="item-details-tags">
      {tags.map((tag) => (
        <span key={tag} className="template-chip">
          {tag}
          <button
            type="button"
            className="item-details-tag-remove"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="modal-input item-details-tag-input"
        type="text"
        placeholder={tags.length === 0 ? "Add a tag" : "Add another"}
        aria-label="Add a tag"
        value={draft}
        onChange={(e) => {
          const value = e.target.value;
          if (value.endsWith(",")) commit(value.slice(0, -1));
          else setDraft(value);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

export function ItemDetailsModal({
  target,
  title,
  hint,
  submitLabel,
  onSaved,
  onCancel,
}: {
  target: ItemDetailsTarget;
  title: string;
  hint?: string;
  submitLabel: string;
  /** The manifest landed; the host refreshes the catalogue it came from. */
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ItemDetailsDraft>(() => itemDetailsDraft(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = categoryChoices(target.kind);
  // Escape leaves a freshly converted item exactly as it was written, so it is never destructive.
  useEscapeClose(onCancel, !busy);
  const set = <K extends keyof ItemDetailsDraft>(key: K, value: ItemDetailsDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  // Level and tier are template authoring facets; the checkout is the only place they are editable.
  const showFacets = target.source === "bundled";

  const submit = () => {
    if (busy || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    writeItemDetails(target, draft)
      .then(() => onSaved())
      .catch((e) => {
        setError(String(e));
        setBusy(false);
      });
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal item-details">
        <h2>{title}</h2>
        {hint && <p className="modal-hint">{hint}</p>}
        <div className="wizard-field">
          <span className="wizard-label">Name</span>
          <input
            className="modal-input"
            type="text"
            value={draft.name}
            // biome-ignore lint/a11y/noAutofocus: naming is the one thing this modal always needs typed
            autoFocus
            onChange={(e) => set("name", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="wizard-field">
          <span className="wizard-label">Tagline</span>
          <input
            className="modal-input"
            type="text"
            placeholder="One line under the title"
            value={draft.tagline}
            onChange={(e) => set("tagline", e.target.value)}
          />
        </div>
        <div className="wizard-field">
          <span className="wizard-label">Category</span>
          <fieldset className="group-chips item-details-categories" aria-label="Category">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={`group-chip${draft.category === category.id ? " selected" : ""}`}
                aria-pressed={draft.category === category.id}
                onClick={() => set("category", draft.category === category.id ? null : category.id)}
              >
                {category.icon}
                {category.label}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="wizard-field">
          <span className="wizard-label">Tags</span>
          <TagInput tags={draft.tags} onChange={(tags) => set("tags", tags)} />
        </div>
        {showFacets && (
          <div className="item-details-facets">
            {target.kind === "template" && (
              <>
                <label className="wizard-field">
                  <span className="wizard-label">Level</span>
                  <select
                    className="select"
                    value={draft.level}
                    onChange={(e) => set("level", e.target.value as TemplateLevel)}
                  >
                    {TEMPLATE_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wizard-field">
                  <span className="wizard-label">Tier</span>
                  <select
                    className="select"
                    value={draft.tier}
                    onChange={(e) => set("tier", e.target.value as TemplateTier)}
                  >
                    {TEMPLATE_TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        {tier}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="wizard-field">
              <span className="wizard-label">Status</span>
              <select
                className="select"
                value={draft.status}
                onChange={(e) => set("status", e.target.value as TemplateStatus)}
              >
                {TEMPLATE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy || !draft.name.trim()}
          >
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
