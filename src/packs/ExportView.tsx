import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPack,
  cancelPackBuild,
  chooseDestination,
  getPublisherProfile,
  listPackables,
  planPack,
  revealPack,
} from "../engine/packs";
import { FONT_DISCLAIMER, fontEmbeddingNotice } from "../ui/packs/fontCopy";
import { PackGlyph } from "./PackGlyph";
import {
  breakageWarning,
  countByKind,
  defaultPackName,
  EMPTY_STATE,
  isAuto,
  isIncluded,
  itemKey,
  type SelectionState,
  slugifyFileName,
  toBuildSelection,
  toggle,
  toPlanSelection,
  totalBytes,
} from "./selection";
import {
  formatBytes,
  ITEM_KINDS,
  type ItemKind,
  KIND_LABELS,
  type PackPlan,
  type PackProgress,
  type PublisherProfileView,
  type SelectableItem,
} from "./types";

/** The rail is the nine stores plus a details pane; only the stores are real item kinds. */
type Tab = ItemKind | "details";

type Phase =
  | { step: "picking" }
  | { step: "building"; progress: PackProgress | null }
  | { step: "done"; path: string; bytes: number }
  | { step: "failed"; message: string };

export function ExportView({ onClose }: { onClose: () => void }) {
  const [plan, setPlan] = useState<PackPlan | null>(null);
  const [state, setState] = useState<SelectionState>(EMPTY_STATE);
  const [tab, setTab] = useState<Tab>("project");
  const [phase, setPhase] = useState<Phase>({ step: "picking" });
  const [profile, setProfile] = useState<PublisherProfileView | null>(null);
  const [packName, setPackName] = useState("");
  const [description, setDescription] = useState("");
  const [warnedKey, setWarnedKey] = useState<string | null>(null);
  const [droppedAssets, setDroppedAssets] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  // The first scan walks the whole workspace, so the window must say so rather than showing an empty picker.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listPackables()
      .then(setPlan)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    getPublisherProfile()
      .then((p) => {
        setProfile(p);
        setPackName(defaultPackName(p.organisation, p.effectiveName));
      })
      .catch(() => undefined);
  }, []);

  // Re-resolve the closure whenever the direct ticks change. Debounced: plan_pack walks every sidecar.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (loading) return;
    if (timer.current) window.clearTimeout(timer.current);
    setPlanning(true);
    timer.current = window.setTimeout(() => {
      planPack(toPlanSelection(state))
        .then((p) => {
          setPlan(p);
          setError(null);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setPlanning(false));
    }, 200);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [state, loading]);

  const items = plan?.items ?? [];
  const counts = useMemo(() => countByKind(state, items), [state, items]);
  const bytes = useMemo(() => totalBytes(state, items), [state, items]);
  const included = useMemo(() => items.filter((i) => isIncluded(state, i)), [state, items]);
  const hasFonts = included.some((i) => i.kind === "font");

  const visible = tab === "details" ? [] : items.filter((i) => i.kind === tab);
  const direct = visible.filter((i) => !isAuto(i));
  const auto = visible.filter(isAuto);

  const onToggle = useCallback((item: SelectableItem, next: boolean) => {
    setState((s) => toggle(s, item, next));
    setWarnedKey(!next && isAuto(item) ? itemKey(item.kind, item.slug) : null);
  }, []);

  const onExport = useCallback(async () => {
    setError(null);
    const destination = await chooseDestination(slugifyFileName(packName));
    if (!destination) return;
    setPhase({ step: "building", progress: null });
    try {
      const result = await buildPack(
        toBuildSelection(state, items, droppedAssets),
        destination,
        { name: packName.trim(), description: description.trim() || undefined },
        (progress) => setPhase({ step: "building", progress }),
      );
      setPhase({ step: "done", path: result.path, bytes: result.bytes });
    } catch (e) {
      const message = String(e);
      setPhase(
        message.toLowerCase().includes("cancel")
          ? { step: "picking" }
          : { step: "failed", message },
      );
    }
  }, [state, items, droppedAssets, packName, description]);

  if (loading) {
    return (
      <div className="packs-progress">
        <div className="packs-spinner" aria-hidden="true" />
        <div className="packs-hero-title" style={{ marginTop: 16 }}>
          Reading your workspace
        </div>
        <div className="packs-hero-note">Finding your projects, themes, fonts and objects.</div>
      </div>
    );
  }

  if (phase.step === "building") {
    const p = phase.progress;
    const pct = p && p.total > 0 ? Math.round((p.file / p.total) * 100) : 0;
    return (
      <div className="packs-progress">
        <div style={{ fontSize: 15 }}>
          {p?.stage === "hashing" ? "Checking files" : "Writing the pack"}
        </div>
        <div className="packs-progress-bar">
          <div className="packs-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {p ? `${p.file} of ${p.total} files` : "Preparing…"}
        </div>
        <div className="packs-actions" style={{ justifyContent: "center", marginTop: 20 }}>
          <button type="button" className="btn" onClick={() => void cancelPackBuild()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase.step === "done") {
    return (
      <div className="packs-progress">
        <PackGlyph variant="done" />
        <div className="packs-hero-title">Pack exported</div>
        <div className="packs-hero-note">
          {packName} · {formatBytes(phase.bytes)}
        </div>
        <div className="packs-actions" style={{ justifyContent: "center", marginTop: 22 }}>
          <button
            type="button"
            className="btn primary"
            onClick={() => void revealPack().catch((e) => setError(String(e)))}
          >
            Show in Finder
          </button>
          <button type="button" className="btn" onClick={() => setPhase({ step: "picking" })}>
            Export another
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (phase.step === "failed") {
    return (
      <div className="packs-progress">
        <div className="packs-hero-title">The pack could not be written</div>
        <div className="packs-hero-note">{phase.message}</div>
        <div className="packs-actions" style={{ justifyContent: "center", marginTop: 22 }}>
          <button type="button" className="btn" onClick={() => setPhase({ step: "picking" })}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="packs-body">
      <div className="packs-rail" role="tablist" aria-label="Categories">
        {ITEM_KINDS.map((k) => (
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
        <button
          type="button"
          className="packs-rail-item"
          role="tab"
          aria-selected={tab === "details"}
          onClick={() => setTab("details")}
          style={{ marginTop: 10 }}
        >
          <span>Details</span>
        </button>
      </div>

      <div className="packs-main">
        <div className="packs-scroll">
          {error && <div className="packs-drop-error">{error}</div>}

          {tab === "details" ? (
            <DetailsPane
              profile={profile}
              packName={packName}
              setPackName={setPackName}
              description={description}
              setDescription={setDescription}
            />
          ) : (
            <>
              <div className="packs-heading">{KIND_LABELS[tab].many}</div>
              {direct.length === 0 && (
                <div className="packs-empty">Nothing in your workspace to add here yet.</div>
              )}
              {direct.map((item) => (
                <Row
                  key={item.slug}
                  item={item}
                  checked={isIncluded(state, item)}
                  onToggle={onToggle}
                  warning={warnedKey === itemKey(item.kind, item.slug)}
                />
              ))}

              {auto.length > 0 && (
                <>
                  <div className="packs-heading">Pulled in automatically</div>
                  {auto.map((item) => (
                    <Row
                      key={item.slug}
                      item={item}
                      checked={isIncluded(state, item)}
                      onToggle={onToggle}
                      warning={warnedKey === itemKey(item.kind, item.slug)}
                    />
                  ))}
                </>
              )}

              {tab === "project" && plan && plan.unreferenced.length > 0 && (
                <UnreferencedGroups
                  plan={plan}
                  dropped={droppedAssets}
                  setDropped={setDroppedAssets}
                />
              )}
            </>
          )}

          {hasFonts && <p className="packs-disclaimer">{FONT_DISCLAIMER}</p>}

          {plan && plan.warnings.length > 0 && (
            <div className="packs-warning" style={{ marginLeft: 0, marginTop: 14 }}>
              {plan.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
        </div>

        <div className="packs-footer">
          <div className="packs-footer-summary">
            {included.length === 0
              ? "Nothing selected"
              : `${packName || "Untitled pack"} · ${included.length} item${included.length === 1 ? "" : "s"} · ${planning ? "Estimating…" : formatBytes(bytes)}`}
          </div>
          <div className="packs-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={included.length === 0 || !packName.trim()}
              onClick={() => void onExport()}
            >
              Export…
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  item,
  checked,
  onToggle,
  warning,
}: {
  item: SelectableItem;
  checked: boolean;
  onToggle: (item: SelectableItem, next: boolean) => void;
  warning: boolean;
}) {
  const note = item.embedding ? fontEmbeddingNotice(item.name, item.embedding) : null;
  const warns = item.embedding === "preview-print" || item.embedding === "unknown";
  return (
    <>
      <label className="packs-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(item, e.target.checked)}
        />
        <span className="packs-row-main">
          <span className="packs-row-title">
            {item.name}
            {item.referenceOnly && (
              <span className="packs-chip packs-chip-block">Not included</span>
            )}
            {!item.referenceOnly && warns && (
              <span className="packs-chip packs-chip-warn">Check licence</span>
            )}
          </span>
          {item.detail && <span className="packs-row-detail">{item.detail}</span>}
          {item.requiredBy.length > 0 && (
            <span className="packs-row-detail">← {item.requiredBy.join(", ")}</span>
          )}
          {note && <span className="packs-row-detail">{note}</span>}
        </span>
        <span className="packs-row-size">
          {item.referenceOnly ? "name only" : formatBytes(item.bytes)}
        </span>
      </label>
      {warning && breakageWarning(item) && (
        <div className="packs-warning">{breakageWarning(item)}</div>
      )}
    </>
  );
}

function UnreferencedGroups({
  plan,
  dropped,
  setDropped,
}: {
  plan: PackPlan;
  dropped: Record<string, string[]>;
  setDropped: (next: Record<string, string[]>) => void;
}) {
  return (
    <>
      <div className="packs-heading">Unused files</div>
      {plan.unreferenced.map((group) => {
        const isDropped = (dropped[group.projectSlug] ?? []).length > 0;
        const bytes = group.files.reduce((s, f) => s + f.bytes, 0);
        return (
          <div className="packs-row" key={`${group.projectSlug}:${group.label}`}>
            <span className="packs-row-main">
              <span className="packs-row-title">{group.label}</span>
              <span className="packs-row-detail">
                {group.files.length} file{group.files.length === 1 ? "" : "s"} in{" "}
                {group.projectSlug}, nothing references {group.files.length === 1 ? "it" : "them"}
              </span>
            </span>
            <span className="packs-row-size">{formatBytes(bytes)}</span>
            <button
              type="button"
              onClick={() =>
                setDropped({
                  ...dropped,
                  [group.projectSlug]: isDropped ? [] : group.files.map((f) => f.rel),
                })
              }
            >
              {isDropped ? "Keep" : "Drop these"}
            </button>
          </div>
        );
      })}
    </>
  );
}

function DetailsPane({
  profile,
  packName,
  setPackName,
  description,
  setDescription,
}: {
  profile: PublisherProfileView | null;
  packName: string;
  setPackName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
}) {
  return (
    <>
      <div className="packs-heading">Details</div>
      <label className="packs-field">
        <span>Pack name</span>
        <input value={packName} onChange={(e) => setPackName(e.target.value)} maxLength={80} />
      </label>
      <label className="packs-field">
        <span>Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={400}
        />
      </label>
      <div className="packs-heading">Published by</div>
      {profile ? (
        <div className="packs-row">
          <span className="packs-row-main">
            <span className="packs-row-title">
              {profile.organisation ? `${profile.organisation} · ` : ""}
              {profile.effectiveName}
            </span>
            <span className="packs-row-detail">{profile.device}</span>
            {!profile.configured && (
              <span className="packs-row-detail">
                Set your publisher details in Settings so people know who sent this.
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="packs-empty">Loading publisher details…</div>
      )}
    </>
  );
}
