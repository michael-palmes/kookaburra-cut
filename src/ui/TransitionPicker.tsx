/** Transition picker: an edit-bar modal editing the transition into the scene at the playhead, with a live-GL preview driven by the real composite shaders (engine/transitionShader.ts) so every type previews faithfully; one small renderer per modal open, disposed on close, never one context per card (WKWebView context pressure); wall-clock use is fine here since the edit bar is unmounted during export/autorun; textures load with `colorSpace = SRGBColorSpace` to match the compositor's render-target semantics. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  CanvasTexture,
  Color,
  GLSL3,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { fsUrl } from "../engine/media";
import type { LoadedProject } from "../engine/project";
import {
  applyTransitionEase,
  resolveTransitionParams,
  type TransitionEase,
  type TransitionSpec,
  type TransitionType,
} from "../engine/sceneTimeline";
import { DIRECTION_OPTIONS, TRANSITION_CATALOG } from "../engine/transitionCatalog";
import {
  EXT2_MIN_TYPE,
  EXTENDED_MIN_TYPE,
  fragmentShader,
  fragmentShaderExt,
  fragmentShaderExt2,
  SHAPE_ID,
  TYPE_ID,
  vertexShader,
  vertexShader300,
} from "../engine/transitionShader";
import { ColourPicker } from "./colour/ColourPicker";
import { useEscapeClose } from "./useEscapeClose";

function sceneStem(project: LoadedProject, i: number): string {
  const base = (project.sceneFiles[i] ?? "").split("/").pop() ?? "";
  return base.replace(/\.tsx$/, "");
}

const PREVIEW_W = 320;
const PREVIEW_H = 180;
/** One preview cycle: hold A · run the transition · hold B. */
const HOLD_MS = 450;
const RUN_MS = 1400;

function makePreviewMaterial(fragment: string, glsl3: boolean): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      texA: { value: null },
      texB: { value: null },
      progress: { value: 0 },
      type: { value: 0 },
      direction: { value: new Vector2(1, 0) },
      dipColor: { value: new Vector3(0, 0, 0) },
      aspect: { value: PREVIEW_W / PREVIEW_H },
      intensity: { value: 0 },
      softness: { value: 0.08 },
      center: { value: new Vector2(0.5, 0.5) },
      blocks: { value: new Vector2(24, 14) },
      shape: { value: 0 },
      steps: { value: 12 },
      parallax: { value: 0.5 },
    },
    vertexShader: glsl3 ? vertexShader300 : vertexShader,
    fragmentShader: fragment,
    glslVersion: glsl3 ? GLSL3 : null,
    depthTest: false,
    depthWrite: false,
  });
}

/** Theme colour set for the sample slides. */
export interface SlideColors {
  background: string;
  text: string;
  accent: string;
  muted: string;
}

/** Procedural sample slide when no cached thumb exists (the picker never captures): a 2D-canvas mock layout in the scene's theme colours, with enough structure for blur/zoom/whip/glitch to read; variant "a"/"b" differ so motion and direction are legible between the two. */
function sampleSlideTexture(colors: SlideColors, variant: "a" | "b"): CanvasTexture {
  const w = PREVIEW_W;
  const h = PREVIEW_H;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, w, h);
    const bar = (x: number, y: number, bw: number, bh: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, bh / 2);
      ctx.fill();
    };
    if (variant === "a") {
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.arc(w * 0.22, h * 0.4, h * 0.17, 0, Math.PI * 2);
      ctx.fill();
      bar(w * 0.42, h * 0.3, w * 0.4, h * 0.09, colors.text);
      bar(w * 0.42, h * 0.46, w * 0.28, h * 0.06, colors.muted);
      bar(w * 0.12, h * 0.74, w * 0.62, h * 0.06, colors.muted);
    } else {
      bar(w * 0.14, h * 0.2, w * 0.5, h * 0.11, colors.text);
      bar(w * 0.14, h * 0.4, w * 0.34, h * 0.06, colors.muted);
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.roundRect(w * 0.6, h * 0.56, w * 0.26, h * 0.26, 8);
      ctx.fill();
      bar(w * 0.14, h * 0.66, w * 0.36, h * 0.06, colors.muted);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

interface PreviewHandles {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  mesh: Mesh;
  matSdr: ShaderMaterial;
  matExt: ShaderMaterial;
  matExt2: ShaderMaterial;
  texA: Texture;
  texB: Texture;
  raf: number;
  disposed: boolean;
}

function TransitionPreview({
  spec,
  thumbA,
  thumbB,
  fallbackA,
  fallbackB,
}: {
  /** The draft; null = None (hard cut). */
  spec: TransitionSpec | null;
  thumbA: string | null;
  thumbB: string | null;
  /** Theme colours for the sample-slide stand-ins. */
  fallbackA: SlideColors;
  fallbackB: SlideColors;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  // A fresh canvas + context per effect run, torn down with forceContextLoss on cleanup; never reuse a WebGLRenderer's canvas, since the old GL state vs the new renderer's default caches leaves texture binds stale and every sample reads black (found live under StrictMode's double-mount). Re-runs when the thumb URLs land, so flats render first and loaded thumbs swap in asynchronously.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const canvas = document.createElement("canvas");
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    canvas.className = "transition-preview-canvas";
    canvas.setAttribute("aria-label", "Transition preview");
    container.appendChild(canvas);

    const renderer = new WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(PREVIEW_W, PREVIEW_H, false);
    const scene = new Scene();
    const camera = new Camera();
    const matSdr = makePreviewMaterial(fragmentShader, false);
    const matExt = makePreviewMaterial(fragmentShaderExt, true);
    const matExt2 = makePreviewMaterial(fragmentShaderExt2, true);
    const mesh = new Mesh(new PlaneGeometry(2, 2), matSdr);
    mesh.frustumCulled = false;
    scene.add(mesh);

    const handles: PreviewHandles = {
      renderer,
      scene,
      camera,
      mesh,
      matSdr,
      matExt,
      matExt2,
      texA: sampleSlideTexture(fallbackA, "a"),
      texB: sampleSlideTexture(fallbackB, "b"),
      raf: 0,
      disposed: false,
    };

    // Thumbs replace the flats whenever they load; a failed load keeps the flat.
    const loader = new TextureLoader();
    const swapIn = (url: string | null, assign: (t: Texture) => void) => {
      if (!url) return;
      loader.load(
        url,
        (t) => {
          if (handles.disposed) {
            t.dispose();
            return;
          }
          t.colorSpace = SRGBColorSpace;
          assign(t);
        },
        undefined,
        () => {},
      );
    };
    swapIn(thumbA, (t) => {
      handles.texA.dispose();
      handles.texA = t;
    });
    swapIn(thumbB, (t) => {
      handles.texB.dispose();
      handles.texB = t;
    });

    const start = performance.now();
    const cycle = HOLD_MS + RUN_MS + HOLD_MS;
    const frame = (now: number) => {
      if (handles.disposed) return;
      const t = (now - start) % cycle;
      const progress = t < HOLD_MS ? 0 : t < HOLD_MS + RUN_MS ? (t - HOLD_MS) / RUN_MS : 1;
      const s = specRef.current;
      // None: a hard cut at the midpoint, rendered through the crossfade branch at 0/1.
      const type: TransitionType = s?.type ?? "crossfade";
      const p = s ? applyTransitionEase(s.ease, progress) : progress < 0.5 ? 0 : 1;
      const id = TYPE_ID[type];
      const mat =
        id >= EXT2_MIN_TYPE
          ? handles.matExt2
          : id >= EXTENDED_MIN_TYPE
            ? handles.matExt
            : handles.matSdr;
      handles.mesh.material = mat;
      const u = mat.uniforms;
      const params = resolveTransitionParams(s ?? { type: "crossfade", durationMs: 600 });
      u.texA.value = handles.texA;
      u.texB.value = handles.texB;
      u.progress.value = p;
      u.type.value = TYPE_ID[type];
      const dir =
        s?.direction ??
        (type === "slide" ||
        type === "wipe" ||
        type === "push" ||
        type === "whip" ||
        type === "slice"
          ? [1, 0]
          : [0, 0]);
      (u.direction.value as Vector2).set(dir[0], dir[1]);
      (u.dipColor.value as Vector3).setFromColor(new Color(s?.color ?? fallbackB.background));
      u.intensity.value = params.intensity;
      u.softness.value = params.softness;
      (u.center.value as Vector2).set(params.center[0], params.center[1]);
      (u.blocks.value as Vector2).set(params.blocks[0], params.blocks[1]);
      u.shape.value = SHAPE_ID[params.shape];
      u.steps.value = params.steps;
      u.parallax.value = params.parallax;
      renderer.render(scene, camera);
      handles.raf = requestAnimationFrame(frame);
    };
    handles.raf = requestAnimationFrame(frame);

    return () => {
      handles.disposed = true;
      cancelAnimationFrame(handles.raf);
      handles.texA.dispose();
      handles.texB.dispose();
      matSdr.dispose();
      matExt.dispose();
      matExt2.dispose();
      mesh.geometry.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [thumbA, thumbB, fallbackA, fallbackB]);

  return <div ref={containerRef} className="transition-preview" />;
}

/** Progress-feel choices; Linear removes the key so untouched specs keep exact bytes. */
const EASE_OPTIONS: { id: TransitionEase; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "smooth", label: "Smooth" },
  { id: "snappy", label: "Snappy" },
];

const ARROWS: Record<string, string> = {
  Left: "M14 4 L6 10 L14 16",
  Right: "M6 4 L14 10 L6 16",
  Up: "M4 14 L10 6 L16 14",
  Down: "M4 6 L10 14 L16 6",
};

export function TransitionModal({
  project,
  boundaryIndex,
  thumbs,
  onCancel,
  onApply,
  embedded = false,
}: {
  project: LoadedProject;
  /** The OUTGOING scene's index (0..slots.length-2): the boundary this scene exits through. */
  boundaryIndex: number;
  /** Scene thumb paths by file stem (may be empty; flat fallbacks render instead). */
  thumbs: Record<string, string>;
  onCancel: () => void;
  /** Persists the spec (null = remove) and refreshes timing; the modal awaits it. */
  onApply: (spec: TransitionSpec | null) => Promise<void>;
  /** Render without the modal chrome; the inspector drill-in hosts the same body (decision 8) with a compact stacked layout. */
  embedded?: boolean;
}) {
  const existing = project.slots[boundaryIndex + 1]?.transitionIn ?? null;
  const [draft, setDraft] = useState<TransitionSpec | null>(existing ? { ...existing } : null);
  useEscapeClose(onCancel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { fsUrlA, fsUrlB } = useMemo(() => {
    const a = thumbs[sceneStem(project, boundaryIndex)];
    const b = thumbs[sceneStem(project, boundaryIndex + 1)];
    return { fsUrlA: a ? fsUrl(a) : null, fsUrlB: b ? fsUrl(b) : null };
  }, [thumbs, boundaryIndex, project]);

  const themeIn = project.sceneThemes[boundaryIndex + 1] ?? project.theme;
  const themeOut = project.sceneThemes[boundaryIndex] ?? project.theme;
  const meta = draft ? TRANSITION_CATALOG.find((m) => m.type === draft.type) : null;

  const pick = (type: TransitionType | null) => {
    setError(null);
    if (type === null) {
      setDraft(null);
      return;
    }
    const m = TRANSITION_CATALOG.find((mm) => mm.type === type);
    if (!m) return;
    setDraft((prev) => ({
      type,
      durationMs: prev?.durationMs ?? m.defaultDurationMs,
      ...(m.needsDirection && prev?.direction ? { direction: prev.direction } : {}),
      ...(m.needsColor && prev?.color ? { color: prev.color } : {}),
      // A fresh transition defaults to the smooth feel; an existing spec keeps its stored ease (absent = linear, the byte contract).
      ...(prev ? (prev.ease ? { ease: prev.ease } : {}) : { ease: "smooth" as TransitionEase }),
      ...(m.presets ?? {}),
    }));
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await onApply(draft);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const durationSeconds = ((draft?.durationMs ?? 600) / 1000).toFixed(2);
  const [durationText, setDurationText] = useState(durationSeconds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed on type pick
  useEffect(() => setDurationText(durationSeconds), [draft?.type]);
  const commitDuration = () => {
    const seconds = Number(durationText);
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 2 || !draft) {
      setDurationText(durationSeconds);
      return;
    }
    setDraft({ ...draft, durationMs: Math.round(seconds * 1000) });
  };

  const body = (
    <>
      <div className="transition-body">
        <div className="transition-grid" role="listbox" aria-label="Transition type">
          <div
            role="option"
            tabIndex={0}
            aria-selected={draft === null}
            className={`transition-card${draft === null ? " selected" : ""}`}
            onClick={() => pick(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") pick(null);
            }}
          >
            <span className="transition-card-label">None (cut)</span>
            <span className="transition-card-hint">Hard cut — the project gets longer</span>
          </div>
          {TRANSITION_CATALOG.map((m) => (
            <div
              key={m.type}
              role="option"
              tabIndex={0}
              aria-selected={draft?.type === m.type}
              className={`transition-card${draft?.type === m.type ? " selected" : ""}`}
              onClick={() => pick(m.type)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") pick(m.type);
              }}
            >
              <span className="transition-card-label">{m.label}</span>
              <span className="transition-card-hint">{m.hint}</span>
            </div>
          ))}
        </div>

        <div className="transition-side">
          <TransitionPreview
            spec={draft}
            thumbA={fsUrlA}
            thumbB={fsUrlB}
            fallbackA={themeOut.colors}
            fallbackB={themeIn.colors}
          />

          {draft && (
            <div className="transition-params">
              <span className="seconds-field" title="Transition length in seconds">
                <input
                  className="modal-input seconds-input"
                  value={durationText}
                  inputMode="decimal"
                  aria-label="Transition duration in seconds"
                  onChange={(e) => setDurationText(e.target.value)}
                  onBlur={commitDuration}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setDurationText(durationSeconds);
                  }}
                />
                s
              </span>

              {meta?.needsDirection && (
                <span className="transition-directions">
                  {DIRECTION_OPTIONS.map((opt) => {
                    const active = (draft.direction ?? [1, 0]).join(",") === opt.value.join(",");
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        className={`btn btn-small${active ? " selected" : ""}`}
                        aria-pressed={active}
                        aria-label={opt.label}
                        title={opt.label}
                        onClick={() => setDraft({ ...draft, direction: opt.value })}
                      >
                        <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
                          <path
                            d={ARROWS[opt.label]}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                      </button>
                    );
                  })}
                </span>
              )}

              <span className="transition-ease" title="Progress feel">
                {EASE_OPTIONS.map((opt) => {
                  const active = (draft.ease ?? "linear") === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`btn btn-small${active ? " selected" : ""}`}
                      aria-pressed={active}
                      onClick={() => {
                        if (opt.id === "linear") {
                          const { ease: _drop, ...rest } = draft;
                          setDraft(rest);
                        } else {
                          setDraft({ ...draft, ease: opt.id });
                        }
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </span>

              {meta?.needsColor && (
                <span className="transition-dip">
                  <button
                    type="button"
                    className={`btn btn-small${draft.color ? "" : " selected"}`}
                    aria-pressed={!draft.color}
                    onClick={() => {
                      const { color: _drop, ...rest } = draft;
                      setDraft(rest);
                    }}
                  >
                    Theme background
                  </button>
                  <ColourPicker
                    value={draft.color ?? themeIn.colors.background}
                    label="Dip colour"
                    size="md"
                    defaultValue={themeIn.colors.background}
                    onReset={() => {
                      const { color: _drop, ...rest } = draft;
                      setDraft(rest);
                    }}
                    onCommit={(hex) => setDraft({ ...draft, color: hex })}
                  />
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="modal-error">{error}</p>}
    </>
  );

  const actions = (
    <>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="btn primary" onClick={apply} disabled={busy}>
        {busy ? "Applying…" : "Apply"}
      </button>
    </>
  );

  if (embedded)
    return (
      <>
        <div className="inspector-drill-body transition-embedded-body">{body}</div>
        <div className="inspector-drill-actions">{actions}</div>
      </>
    );
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Transition">
      <div className="modal wizard-wide transition-modal">
        <h2 className="modal-title">
          Transition out of scene {boundaryIndex + 1} — {sceneStem(project, boundaryIndex)}
        </h2>
        {body}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
