import { useMemo, useState } from "react";
import { type PackSelection, selectionKey } from "../../engine/packs";
import { restrictedFontNotice } from "../../ui/packs/fontCopy";
import { formatBytes, ITEM_KINDS, type ItemKind, KIND_LABELS, type PackManifest } from "../types";

interface Entry {
  kind: ItemKind;
  slug: string;
  name: string;
  bytes: number;
  detail?: string;
  swatches?: string[];
  referenceOnly?: boolean;
  requires?: { themes: string[]; fonts: string[]; objects: string[]; gradients: string[] };
}

/** Flatten the manifest into one uniform list so the rail and the rows share a shape. */
export function entriesFrom(manifest: PackManifest): Entry[] {
  const c = manifest.contents;
  const out: Entry[] = [];
  // Projects, templates and presets are all project folders, so one row shape serves all three.
  for (const [kind, list] of [
    ["project", c.projects],
    ["template", c.templates ?? []],
    ["preset", c.presets ?? []],
  ] as const) {
    for (const p of list) {
      out.push({
        kind,
        slug: p.slug,
        name: p.name,
        bytes: p.bytes,
        detail: `${p.sceneCount} scene${p.sceneCount === 1 ? "" : "s"} · ${Math.round(p.durationMs / 1000)}s · ${p.formats.join(", ")}`,
        requires: p.requires,
      });
    }
  }
  for (const t of c.themes) {
    out.push({
      kind: "theme",
      slug: t.slug,
      name: t.name,
      bytes: t.bytes,
      detail: t.mode,
      swatches: t.swatches,
      requires: t.requires,
    });
  }
  for (const f of c.fonts) {
    out.push({
      kind: "font",
      slug: f.slug || `${f.family}@${f.weight}`,
      name: `${f.family} ${f.weight}`,
      bytes: f.bytes,
      referenceOnly: f.referenceOnly,
      detail: f.referenceOnly ? restrictedFontNotice(f.family) : f.postscript,
    });
  }
  for (const o of c.objects) {
    out.push({ kind: "object", slug: o.slug, name: o.name, bytes: o.bytes, detail: o.licence });
  }
  for (const g of c.gradients) {
    out.push({ kind: "gradient", slug: g.slug, name: g.name, bytes: g.bytes });
  }
  for (const e of c.exportPresets) {
    out.push({ kind: "exportPreset", slug: e.slug, name: e.name, bytes: e.bytes });
  }
  for (const s of c.screenshots) {
    out.push({
      kind: "screenshot",
      slug: s.slug,
      name: s.name,
      bytes: s.bytes,
      detail: s.width && s.height ? `${s.width} × ${s.height}` : undefined,
    });
  }
  return out;
}

const KEY = (e: { kind: ItemKind; slug: string }) => `${e.kind}:${e.slug}`;

/** Screen 2. Every row is unticked-able: importing a subset is a first-class action, not a hidden power feature. */
export function ContentsView({
  manifest,
  onBack,
  onContinue,
}: {
  manifest: PackManifest;
  onBack: () => void;
  onContinue: (selection: PackSelection) => void;
}) {
  const entries = useMemo(() => entriesFrom(manifest), [manifest]);
  const [dropped, setDropped] = useState<Record<string, true>>({});
  const [tab, setTab] = useState<ItemKind>(
    (ITEM_KINDS.find((k) => entries.some((e) => e.kind === k)) ?? "project") as ItemKind,
  );

  const included = entries.filter((e) => !dropped[KEY(e)]);
  const counts: Record<string, number> = {};
  for (const e of included) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

  // Reverse dependency awareness: unticking something an included item needs is allowed, and named.
  const warnings: string[] = [];
  const projectShaped = (kind: ItemKind) =>
    kind === "project" || kind === "template" || kind === "preset";
  for (const project of entries.filter((e) => projectShaped(e.kind) && !dropped[KEY(e)])) {
    const req = project.requires;
    if (!req) continue;
    for (const theme of req.themes) {
      if (dropped[`theme:${theme}`]) {
        warnings.push(`${project.name} will fall back to your default theme.`);
      }
    }
    for (const font of req.fonts) {
      if (dropped[`font:${font}`]) {
        warnings.push(`Text in ${project.name} will render in a substitute face.`);
      }
    }
    for (const object of req.objects) {
      if (dropped[`object:${object}`]) {
        warnings.push(`${project.name} will be missing the ${object} model.`);
      }
    }
  }

  const selection: PackSelection = {
    projects: [],
    templates: [],
    presets: [],
    themes: [],
    fonts: [],
    objects: [],
    gradients: [],
    exportPresets: [],
    screenshots: [],
  };
  for (const e of included) {
    (selection[selectionKey(e.kind)] as string[]).push(e.slug);
  }

  const visible = entries.filter((e) => e.kind === tab);

  return (
    <div className="packs-body">
      <div className="packs-rail" role="tablist" aria-label="Categories">
        {ITEM_KINDS.filter((k) => entries.some((e) => e.kind === k)).map((k) => (
          <button
            key={k}
            type="button"
            className="packs-rail-item"
            role="tab"
            aria-selected={k === tab}
            onClick={() => setTab(k)}
          >
            <span>{KIND_LABELS[k].many}</span>
            <span className="packs-rail-count">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="packs-main">
        <div className="packs-scroll">
          <div className="packs-heading">{KIND_LABELS[tab].many}</div>
          {visible.map((e) => (
            <label className="packs-row" key={KEY(e)}>
              <input
                type="checkbox"
                checked={!dropped[KEY(e)]}
                onChange={(ev) => {
                  const next = { ...dropped };
                  if (ev.target.checked) delete next[KEY(e)];
                  else next[KEY(e)] = true;
                  setDropped(next);
                }}
              />
              <span className="packs-row-main">
                <span className="packs-row-title">
                  {e.name}
                  {e.swatches && e.swatches.length > 0 && (
                    <span className="packs-swatches">
                      {e.swatches.slice(0, 4).map((c) => (
                        <span key={c} className="packs-swatch" style={{ background: c }} />
                      ))}
                    </span>
                  )}
                  {e.referenceOnly && (
                    <span className="packs-chip packs-chip-block">Not included</span>
                  )}
                </span>
                {e.detail && <span className="packs-row-detail">{e.detail}</span>}
              </span>
              <span className="packs-row-size">
                {e.referenceOnly ? "name only" : formatBytes(e.bytes)}
              </span>
            </label>
          ))}

          {warnings.length > 0 && (
            <div className="packs-warning" style={{ marginLeft: 0, marginTop: 14 }}>
              {[...new Set(warnings)].map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
        </div>

        <div className="packs-footer">
          <div className="packs-footer-summary">
            {included.length} item{included.length === 1 ? "" : "s"} will be added to ~/Kookaburra
            Cut
          </div>
          <div className="packs-actions">
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={included.length === 0}
              onClick={() => onContinue(selection)}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
