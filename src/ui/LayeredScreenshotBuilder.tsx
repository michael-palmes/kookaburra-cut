import { useEffect, useMemo, useState } from "react";
import { useClockStore } from "../engine/clock";
import {
  addItem,
  addLayer,
  layersInOrder,
  moveLayer,
  nextItemId,
  removeItem,
  removeLayer,
  updateItem,
  updateLayer,
} from "../engine/layeredScreenshotEdit";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import {
  DEFAULT_ITEM_GAP,
  solveLayerLayout,
  type SolvedLayerLayout,
} from "../engine/layeredScreenshotLayout";
import type { LoadedProject } from "../engine/project";
import { workspaceProjectPath, workspaceSlug } from "../engine/project";
import type {
  LayeredScreenshotAttachSide,
  LayeredScreenshotItem,
  LayeredScreenshotLayer,
  SceneDoc,
  SceneDocLayeredScreenshot,
} from "../engine/sceneDocSchema";
import type { MediaMeta } from "../engine/media";
import { useFormat } from "../engine/format";
import {
  expandToIsometric,
  flattenToFrontOn,
  ISO_AZIMUTH_DEG,
  ISO_ELEVATION_DEG,
  slowDrift,
  zoomToItem,
} from "../engine/layeredScreenshotPresets";
import { fitStackScale } from "../engine/layeredScreenshotLayout";
import { useLayeredScreenshotDoc } from "./layeredScreenshotDoc";
import { MediaBrowser } from "./MediaBrowser";
import { useEscapeClose } from "./useEscapeClose";
import { useSceneDocPatch } from "./useSceneDocPatch";

/** The layered-screenshot builder: a full-height sub-panel docked on the RIGHT beside the inspector, over the live stage (Michael's 2026-07-20 revision of the original left-dock call; still no scrim, no second canvas, the stage is the preview). Layer list, a 2D chain schematic of the selected layer with plus-buttons on free sides, an inline item inspector, the front-on/isometric snap and the spread slider. Every gesture commits through the `useLayeredScreenshotDoc` funnel; closing just hides the panel. */

const SIDES: LayeredScreenshotAttachSide[] = ["left", "right", "top", "bottom"];

/** Sides of `itemId` nothing occupies: neither a child attached there nor its own parent hanging on that side. */
function freeSides(layer: LayeredScreenshotLayer, itemId: string): LayeredScreenshotAttachSide[] {
  const item = layer.items.find((i) => i.id === itemId);
  if (!item) return [];
  const taken = new Set<LayeredScreenshotAttachSide>();
  if (item.attach) {
    const opposite: Record<LayeredScreenshotAttachSide, LayeredScreenshotAttachSide> = {
      left: "right",
      right: "left",
      top: "bottom",
      bottom: "top",
    };
    taken.add(opposite[item.attach.side]);
  }
  for (const other of layer.items) {
    if (other.attach?.to === itemId) taken.add(other.attach.side);
  }
  return SIDES.filter((s) => !taken.has(s));
}

function itemLabel(item: LayeredScreenshotItem, text: Record<string, string> | undefined): string {
  if (item.kind === "text") return text?.[`ls-${item.id}`] || "Text";
  return item.src.replace(/^assets\//, "");
}

export function LayeredScreenshotBuilder({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const open = useLayeredScreenshotEditStore((s) => s.open);
  const selectedLayerId = useLayeredScreenshotEditStore((s) => s.selectedLayerId);
  const selectedItemId = useLayeredScreenshotEditStore((s) => s.selectedItemId);
  const writeError = useLayeredScreenshotEditStore((s) => s.writeError);
  const format = useFormat();
  const { block, preview, commit, appliedPoseAt } = useLayeredScreenshotDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  // Text strings live in doc.text, outside the block; they route through the standard patch funnel.
  const { doc, patchDoc } = useSceneDocPatch(project, sceneIndex, onDocChanged, () => {});
  const select = useLayeredScreenshotEditStore.getState().select;

  const ordered = useMemo(() => layersInOrder(block), [block]);
  // Display front-most first (the design-tool convention); `ordered` is back to front.
  const displayLayers = useMemo(() => [...ordered].reverse(), [ordered]);
  const layer = ordered.find((l) => l.id === selectedLayerId) ?? ordered[ordered.length - 1];
  const item = layer?.items.find((i) => i.id === selectedItemId) ?? null;

  // Keep the selection valid as layers come and go.
  useEffect(() => {
    if (!open) return;
    if (layer && layer.id !== selectedLayerId) select(layer.id, null);
  }, [open, layer, selectedLayerId, select]);

  const [adding, setAdding] = useState<
    | { mode: "add"; toId: string | null; side: LayeredScreenshotAttachSide }
    | { mode: "change" }
    | null
  >(null);
  // Spread slider: preview while dragging, one commit on release.
  const [spreadDraft, setSpreadDraft] = useState<number | null>(null);
  useEscapeClose(() => setAdding(null), adding !== null);

  // A block with no layers still opens: seed the first layer so the panel is never a dead end.
  const empty = ordered.length === 0;
  useEffect(() => {
    if (open && empty) void commit(addLayer(block));
  }, [open, empty, commit, block]);

  if (!open || !layer) return null;

  const slug = workspaceSlug(project.id);
  const projectPath = workspaceProjectPath(slug) ?? "";
  const layout: SolvedLayerLayout = solveLayerLayout(layer, []);

  const commitBlock = (next: SceneDocLayeredScreenshot | null) => {
    if (next) void commit(next);
  };

  const setPose = (patch: Partial<SceneDocLayeredScreenshot["pose"]>) =>
    commitBlock({ ...block, pose: { ...block.pose, ...patch } });

  const addScreen = (rel: string, meta: MediaMeta | null) => {
    if (adding?.mode !== "add") return;
    const id = nextItemId(block);
    const next = addItem(block, layer.id, {
      id,
      kind: "screen",
      src: rel,
      media: meta?.kind === "video" ? "video" : "image",
      attach: adding.toId ? { to: adding.toId, side: adding.side } : null,
    });
    setAdding(null);
    if (next) {
      commitBlock(next);
      select(layer.id, id);
    }
  };

  const addText = () => {
    if (adding?.mode !== "add") return;
    const id = nextItemId(block);
    const next = addItem(block, layer.id, {
      id,
      kind: "text",
      attach: adding.toId ? { to: adding.toId, side: adding.side } : null,
    });
    setAdding(null);
    if (next) {
      commitBlock(next);
      select(layer.id, id);
      void patchDoc((d) => {
        d.text = { ...d.text, [`ls-${id}`]: "Label" };
      });
    }
  };

  // Schematic scale: fit the solved layout into the panel's drawing area.
  const SCHEM_W = 264;
  const SCHEM_H = 190;
  const PAD = 26;
  const scale =
    layout.width > 0 && layout.height > 0
      ? Math.min((SCHEM_W - PAD * 2) / layout.width, (SCHEM_H - PAD * 2) / layout.height)
      : 1;

  const front = ordered[ordered.length - 1]?.id === layer.id;
  const back = ordered[0]?.id === layer.id;
  const spread = spreadDraft ?? block.pose.spread;
  const frontOn = Math.abs(block.pose.azimuthDeg) < 0.5 && Math.abs(block.pose.elevationDeg) < 0.5;

  return (
    <aside className="ls-builder" aria-label="Screenshot stack builder">
      <div className="ls-builder-head">
        <h2>Screenshot stack</h2>
        <button
          type="button"
          className="toast-close"
          aria-label="Close the builder"
          onClick={() => useLayeredScreenshotEditStore.getState().setOpen(false)}
        >
          ×
        </button>
      </div>

      <div className="ls-builder-section">
        <div className="wizard-presets">
          <button
            type="button"
            className={`chip${frontOn ? " selected" : ""}`}
            title="Snap the stack front-on"
            onClick={() => setPose({ azimuthDeg: 0, elevationDeg: 0 })}
          >
            Front-on
          </button>
          <button
            type="button"
            className={`chip${frontOn ? "" : " selected"}`}
            title="Snap the stack to the isometric view"
            onClick={() =>
              setPose({ azimuthDeg: ISO_AZIMUTH_DEG, elevationDeg: ISO_ELEVATION_DEG })
            }
          >
            Isometric
          </button>
        </div>
        <label className="ls-builder-spread">
          <span>Spread</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={spread}
            aria-label="Layer spread"
            onChange={(e) => {
              const v = Number(e.target.value);
              setSpreadDraft(v);
              preview({ ...block, pose: { ...block.pose, spread: v } }, false);
            }}
            onPointerUp={() => {
              if (spreadDraft !== null) setPose({ spread: spreadDraft });
              setSpreadDraft(null);
            }}
            onKeyUp={() => {
              if (spreadDraft !== null) setPose({ spread: spreadDraft });
              setSpreadDraft(null);
            }}
          />
          <span className="ls-builder-readout">{Math.round(spread * 100)}%</span>
        </label>
      </div>

      <div className="ls-builder-section">
        <div className="ls-builder-row-head">
          <span>Layers</span>
          <button
            type="button"
            className="btn btn-small"
            title="Add an empty layer at the front"
            onClick={() => commitBlock(addLayer(block))}
          >
            ＋ Layer
          </button>
        </div>
        <ul className="ls-layer-list">
          {displayLayers.map((l) => (
            <li key={l.id}>
              {/* biome-ignore lint/a11y/useSemanticElements: the row hosts nested buttons (eye, reorder, delete), which a real <button> cannot */}
              <div
                className={`ls-layer-row${l.id === layer.id ? " selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => select(l.id, null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select(l.id, null);
                  }
                }}
              >
                <button
                  type="button"
                  className={`ls-layer-eye${l.visible ? "" : " off"}`}
                  aria-label={l.visible ? `Hide ${l.name ?? l.id}` : `Show ${l.name ?? l.id}`}
                  title={l.visible ? "Hide layer" : "Show layer"}
                  onClick={(e) => {
                    e.stopPropagation();
                    commitBlock(updateLayer(block, l.id, { visible: !l.visible }));
                  }}
                >
                  {l.visible ? "●" : "○"}
                </button>
                <span className="ls-layer-name">
                  {l.name ?? `Layer ${ordered.findIndex((o) => o.id === l.id) + 1}`}
                </span>
                <span className="ls-layer-count">{l.items.length}</span>
                {l.id === layer.id && (
                  <span className="ls-layer-tools">
                    <button
                      type="button"
                      className="ls-layer-tool"
                      title="Bring forward"
                      aria-label="Bring layer forward"
                      disabled={front}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitBlock(moveLayer(block, l.id, 1));
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ls-layer-tool"
                      title="Send back"
                      aria-label="Send layer back"
                      disabled={back}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitBlock(moveLayer(block, l.id, -1));
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="ls-layer-tool danger"
                      title="Delete layer"
                      aria-label="Delete layer"
                      disabled={ordered.length === 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitBlock(removeLayer(block, l.id));
                      }}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="ls-builder-section">
        <div className="ls-builder-row-head">
          <span>Chain</span>
          <span className="muted ls-builder-hint">＋ on a free side extends the strip</span>
        </div>
        <div className="ls-schematic" style={{ width: SCHEM_W, height: SCHEM_H }}>
          {layer.items.length === 0 ? (
            <button
              type="button"
              className="btn primary ls-schematic-seed"
              onClick={() => setAdding({ mode: "add", toId: null, side: "right" })}
            >
              ＋ First screen
            </button>
          ) : (
            layout.items.map((rect) => {
              const it = layer.items.find((i) => i.id === rect.id);
              if (!it) return null;
              const w = Math.max(26, rect.width * scale);
              const h = Math.max(20, rect.height * scale);
              const cx = SCHEM_W / 2 + rect.x * scale;
              const cy = SCHEM_H / 2 - rect.y * scale;
              return (
                // biome-ignore lint/a11y/useSemanticElements: the box hosts the nested plus-buttons, which a real <button> cannot
                <div
                  key={rect.id}
                  className={`ls-schem-item${it.id === selectedItemId ? " selected" : ""}${
                    it.kind === "text" ? " text" : ""
                  }`}
                  style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h }}
                  role="button"
                  tabIndex={0}
                  title={itemLabel(it, doc?.text)}
                  onClick={() => select(layer.id, it.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      select(layer.id, it.id);
                    }
                  }}
                >
                  <span>{itemLabel(it, doc?.text)}</span>
                  {freeSides(layer, it.id).map((side) => (
                    <button
                      type="button"
                      key={side}
                      className={`ls-schem-plus ${side}`}
                      aria-label={`Add an item ${side} of ${itemLabel(it, doc?.text)}`}
                      title={`Add ${side}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAdding({ mode: "add", toId: it.id, side });
                      }}
                    >
                      ＋
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="ls-builder-section">
        <div className="ls-builder-row-head">
          <span>Animate</span>
          <span className="muted ls-builder-hint">scaffolds editable keys in the lane</span>
        </div>
        <div className="wizard-presets">
          {(() => {
            const slot = project.slots[sceneIndex];
            const applyPreset = (
              animation: NonNullable<SceneDocLayeredScreenshot["animation"]>,
            ) => {
              void patchDoc((d) => {
                d.layeredScreenshot = { ...block, animation };
                d.animatedTrack = "layeredScreenshot";
              }).then(() => {
                const state = useLayeredScreenshotEditStore.getState();
                state.setLaneOpen(true);
                state.selectKey(null, null);
              });
            };
            const seed = () => {
              const local = Math.min(
                slot.durationMs,
                Math.max(0, useClockStore.getState().currentMs - slot.startMs),
              );
              return appliedPoseAt(local);
            };
            const zoomRect = item ? layout.items.find((r) => r.id === item.id) : undefined;
            const visible = ordered.filter((l) => l.visible && l.items.length > 0);
            const fit = fitStackScale(
              visible.map((l) => solveLayerLayout(l, [])),
              format.frame.width - format.safe.left - format.safe.right,
              format.frame.height - format.safe.top - format.safe.bottom,
            );
            return (
              <>
                <button
                  type="button"
                  className="chip"
                  title="Fan the stack out to the isometric view over 1.2s"
                  onClick={() => applyPreset(expandToIsometric(seed(), slot.durationMs))}
                >
                  Expand to isometric
                </button>
                <button
                  type="button"
                  className="chip"
                  title="Collapse to the flat, front-on stack over 1.2s"
                  onClick={() => applyPreset(flattenToFrontOn(seed(), slot.durationMs))}
                >
                  Flatten
                </button>
                <button
                  type="button"
                  className="chip"
                  title={
                    zoomRect
                      ? "Push in on the selected screen over 1s"
                      : "Select an item in the chain first"
                  }
                  disabled={!zoomRect}
                  onClick={() =>
                    zoomRect &&
                    applyPreset(
                      zoomToItem(
                        seed(),
                        zoomRect,
                        fit,
                        format.frame.width - format.safe.left - format.safe.right,
                        format.frame.height - format.safe.top - format.safe.bottom,
                        slot.durationMs,
                      ),
                    )
                  }
                >
                  Zoom to screen
                </button>
                <button
                  type="button"
                  className="chip"
                  title="A slow closed drift loop; slideshow holds repeat it seamlessly"
                  onClick={() => applyPreset(slowDrift(seed(), slot.durationMs))}
                >
                  Slow drift
                </button>
              </>
            );
          })()}
        </div>
      </div>

      {item && (
        <div className="ls-builder-section">
          <div className="ls-builder-row-head">
            <span>{item.kind === "text" ? "Text item" : "Screen"}</span>
            <button
              type="button"
              className="ls-layer-tool danger"
              title="Remove this item (children re-chain)"
              aria-label="Remove item"
              onClick={() => {
                commitBlock(removeItem(block, layer.id, item.id));
                select(layer.id, null);
              }}
            >
              ✕
            </button>
          </div>
          {item.kind === "text" ? (
            <input
              className="modal-input"
              value={doc?.text?.[`ls-${item.id}`] ?? ""}
              placeholder="Label"
              aria-label="Text item content"
              onChange={(e) =>
                void patchDoc(
                  (d) => {
                    d.text = { ...d.text, [`ls-${item.id}`]: e.target.value };
                  },
                  { history: false },
                )
              }
            />
          ) : (
            <button
              type="button"
              className="btn ls-builder-wide"
              onClick={() => setAdding({ mode: "change" })}
              title="Replace this screen's media"
            >
              Change media…
            </button>
          )}
          <div className="ls-builder-fields">
            <label className="ls-builder-field">
              <span>Gap</span>
              <input
                className="modal-input"
                type="number"
                step={0.05}
                min={0}
                value={item.gap ?? layer.gap ?? DEFAULT_ITEM_GAP}
                aria-label="Gap to the attached neighbour, world units"
                onChange={(e) => {
                  const gap = Math.max(0, Number(e.target.value) || 0);
                  commitBlock(updateItem(block, layer.id, item.id, { gap }));
                }}
              />
            </label>
            {item.kind === "screen" && (
              <label className="popover-inline ls-builder-field">
                <input
                  type="checkbox"
                  checked={item.flat ?? layer.flat ?? false}
                  onChange={(e) =>
                    commitBlock(updateItem(block, layer.id, item.id, { flat: e.target.checked }))
                  }
                />
                Flat (no card)
              </label>
            )}
          </div>
        </div>
      )}

      {writeError && (
        <div className="anim-lane-error" role="alert">
          Save failed, this stack edit isn’t on disk: {writeError}
        </div>
      )}

      {adding && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal wizard-wide">
            <h2>{adding.mode === "change" ? "Change media" : "Add to the stack"}</h2>
            <div className="wizard-media-host">
              <MediaBrowser
                slug={slug}
                projectPath={projectPath}
                kindToggle
                kindDefault="image"
                globalToggle
                onPick={(rel, meta) => {
                  if (adding.mode === "change" && item?.kind === "screen") {
                    // Change-media path: swap the selected screen's source in place.
                    const next = updateItem(block, layer.id, item.id, {
                      src: rel,
                      media: meta?.kind === "video" ? "video" : "image",
                    });
                    setAdding(null);
                    commitBlock(next);
                  } else {
                    addScreen(rel, meta);
                  }
                }}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setAdding(null)}>
                Cancel
              </button>
              {adding.mode === "add" && (
                <button
                  type="button"
                  className="btn"
                  title="Add a theme-typed text label instead of a screen"
                  onClick={addText}
                >
                  Add text instead
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
