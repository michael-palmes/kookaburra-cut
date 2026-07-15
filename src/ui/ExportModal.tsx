/** The export modal: Export opens this instead of firing the legacy export directly. The pinned Kookaburra Standard row is the frozen legacy path (exports with no EncodeSpec); Custom always sends a resolved spec so there's no untouched-seed ambiguity. All maths/options logic is pure and unit-pinned in `exportOptions.ts`. Wall-clock/async use is fine here since it's UI chrome, never mounted during export/autorun runs; the loudness measurement runs through the native cached `measure_loudness`. */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AspectName, FPS } from "../engine/format";
import type { LoadedProject } from "../engine/project";
import {
  deleteExportPreset,
  getSettings,
  listExportPresets,
  writeExportPreset,
} from "../engine/workspace";
import { BUNDLED_EXPORT_PRESETS } from "../export/presetRegistry";
import {
  type EncodeSpec,
  type ExportPresetDoc,
  parseExportPreset,
  resolvePresetToEncodeSpec,
} from "../export/presetSchema";
import { EXPORT_BUTTON_ICON, presetIcon } from "./exportIcons";
import {
  ALL_ASPECTS,
  audioKbpsOf,
  CUSTOM_ID,
  type CustomDraft,
  customSeed,
  draftFromDoc,
  draftToDoc,
  estimateSizeMB,
  fitToCap,
  groupPresets,
  isVideotoolbox,
  KOOKABURRA_STANDARD_ID,
  type PresetRow,
  presetAspects,
  resolveDraft,
  slugifyPresetName,
  specChips,
} from "./exportOptions";
import { useEscapeClose } from "./useEscapeClose";

/** What the modal hands back on Export; App owns the run (format set + exportProject). */
export interface ExportSelection {
  presetId: string;
  /** Absent = the frozen legacy path (Kookaburra Standard). */
  encode?: EncodeSpec;
  /** Absent = the legacy filename (only the standard row omits it). */
  outputSuffix?: string;
  aspect: AspectName;
}

interface ExportModalProps {
  project: LoadedProject;
  currentAspect: AspectName;
  busy: boolean;
  onExport: (sel: ExportSelection) => void;
  onClose: () => void;
}

interface LoudnessMeasure {
  integratedLufs: number;
  truePeakDbtp: number;
}

/** Loudness graphs depend on output fps (sample counts), one measure per fps. */
type LoudnessCache = Partial<Record<number, LoudnessMeasure | "pending">>;

const RATE_IS_BITRATE = (
  r: ExportPresetDoc["video"]["rate"],
): r is { targetKbps: number; maxKbps: number; bufsizeKbps: number; twoPass?: boolean } =>
  "targetKbps" in r;

export function ExportModal({ project, currentAspect, busy, onExport, onClose }: ExportModalProps) {
  const [userRows, setUserRows] = useState<PresetRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>(KOOKABURRA_STANDARD_ID);
  const [search, setSearch] = useState("");
  const [aspectFilter, setAspectFilter] = useState<AspectName | null>(null);
  const [aspect, setAspect] = useState<AspectName>(currentAspect);
  const [draft, setDraft] = useState<CustomDraft>(customSeed);
  const [fitted, setFitted] = useState<ExportPresetDoc["video"]["rate"] | null>(null);
  const [loudness, setLoudness] = useState<LoudnessCache>({});
  const [saveAs, setSaveAs] = useState<{ name: string; description: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Auto-disarm after 3s, the house two-step pattern.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);
  const loudnessRef = useRef<LoudnessCache>({});

  const refreshUserPresets = useCallback(async () => {
    try {
      const listings = await listExportPresets();
      setUserRows(
        listings.flatMap((l) => {
          try {
            const doc = parseExportPreset(JSON.parse(l.json), `ws:${l.slug}`);
            return doc
              ? [{ id: `ws:${l.slug}`, doc: { ...doc, id: `ws:${l.slug}` }, isUser: true }]
              : [];
          } catch {
            return [];
          }
        }),
      );
    } catch {
      setUserRows([]); // no workspace yet, bundled lineup only
    }
  }, []);

  // Open: load user presets + restore the last-used selection (per project, global fallback).
  useEffect(() => {
    let live = true;
    void (async () => {
      await refreshUserPresets();
      try {
        const settings = await getSettings();
        if (!live) return;
        const last =
          settings.lastExportPresetByProject?.[project.id] ??
          settings.lastExportPreset ??
          undefined;
        if (last) setSelectedId(last);
      } catch {
        // settings unavailable, stay on the standard row
      }
    })();
    return () => {
      live = false;
    };
  }, [project.id, refreshUserPresets]);

  // Joined the shared Escape stack: layered surfaces close top-first.
  useEscapeClose(onClose);

  const groups = useMemo(
    () => groupPresets(BUNDLED_EXPORT_PRESETS, userRows, search, aspectFilter),
    [userRows, search, aspectFilter],
  );

  const selectedRow: PresetRow | null = useMemo(() => {
    if (selectedId === KOOKABURRA_STANDARD_ID || selectedId === CUSTOM_ID) return null;
    const bundled = BUNDLED_EXPORT_PRESETS.find((p) => p.id === selectedId);
    if (bundled) return { id: selectedId, doc: bundled, isUser: false };
    return userRows.find((r) => r.id === selectedId) ?? null;
  }, [selectedId, userRows]);

  // A stale last-used (deleted ws: preset) degrades to the standard row.
  useEffect(() => {
    if (
      selectedId !== KOOKABURRA_STANDARD_ID &&
      selectedId !== CUSTOM_ID &&
      !selectedRow &&
      userRows.length >= 0
    ) {
      const bundled = BUNDLED_EXPORT_PRESETS.some((p) => p.id === selectedId);
      const user = userRows.some((r) => r.id === selectedId);
      if (!bundled && !user) setSelectedId(KOOKABURRA_STANDARD_ID);
    }
  }, [selectedId, selectedRow, userRows]);

  const select = useCallback((id: string, doc?: ExportPresetDoc) => {
    setSelectedId(id);
    setFitted(null);
    setSaveAs(null);
    setError(null);
    setConfirmDelete(false);
    if (doc) {
      const allowed = presetAspects(doc);
      setAspect(allowed.includes(doc.favouredAspect) ? doc.favouredAspect : allowed[0]);
    }
  }, []);

  // ── Loudness (gain-only; warn, never limit) ────────────────────────────────
  const targetOf = useCallback(
    (id: string): number | null => {
      if (id === CUSTOM_ID) return draft.loudnessTarget;
      if (id === KOOKABURRA_STANDARD_ID) return null;
      return selectedRow?.doc.audio.loudnessTarget ?? null;
    },
    [draft.loudnessTarget, selectedRow],
  );

  const measure = useCallback(
    async (outFps: number): Promise<LoudnessMeasure | null> => {
      if (!project.audio) return null;
      const cached = loudnessRef.current[outFps];
      if (cached && cached !== "pending") return cached;
      // The export graph's frame count at the output rate: the render steps at outFps directly, so the measured graph must match it exactly.
      const outFrames = Math.max(1, Math.round((project.totalMs / 1000) * outFps));
      const m = await invoke<LoudnessMeasure>("measure_loudness", {
        file: project.audio.abs,
        gainDb: project.audio.gainDb ?? 0,
        fadeInMs: project.audio.fadeInMs ?? 0,
        fadeOutMs: project.audio.fadeOutMs ?? 0,
        startOffsetMs: project.audio.startOffsetMs ?? 0,
        totalFrames: outFrames,
        fps: outFps,
      });
      loudnessRef.current = { ...loudnessRef.current, [outFps]: m };
      setLoudness(loudnessRef.current);
      return m;
    },
    [project],
  );

  const selectedFps = selectedId === CUSTOM_ID ? draft.fps : (selectedRow?.doc.video.fps ?? FPS);

  // Measure eagerly when the selection wants a loudness target: the warning must show in the pane, not first at export time.
  useEffect(() => {
    const target = targetOf(selectedId);
    if (target == null || !project.audio) return;
    if (loudnessRef.current[selectedFps]) return;
    loudnessRef.current = { ...loudnessRef.current, [selectedFps]: "pending" };
    setLoudness(loudnessRef.current);
    void measure(selectedFps).catch(() => {
      delete loudnessRef.current[selectedFps];
    });
  }, [selectedId, selectedFps, targetOf, measure, project.audio]);

  // Plain-language clipping warning (warn, never limit): the technical "-14 LUFS (correction +x dB)" readout was dropped since most people never need to see it; only shows when the volume match would push the loudest moments into audible distortion (projected true peak above -1.5 dBTP).
  const loudnessWarning = (() => {
    const target = targetOf(selectedId);
    if (target == null || !project.audio) return null;
    const m = loudness[selectedFps];
    if (!m || m === "pending") return null;
    const delta = Math.round((target - m.integratedLufs) * 100) / 100;
    if (m.truePeakDbtp + delta <= -1.5) return null;
    return delta > 0
      ? `Heads up — matching this platform's volume turns the soundtrack up by ${delta.toFixed(1)} dB, so the loudest moments may distort after upload. Starting with a louder track avoids this.`
      : "Heads up — this soundtrack already peaks near full volume, so the loudest moments may distort after upload.";
  })();

  const loudnessGainFor = useCallback(
    async (target: number | null, outFps: number): Promise<number | undefined> => {
      if (target == null || !project.audio) return undefined;
      const m = await measure(outFps);
      if (!m) return undefined;
      return Math.round((target - m.integratedLufs) * 100) / 100;
    },
    [measure, project.audio],
  );

  // ── Export ─────────────────────────────────────────────────────────────────
  const doExport = useCallback(async () => {
    setError(null);
    try {
      if (selectedId === KOOKABURRA_STANDARD_ID) {
        onExport({ presetId: KOOKABURRA_STANDARD_ID, aspect });
        return;
      }
      if (selectedId === CUSTOM_ID) {
        const resolved = resolveDraft(draft);
        if (!resolved.spec) {
          setError(resolved.error);
          return;
        }
        const spec = { ...resolved.spec };
        const gain = await loudnessGainFor(draft.loudnessTarget, draft.fps);
        if (gain !== undefined && spec.audio) spec.audio = { ...spec.audio, loudnessGainDb: gain };
        onExport({ presetId: CUSTOM_ID, encode: spec, outputSuffix: "custom", aspect });
        return;
      }
      const row = selectedRow;
      if (!row) return;
      const doc = fitted ? { ...row.doc, video: { ...row.doc.video, rate: fitted } } : row.doc;
      const gain = await loudnessGainFor(doc.audio.loudnessTarget ?? null, doc.video.fps);
      const spec = resolvePresetToEncodeSpec(doc, gain);
      onExport({
        presetId: row.id,
        encode: spec,
        outputSuffix: row.id.startsWith("ws:") ? row.id.slice(3) : row.id,
        aspect,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedId, selectedRow, draft, fitted, aspect, onExport, loudnessGainFor]);

  // ── Save-as / duplicate / delete ───────────────────────────────────────────
  const duplicate = useCallback((doc: ExportPresetDoc) => {
    setDraft(draftFromDoc(doc));
    setSelectedId(CUSTOM_ID);
    setSaveAs({ name: `${doc.name} copy`, description: doc.description });
    setFitted(null);
    setError(null);
  }, []);

  const savePreset = useCallback(async () => {
    if (!saveAs) return;
    const name = saveAs.name.trim();
    if (!name) {
      setError("Give the preset a name first.");
      return;
    }
    const slug = slugifyPresetName(name);
    if (!slug) {
      setError("The name needs at least one letter or number.");
      return;
    }
    const resolved = resolveDraft(draft);
    if (resolved.error) {
      setError(resolved.error);
      return;
    }
    const doc = draftToDoc(draft, `ws:${slug}`, name, saveAs.description.trim(), "Custom", aspect);
    try {
      await writeExportPreset(slug, JSON.stringify(doc, null, 2));
      await refreshUserPresets();
      select(`ws:${slug}`, doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [saveAs, draft, aspect, refreshUserPresets, select]);

  const removePreset = useCallback(async () => {
    if (!selectedRow?.isUser) return;
    try {
      await deleteExportPreset(selectedRow.id.slice(3));
      await refreshUserPresets();
      select(KOOKABURRA_STANDARD_ID);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedRow, refreshUserPresets, select]);

  // ── Detail-pane fragments ──────────────────────────────────────────────────
  const audioKbps = (doc: ExportPresetDoc) => (project.audio ? audioKbpsOf(doc) : 0);

  function aspectRowFor(allowed: AspectName[]) {
    return (
      <fieldset className="export-aspect-row" aria-label="Aspect ratio">
        {allowed.map((a) => (
          <button
            key={a}
            type="button"
            className={`chip ${aspect === a ? "selected" : ""}`}
            aria-pressed={aspect === a}
            onClick={() => setAspect(a)}
          >
            {a}
          </button>
        ))}
      </fieldset>
    );
  }

  function estimateFor(doc: ExportPresetDoc) {
    const rate = fitted ?? doc.video.rate;
    const effective = fitted ? { ...doc, video: { ...doc.video, rate } } : doc;
    const mb = estimateSizeMB(effective, project.totalMs, audioKbps(doc));
    if (mb == null) {
      return <p className="export-estimate">Size varies with content (constant quality).</p>;
    }
    const docRate = doc.video.rate;
    const cap = doc.maxFileSizeMB;
    const over = cap != null && mb > cap;
    return (
      <div className="export-estimate">
        <span className={over ? "export-over-cap" : undefined}>
          ≈ {mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB
          {cap != null ? ` of the ${cap} MB cap` : ""}
        </span>
        {over && RATE_IS_BITRATE(docRate) && (
          <button
            type="button"
            className="btn"
            onClick={() => setFitted(fitToCap(docRate, cap, project.totalMs, audioKbps(doc)))}
          >
            Fit to cap
          </button>
        )}
        {fitted && RATE_IS_BITRATE(fitted) && (
          <span className="export-fitted">
            fitted to {Math.round(fitted.targetKbps / 100) / 10} Mbps
          </span>
        )}
      </div>
    );
  }

  const exportLabel = busy ? "Exporting…" : "Export";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Export">
      <div className="modal export-modal">
        <div className="modal-title-row">
          <h2 className="modal-title">Export</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} />
        </div>
        <div className="export-body">
          <section className="export-detail">
            {selectedId === KOOKABURRA_STANDARD_ID && (
              <>
                <h3 className="export-detail-title">
                  {presetIcon(KOOKABURRA_STANDARD_ID)} Kookaburra Standard
                </h3>
                <p className="export-desc">
                  The studio default — deterministic H.264 (CRF 18) at the render's native
                  resolution and 60 fps. This is the exact path Verify ×2 gates.
                </p>
                {aspectRowFor(ALL_ASPECTS)}
                <p className="export-estimate">Size varies with content (constant quality).</p>
              </>
            )}

            {selectedRow && (
              <>
                <h3 className="export-detail-title">
                  {presetIcon(selectedRow.id)} {selectedRow.doc.name}
                </h3>
                <p className="export-desc">{selectedRow.doc.description}</p>
                {selectedRow.doc.notes && <p className="export-notes">{selectedRow.doc.notes}</p>}
                <span className="export-row-chips">
                  {specChips(selectedRow.doc).map((c) => (
                    <span key={c} className="export-chip">
                      {c}
                    </span>
                  ))}
                </span>
                {aspectRowFor(presetAspects(selectedRow.doc))}
                {estimateFor(selectedRow.doc)}
                {isVideotoolbox(selectedRow.doc.video.codec) && (
                  <p className="export-notes">
                    Hardware encode — fast, but not byte-reproducible; excluded from Verify.
                  </p>
                )}
                {loudnessWarning && (
                  <p className="export-loudness export-warn">{loudnessWarning}</p>
                )}
                <div className="export-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => duplicate(selectedRow.doc)}
                    title="Copy into the Custom panel to tweak and save as your own"
                  >
                    Duplicate…
                  </button>
                  {selectedRow.isUser &&
                    (confirmDelete ? (
                      <button type="button" className="btn export-danger" onClick={removePreset}>
                        Really delete?
                      </button>
                    ) : (
                      <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
                        Delete
                      </button>
                    ))}
                </div>
              </>
            )}

            {selectedId === CUSTOM_ID && (
              <CustomPanel
                draft={draft}
                setDraft={(d) => {
                  setDraft(d);
                  setError(null);
                }}
                aspectRow={aspectRowFor(ALL_ASPECTS)}
                saveAs={saveAs}
                setSaveAs={setSaveAs}
                onSave={savePreset}
                hasAudio={!!project.audio}
                loudnessWarning={loudnessWarning}
              />
            )}
            {error && <p className="modal-error">{error}</p>}
          </section>

          <aside className="export-rail">
            <input
              className="modal-input export-search"
              type="search"
              placeholder="Search presets…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <fieldset className="export-filter-row" aria-label="Filter by aspect">
              {ALL_ASPECTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`chip ${aspectFilter === a ? "selected" : ""}`}
                  aria-pressed={aspectFilter === a}
                  onClick={() => setAspectFilter(aspectFilter === a ? null : a)}
                >
                  {a}
                </button>
              ))}
            </fieldset>
            <div className="export-list">
              <button
                type="button"
                className={`export-row ${selectedId === KOOKABURRA_STANDARD_ID ? "export-row-active" : ""}`}
                onClick={() => select(KOOKABURRA_STANDARD_ID)}
              >
                <span className="export-row-icon">{presetIcon(KOOKABURRA_STANDARD_ID)}</span>
                <span className="export-row-body">
                  <span className="export-row-name">Kookaburra Standard</span>
                  <span className="export-row-desc">
                    The studio default — full quality, byte-reproducible.
                  </span>
                </span>
              </button>
              {groups.map((g) => (
                <div key={g.platform} className="export-group">
                  <h3 className="export-group-title">{g.platform}</h3>
                  {g.rows.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`export-row ${selectedId === r.id ? "export-row-active" : ""}`}
                      onClick={() => select(r.id, r.doc)}
                    >
                      <span className="export-row-icon">{presetIcon(r.id)}</span>
                      <span className="export-row-body">
                        <span className="export-row-name">{r.doc.name}</span>
                        <span className="export-row-desc">{r.doc.description}</span>
                        <span className="export-row-chips">
                          {specChips(r.doc).map((c) => (
                            <span key={c} className="export-chip">
                              {c}
                            </span>
                          ))}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              <button
                type="button"
                className={`export-row export-row-custom ${selectedId === CUSTOM_ID ? "export-row-active" : ""}`}
                onClick={() => {
                  select(CUSTOM_ID);
                }}
              >
                <span className="export-row-icon">{presetIcon(CUSTOM_ID)}</span>
                <span className="export-row-body">
                  <span className="export-row-name">Custom…</span>
                  <span className="export-row-desc">Every knob the pipeline offers.</span>
                </span>
              </button>
            </div>
          </aside>
        </div>
        <div className="export-footer">
          <button type="button" className="btn primary" onClick={doExport} disabled={busy}>
            {EXPORT_BUTTON_ICON}
            {exportLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The Custom panel (the decision-20 knob set: Video / Audio / Delivery) ──────

interface CustomPanelProps {
  draft: CustomDraft;
  setDraft: (d: CustomDraft) => void;
  aspectRow: React.ReactNode;
  saveAs: { name: string; description: string } | null;
  setSaveAs: (s: { name: string; description: string } | null) => void;
  onSave: () => void;
  hasAudio: boolean;
  loudnessWarning: string | null;
}

function CustomPanel({
  draft,
  setDraft,
  aspectRow,
  saveAs,
  setSaveAs,
  onSave,
  hasAudio,
  loudnessWarning,
}: CustomPanelProps) {
  const set = <K extends keyof CustomDraft>(key: K, value: CustomDraft[K]) =>
    setDraft({ ...draft, [key]: value });
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const videotoolbox = isVideotoolbox(draft.codec);
  const prores = draft.codec === "prores_ks";

  return (
    <>
      <h3 className="export-detail-title">{presetIcon("custom")} Custom</h3>
      <p className="export-desc">
        Seeded from the studio default — every change here exports through the preset pipeline
        (bt709 tags recommended for platforms).
      </p>
      {aspectRow}

      <h4 className="export-section-title">Video</h4>
      <div className="export-knobs">
        <label>
          Codec
          <select
            className="select"
            value={draft.codec}
            onChange={(e) => {
              const codec = e.target.value as CustomDraft["codec"];
              // VT lanes are bitrate-only, flip the mode so the panel never starts invalid.
              setDraft({
                ...draft,
                codec,
                rateMode: isVideotoolbox(codec) ? "bitrate" : draft.rateMode,
              });
            }}
          >
            <option value="libx264">H.264 (libx264)</option>
            <option value="libx265">HEVC (libx265)</option>
            <option value="h264_videotoolbox">H.264 — hardware fast draft</option>
            <option value="hevc_videotoolbox">HEVC — hardware fast draft</option>
            <option value="prores_ks">ProRes 422 HQ (.mov)</option>
          </select>
        </label>
        <label>
          Resolution
          <select
            className="select"
            value={draft.shortEdge ?? "native"}
            onChange={(e) =>
              set("shortEdge", e.target.value === "native" ? null : Number(e.target.value))
            }
          >
            <option value="native">Native (render size)</option>
            <option value="1440">1440p short edge</option>
            <option value="1080">1080p short edge</option>
            <option value="720">720p short edge</option>
          </select>
        </label>
        <label>
          Frame rate
          <select
            className="select"
            value={draft.fps}
            onChange={(e) => set("fps", Number(e.target.value) as 30 | 60)}
          >
            <option value="60">60 fps</option>
            <option value="30">30 fps</option>
          </select>
        </label>
        {!prores && (
          <label>
            Rate control
            <select
              className="select"
              value={draft.rateMode}
              onChange={(e) => set("rateMode", e.target.value as "crf" | "bitrate")}
              disabled={videotoolbox}
              title={videotoolbox ? "VideoToolbox is bitrate-only" : undefined}
            >
              <option value="crf">Constant quality (CRF)</option>
              <option value="bitrate">Bitrate (target + max + buffer)</option>
            </select>
          </label>
        )}
        {!prores && draft.rateMode === "crf" && (
          <label>
            CRF
            <input
              className="modal-input"
              type="number"
              min={0}
              max={51}
              value={draft.crf}
              onChange={(e) => set("crf", num(e.target.value, draft.crf))}
            />
          </label>
        )}
        {!prores && draft.rateMode === "bitrate" && (
          <>
            <label>
              Target kbps
              <input
                className="modal-input"
                type="number"
                min={500}
                value={draft.targetKbps}
                onChange={(e) => set("targetKbps", num(e.target.value, draft.targetKbps))}
              />
            </label>
            <label>
              Max kbps
              <input
                className="modal-input"
                type="number"
                value={draft.maxKbps}
                onChange={(e) => set("maxKbps", num(e.target.value, draft.maxKbps))}
              />
            </label>
            <label>
              Buffer kbps
              <input
                className="modal-input"
                type="number"
                value={draft.bufsizeKbps}
                onChange={(e) => set("bufsizeKbps", num(e.target.value, draft.bufsizeKbps))}
              />
            </label>
            {!videotoolbox && (
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={draft.twoPass}
                  onChange={(e) => set("twoPass", e.target.checked)}
                />
                Two-pass (renders once to a lossless mezzanine)
              </label>
            )}
          </>
        )}
        {!prores && !videotoolbox && (
          <>
            <label>
              Profile
              <input
                className="modal-input"
                type="text"
                placeholder="auto"
                value={draft.profile}
                onChange={(e) => set("profile", e.target.value)}
              />
            </label>
            <label>
              Level
              <input
                className="modal-input"
                type="text"
                placeholder="auto"
                value={draft.level}
                onChange={(e) => set("level", e.target.value)}
              />
            </label>
            <label>
              Keyframe every
              <select
                className="select"
                value={draft.gopSeconds ?? "auto"}
                onChange={(e) =>
                  set("gopSeconds", e.target.value === "auto" ? null : Number(e.target.value))
                }
              >
                <option value="auto">Auto</option>
                <option value="1">1 s</option>
                <option value="2">2 s</option>
                <option value="4">4 s</option>
              </select>
            </label>
            <label>
              B-frames
              <select
                className="select"
                value={draft.bFrames ?? "auto"}
                onChange={(e) =>
                  set("bFrames", e.target.value === "auto" ? null : Number(e.target.value))
                }
              >
                <option value="auto">Auto</option>
                <option value="0">0</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </label>
          </>
        )}
        {draft.codec === "libx264" && (
          <label>
            Entropy coding
            <select
              className="select"
              value={draft.entropy || "auto"}
              onChange={(e) =>
                set(
                  "entropy",
                  (e.target.value === "auto" ? "" : e.target.value) as CustomDraft["entropy"],
                )
              }
            >
              <option value="auto">Auto (CABAC)</option>
              <option value="cabac">CABAC</option>
              <option value="cavlc">CAVLC</option>
            </select>
          </label>
        )}
        {draft.codec === "libx265" && (
          <label className="export-check">
            <input
              type="checkbox"
              checked={draft.tenBit}
              onChange={(e) => set("tenBit", e.target.checked)}
            />
            10-bit (main10)
          </label>
        )}
      </div>

      <h4 className="export-section-title">Audio</h4>
      <div className="export-knobs">
        <label>
          Codec
          <select
            className="select"
            value={draft.audioMode}
            onChange={(e) => set("audioMode", e.target.value as "aac" | "pcm")}
          >
            <option value="aac">AAC</option>
            <option value="pcm">PCM (uncompressed, .mov only)</option>
          </select>
        </label>
        {draft.audioMode === "aac" ? (
          <label>
            AAC bitrate
            <select
              className="select"
              value={draft.aacKbps}
              onChange={(e) => set("aacKbps", Number(e.target.value))}
            >
              <option value="128">128 kbps</option>
              <option value="192">192 kbps</option>
              <option value="256">256 kbps</option>
              <option value="384">384 kbps</option>
            </select>
          </label>
        ) : (
          <label>
            PCM depth
            <select
              className="select"
              value={draft.pcmBits}
              onChange={(e) => set("pcmBits", Number(e.target.value) as 16 | 24)}
            >
              <option value="16">16-bit</option>
              <option value="24">24-bit</option>
            </select>
          </label>
        )}
        <label>
          Loudness target
          <select
            className="select"
            value={draft.loudnessTarget ?? "off"}
            onChange={(e) =>
              set("loudnessTarget", e.target.value === "off" ? null : Number(e.target.value))
            }
            disabled={!hasAudio}
            title={hasAudio ? undefined : "This project has no soundtrack"}
          >
            <option value="off">Off</option>
            <option value="-14">−14 LUFS (social)</option>
            <option value="-24">−24 LUFS (broadcast)</option>
          </select>
        </label>
        <span className="export-notes">48 kHz fixed.</span>
      </div>
      {loudnessWarning && <p className="export-loudness export-warn">{loudnessWarning}</p>}

      <h4 className="export-section-title">Delivery</h4>
      <div className="export-knobs">
        <label className="export-check">
          <input
            type="checkbox"
            checked={draft.faststart}
            onChange={(e) => set("faststart", e.target.checked)}
          />
          Web-ready start (faststart)
        </label>
        <label className="export-check">
          <input
            type="checkbox"
            checked={draft.colourTags}
            onChange={(e) => set("colourTags", e.target.checked)}
          />
          bt709 colour tags (convert + tag together)
        </label>
      </div>

      {saveAs ? (
        <div className="export-saveas">
          <input
            className="modal-input"
            type="text"
            placeholder="Preset name"
            value={saveAs.name}
            onChange={(e) => setSaveAs({ ...saveAs, name: e.target.value })}
          />
          <input
            className="modal-input"
            type="text"
            placeholder="One-sentence description"
            value={saveAs.description}
            onChange={(e) => setSaveAs({ ...saveAs, description: e.target.value })}
          />
          <div className="export-actions">
            <button type="button" className="btn" onClick={() => setSaveAs(null)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={onSave}>
              Save preset
            </button>
          </div>
        </div>
      ) : (
        <div className="export-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setSaveAs({ name: "", description: "" })}
          >
            Save as preset…
          </button>
        </div>
      )}
    </>
  );
}
