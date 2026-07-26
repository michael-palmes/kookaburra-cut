import { useMemo, useState } from "react";
import {
  type ConflictState,
  formatDate,
  type ImportPlan,
  type ItemKind,
  type ItemPlan,
  KIND_LABELS,
  type Resolution,
} from "../types";

const STATE_LABEL: Record<ConflictState, string> = {
  new: "new",
  identical: "identical to yours",
  "theirs-newer": "theirs is newer",
  "yours-newer": "yours is newer",
  "unknown-age": "different, age unknown",
};

const RESOLUTION_LABEL: Record<Resolution, string> = {
  skip: "Keep mine",
  replace: "Replace",
  "keep-both": "Keep both",
};

/** Two files cannot both own a (family, weight) key in fonts.json. */
function options(kind: ItemKind): Resolution[] {
  return kind === "font" ? ["skip", "replace"] : ["skip", "replace", "keep-both"];
}

function consequence(item: ItemPlan, resolution: Resolution): string | null {
  if (resolution !== "replace") return null;
  if (item.kind === "font") return "Replacing changes how your existing projects render.";
  return `Your ${KIND_LABELS[item.kind].one.toLowerCase()} is moved to a backup first.`;
}

/** Screen 3. Smart defaults, per-item override, per-category apply-to-all. Nothing hidden. */
export function ConflictsView({
  plan,
  onBack,
  onApply,
}: {
  plan: ImportPlan;
  onBack: () => void;
  onApply: (resolutions: Record<string, Resolution>) => void;
}) {
  const conflicts = useMemo(() => plan.items.filter((i) => i.state !== "new"), [plan]);
  const fresh = plan.items.length - conflicts.length;
  const [overrides, setOverrides] = useState<Record<string, Resolution>>({});

  const resolutionFor = (item: ItemPlan): Resolution =>
    overrides[`${item.kind}:${item.slug}`] ?? item.resolution;

  const applyToAll = (kind: ItemKind | "all", resolution: Resolution) => {
    const next = { ...overrides };
    for (const item of conflicts) {
      if (kind !== "all" && item.kind !== kind) continue;
      if (!options(item.kind).includes(resolution)) continue;
      next[`${item.kind}:${item.slug}`] = resolution;
    }
    setOverrides(next);
  };

  const submit = () => {
    const resolutions: Record<string, Resolution> = {};
    for (const item of plan.items) {
      resolutions[`${item.kind}:${item.slug}`] = resolutionFor(item);
    }
    onApply(resolutions);
  };

  const willImport = plan.items.filter((i) => resolutionFor(i) !== "skip").length;
  const grouped = new Map<ItemKind, ItemPlan[]>();
  for (const item of conflicts) {
    grouped.set(item.kind, [...(grouped.get(item.kind) ?? []), item]);
  }

  return (
    <div className="packs-main">
      <div className="packs-scroll">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 8,
          }}
        >
          <div className="packs-heading" style={{ margin: 0 }}>
            {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
          </div>
          <select
            className="packs-select"
            value=""
            onChange={(e) => {
              if (e.target.value) applyToAll("all", e.target.value as Resolution);
              e.target.value = "";
            }}
          >
            <option value="">Apply to all…</option>
            <option value="skip">Keep mine</option>
            <option value="replace">Replace</option>
            <option value="keep-both">Keep both</option>
          </select>
        </div>

        {[...grouped.entries()].map(([kind, items]) => (
          <div key={kind}>
            <div className="packs-heading">{KIND_LABELS[kind].many}</div>
            {items.map((item) => {
              const resolution = resolutionFor(item);
              const note = consequence(item, resolution);
              return (
                <div
                  className={`packs-row${resolution === "replace" ? " packs-row-replace" : ""}`}
                  key={`${item.kind}:${item.slug}`}
                >
                  <span className="packs-row-main">
                    <span className="packs-row-title">{item.name}</span>
                    <span className="packs-row-detail">{STATE_LABEL[item.state]}</span>
                    {item.local && (
                      <span className="packs-row-detail">
                        yours: {formatDate(item.local.modifiedAt)}
                      </span>
                    )}
                    {note && <span className="packs-row-detail">{note}</span>}
                    {resolution === "keep-both" && item.keepBothSlug && (
                      <span className="packs-row-detail">imports as {item.keepBothSlug}</span>
                    )}
                  </span>
                  <select
                    className="packs-select"
                    value={resolution}
                    onChange={(e) =>
                      setOverrides({
                        ...overrides,
                        [`${item.kind}:${item.slug}`]: e.target.value as Resolution,
                      })
                    }
                  >
                    {options(item.kind).map((o) => (
                      <option key={o} value={o}>
                        {RESOLUTION_LABEL[o]}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        ))}

        <div className="packs-note">
          {fresh} new item{fresh === 1 ? "" : "s"} import with no conflict.
        </div>
      </div>

      <div className="packs-footer">
        <div className="packs-footer-summary">
          {willImport} of {plan.items.length} items will be written
        </div>
        <div className="packs-actions">
          <button type="button" onClick={onBack}>
            Back
          </button>
          <button type="button" onClick={submit}>
            Import {willImport} item{willImport === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
