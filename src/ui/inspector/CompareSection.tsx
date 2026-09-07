import { COMPARE_GRIP_CATALOG, COMPARE_MASK_CATALOG } from "../../engine/content/compareCatalog";
import { COMPARE_PRESETS } from "../../engine/content/comparePresets";
import { useCompareEditStore } from "../../engine/edit/compareEditStore";
import type { Theme } from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import { DebouncedRange } from "../TextAnimationPicker";
import type { useSceneDocPatch } from "../useSceneDocPatch";
import {
  CompareGripIcon,
  CompareMaskIcon,
  CompareNoneIcon,
  ComparePresetIcon,
  CompareSwatchIcon,
  CompareToggleIcon,
} from "./compareIcons";
import {
  clearCompareTrack,
  nearestCompareKey,
  setCompareDividerAngle,
  setCompareDividerValue,
} from "./comparisonTarget";
import { TextControlIcon } from "./ManagedTextDrill";
import {
  DrillBack,
  DrillGroup,
  DrillHeaderAction,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
  ToggleRow,
} from "./rows";

type Patcher = ReturnType<typeof useSceneDocPatch>;

import type { RefObject } from "react";
import type { LoadedProject } from "../../engine/project";
import type { SceneDoc, SceneDocCompareGrip } from "../../engine/sceneDocSchema";

/** The comparison drill: presets, the divider and its animation, the mask family, chrome and tints (docs/comparisons.md). A SceneTab sibling section; the gesture refs stay in SceneTab because the divider lane shares them. */
export interface CompareSectionProps {
  backLabel: string;
  closeDrill: () => void;
  commitFromBaseline: Patcher["commitFromBaseline"];
  compareDragBaseline: RefObject<SceneDoc | null>;
  compareGestureMs: RefObject<number | null>;
  compareGripMemory: RefObject<SceneDocCompareGrip | null>;
  compareLocalMs: () => number;
  compareTargetKeyId: string | null;
  doc: SceneDoc;
  patchDoc: Patcher["patchDoc"];
  scene: LoadedProject["slots"][number];
  sceneTheme: Theme | undefined;
}

export function CompareSection({
  backLabel,
  closeDrill,
  commitFromBaseline,
  compareDragBaseline,
  compareGestureMs,
  compareGripMemory,
  compareLocalMs,
  compareTargetKeyId,
  doc,
  patchDoc,
  scene,
  sceneTheme,
}: CompareSectionProps) {
  if (!doc.compare) return null;
  const cmp = doc.compare;
  const patchCompare = (mutate: (c: NonNullable<SceneDoc["compare"]>) => void) =>
    void patchDoc((next) => {
      if (next.compare) mutate(next.compare);
    });
  const cmpLive = (mutate: (c: NonNullable<SceneDoc["compare"]>) => void) => {
    if (!compareDragBaseline.current && doc) compareDragBaseline.current = structuredClone(doc);
    void patchDoc(
      (next) => {
        if (next.compare) mutate(next.compare);
      },
      { history: false },
    );
  };
  const cmpCommit = (mutate: (c: NonNullable<SceneDoc["compare"]>) => void) => {
    const baseline = compareDragBaseline.current;
    compareDragBaseline.current = null;
    if (baseline)
      void commitFromBaseline(baseline, (next) => {
        if (next.compare) mutate(next.compare);
      });
    else patchCompare(mutate);
  };
  // A gesture that ends where it started commits nothing: put the baseline's comparison back and release it, so the NEXT commit can never build on a stale snapshot.
  const cmpAbort = () => {
    const baseline = compareDragBaseline.current;
    compareDragBaseline.current = null;
    compareGestureMs.current = null;
    if (!baseline) return;
    void patchDoc(
      (next) => {
        next.compare = structuredClone(baseline.compare);
      },
      { history: false },
    );
  };
  const maskType = cmp.mask?.type ?? "linear";
  const maskEntry = COMPARE_MASK_CATALOG.find((e) => e.id === maskType);
  const hasKeys = (cmp.track?.keys.length ?? 0) > 0;
  // The lane's committed draft outranks the doc in the compositor, so rewriting the keys releases it.
  const releaseTrackDraft = () => {
    const lane = useCompareEditStore.getState();
    lane.setDraft(null);
    lane.select(null, null);
  };
  const applyPreset = (preset: (typeof COMPARE_PRESETS)[number]) => {
    const track = preset.build(scene.durationMs);
    releaseTrackDraft();
    void patchDoc((next) => {
      if (!next.compare) return;
      next.compare.track = track;
    });
  };
  const clearKeys = () => {
    releaseTrackDraft();
    void patchDoc(clearCompareTrack, { history: "clear divider keys" });
  };
  const staticAngleDeg = cmp.mask?.angleDeg ?? 90;
  // The Divider and Angle fields edit the key nearest the playhead (the static value and angle with none), frozen mid-gesture on the key the writes are pinned to so a running clock can't hop them, and never release the lane's draft: the patched project clears a committed one on its own.
  const targetKey =
    (compareGestureMs.current !== null
      ? nearestCompareKey(cmp.track?.keys, compareGestureMs.current)
      : cmp.track?.keys.find((k) => k.id === compareTargetKeyId)) ?? null;
  const dividerValue = targetKey?.pose.value ?? cmp.value ?? 0.5;
  const dividerAngleDeg = targetKey?.pose.angleDeg ?? staticAngleDeg;
  const gestureMs = () => (compareGestureMs.current ??= compareLocalMs());
  const releaseGestureMs = () => {
    const ms = gestureMs();
    compareGestureMs.current = null;
    return ms;
  };
  const keyHint = hasKeys ? "Edits the divider key nearest the playhead" : undefined;
  const grip = cmp.chrome?.grip;
  const gripObject = typeof grip === "object" ? grip : undefined;
  const lineColour = resolveCompareColour(cmp.chrome?.line?.colour, sceneTheme);
  // Each token wears its resolved colour, so the choice is the swatch rather than the word.
  const tintOptions: SegmentedOption<CompareTint>[] = [
    { value: "none", label: "None", title: "No tint", icon: <CompareNoneIcon size={14} /> },
    ...COMPARE_TINT_TOKENS.map((token) => ({
      value: token,
      label: `${token[0].toUpperCase()}${token.slice(1)}`,
      title: `Tint the after side with the theme's ${token} colour`,
      icon: <CompareSwatchIcon colour={resolveCompareColour(token, sceneTheme)} size={14} />,
    })),
  ];
  return (
    <div className="inspector-drill">
      <DrillBack
        label={backLabel}
        title="Comparison"
        onClick={closeDrill}
        actions={
          <DrillHeaderAction
            kind="remove"
            label="Remove comparison"
            onClick={() => {
              void patchDoc((next) => {
                next.compare = undefined;
                if (next.animatedTrack === "compare") next.animatedTrack = undefined;
              });
              closeDrill();
            }}
          />
        }
      />
      <div className="inspector-drill-body">
        <SegmentedRow
          ariaLabel="Comparison mask"
          className="subtabs-compact"
          options={COMPARE_MASK_CATALOG.map((e) => ({
            value: e.id,
            label: e.label,
            title: e.hint,
            icon: <CompareMaskIcon id={e.id} size={14} />,
          }))}
          value={maskType}
          onChange={(id) =>
            patchCompare((c) => {
              c.mask = { ...(c.mask ?? {}), type: id };
            })
          }
        />
        {maskEntry?.needsAngle && (
          <div className="popover-row">
            <span className="popover-inline slider-row-label" title={keyHint}>
              Angle
            </span>
            <NumberField
              label="Divider angle"
              value={dividerAngleDeg}
              decimals={0}
              min={0}
              max={360}
              step={1}
              onInput={(v) => {
                const ms = gestureMs();
                cmpLive((c) => setCompareDividerAngle(c, ms, v));
              }}
              onCommit={(v) => {
                const ms = releaseGestureMs();
                cmpCommit((c) => setCompareDividerAngle(c, ms, v));
              }}
              onDragEnd={(committed) => {
                if (!committed) cmpAbort();
              }}
            />
          </div>
        )}
        {maskEntry?.needsCenter && (
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Centre</span>
            <NumberField
              label="Centre X"
              value={cmp.mask?.center?.[0] ?? 0.5}
              decimals={2}
              min={0}
              max={1}
              step={0.01}
              onCommit={(v) =>
                patchCompare((c) => {
                  c.mask = {
                    ...(c.mask ?? { type: maskType }),
                    center: [v, c.mask?.center?.[1] ?? 0.5],
                  };
                })
              }
            />
            <NumberField
              label="Centre Y"
              value={cmp.mask?.center?.[1] ?? 0.5}
              decimals={2}
              min={0}
              max={1}
              step={0.01}
              onCommit={(v) =>
                patchCompare((c) => {
                  c.mask = {
                    ...(c.mask ?? { type: maskType }),
                    center: [c.mask?.center?.[0] ?? 0.5, v],
                  };
                })
              }
            />
          </div>
        )}
        {maskEntry?.hasSoftness && (
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Edge softness</span>
            <DebouncedRange
              value={cmp.mask?.softness ?? 0}
              min={0}
              max={0.2}
              step={0.005}
              label="Edge softness"
              onInput={(v) =>
                cmpLive((c) => {
                  c.mask = { ...(c.mask ?? { type: maskType }), softness: v };
                })
              }
              onCommit={(v) =>
                cmpCommit((c) => {
                  c.mask = { ...(c.mask ?? { type: maskType }), softness: v };
                })
              }
            />
          </div>
        )}
        <div className="popover-row">
          <span className="popover-inline slider-row-label" title={keyHint}>
            Divider
          </span>
          <DebouncedRange
            value={dividerValue}
            min={0}
            max={1}
            step={0.01}
            label="Divider position"
            onInput={(v) => {
              const ms = gestureMs();
              cmpLive((c) => setCompareDividerValue(c, ms, v));
            }}
            onCommit={(v) => {
              const ms = releaseGestureMs();
              cmpCommit((c) => setCompareDividerValue(c, ms, v));
            }}
          />
        </div>
        <DrillGroup label="Motion presets" hint="Writes keys you can hand-tune in the lane.">
          <div className="wizard-presets">
            <button
              type="button"
              className="chip compare-preset-chip"
              title="Clears the keys and brings back the static Divider slider"
              disabled={!hasKeys}
              onClick={clearKeys}
            >
              <ComparePresetIcon id="manual" size={14} />
              Manual
            </button>
            {COMPARE_PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className="chip compare-preset-chip"
                title={p.hint}
                onClick={() => applyPreset(p)}
              >
                <ComparePresetIcon id={p.id} size={14} />
                {p.label}
              </button>
            ))}
          </div>
        </DrillGroup>
        {(maskEntry?.hasLine || maskEntry?.hasGrip) && (
          <DrillGroup label="Divider line">
            {maskEntry?.hasLine && (
              <ToggleRow
                icon={<CompareToggleIcon id="line" size={17} />}
                label="Show line"
                checked={!!cmp.chrome?.line}
                onChange={(on) =>
                  patchCompare((c) => {
                    c.chrome = {
                      ...c.chrome,
                      line: on ? { width: 4, colour: "accent" } : undefined,
                    };
                  })
                }
              />
            )}
            {maskEntry?.hasLine && cmp.chrome?.line && (
              <>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Width</span>
                  <DebouncedRange
                    value={cmp.chrome.line.width ?? 4}
                    min={1}
                    max={12}
                    step={0.5}
                    label="Line width"
                    onInput={(v) =>
                      cmpLive((c) => {
                        if (c.chrome?.line) c.chrome.line.width = v;
                      })
                    }
                    onCommit={(v) =>
                      cmpCommit((c) => {
                        if (c.chrome?.line) c.chrome.line.width = v;
                      })
                    }
                  />
                </div>
                <div className="popover-row text-inspector-colour-row">
                  <span className="action-row-icon">
                    <TextControlIcon type="colour" />
                  </span>
                  <span className="popover-inline">Colour</span>
                  <span className="action-row-value">{lineColour.toUpperCase()}</span>
                  <ColourPicker
                    value={lineColour}
                    defaultValue={resolveCompareColour("accent", sceneTheme)}
                    label="Divider colour"
                    theme={sceneTheme}
                    onCommit={(hex) =>
                      patchCompare((c) => {
                        if (c.chrome?.line) c.chrome.line.colour = hex;
                      })
                    }
                    // Reset restores the accent TOKEN, so the divider follows the theme again.
                    onReset={
                      cmp.chrome.line.colour && cmp.chrome.line.colour !== "accent"
                        ? () =>
                            patchCompare((c) => {
                              if (c.chrome?.line) c.chrome.line.colour = "accent";
                            })
                        : undefined
                    }
                  />
                </div>
              </>
            )}
            {maskEntry?.hasGrip && (
              <ToggleRow
                icon={<CompareToggleIcon id="grip" size={17} />}
                label="Grip handle"
                description="The slider grip riding the divider."
                checked={!!grip}
                onChange={(on) => {
                  if (!on && gripObject) compareGripMemory.current = structuredClone(gripObject);
                  const remembered = on ? compareGripMemory.current : null;
                  patchCompare((c) => {
                    c.chrome = {
                      ...c.chrome,
                      grip: on ? (remembered ? structuredClone(remembered) : true) : undefined,
                    };
                  });
                }}
              />
            )}
            {maskEntry?.hasGrip && grip && (
              <SegmentedRow
                ariaLabel="Grip style"
                className="subtabs-compact"
                options={COMPARE_GRIP_CATALOG.map((e) => ({
                  value: e.id,
                  label: e.label,
                  title: e.hint,
                  icon: <CompareGripIcon id={e.id} size={14} />,
                }))}
                value={gripObject?.style ?? "chevrons"}
                onChange={(style) =>
                  patchCompare((c) => {
                    const current = typeof c.chrome?.grip === "object" ? c.chrome.grip : undefined;
                    c.chrome = {
                      ...c.chrome,
                      grip:
                        style === "chevrons" && current?.size === undefined
                          ? true
                          : { ...current, style },
                    };
                  })
                }
              />
            )}
          </DrillGroup>
        )}
        <DrillGroup label="Labels">
          <ToggleRow
            icon={<CompareToggleIcon id="chips" size={17} />}
            label="Before / after chips"
            description="Label chips pinned to each half (text keys beforeLabel and afterLabel)."
            checked={cmp.chrome?.chips === true}
            onChange={(on) =>
              patchCompare((c) => {
                c.chrome = { ...c.chrome, chips: on ? true : undefined };
              })
            }
          />
        </DrillGroup>
        <DrillGroup label="After tint">
          <SegmentedRow
            ariaLabel="After tint"
            className="subtabs-compact"
            options={tintOptions}
            value={(cmp.chrome?.tint?.b ?? "none") as CompareTint}
            onChange={(t) =>
              patchCompare((c) => {
                c.chrome = {
                  ...c.chrome,
                  tint:
                    t === "none"
                      ? undefined
                      : { ...c.chrome?.tint, b: t, amount: c.chrome?.tint?.amount ?? 0.08 },
                };
              })
            }
          />
          {cmp.chrome?.tint?.b && (
            <div className="popover-row">
              <span className="popover-inline slider-row-label">Amount</span>
              <DebouncedRange
                value={cmp.chrome.tint.amount ?? 0.08}
                min={0}
                max={0.3}
                step={0.01}
                label="Tint amount"
                onInput={(v) =>
                  cmpLive((c) => {
                    if (c.chrome?.tint) c.chrome.tint.amount = v;
                  })
                }
                onCommit={(v) =>
                  cmpCommit((c) => {
                    if (c.chrome?.tint) c.chrome.tint.amount = v;
                  })
                }
              />
            </div>
          )}
        </DrillGroup>
        <p className="inspector-stub-note">
          Use the Before and After toggles in Device, Theme, Background and Lighting to edit each
          side.
        </p>
      </div>
    </div>
  );
}

/** The divider colour as the picker shows it, mirroring `compareSpecOf`: an authored `#rrggbb` passes through, a theme token resolves against the scene's theme, and anything else falls back to the accent. */
function resolveCompareColour(colour: string | undefined, theme: Theme | undefined): string {
  if (colour && /^#[0-9a-f]{6}$/i.test(colour)) return colour.toLowerCase();
  const colours = theme?.colors as unknown as Record<string, string> | undefined;
  return (colour && colours?.[colour]) || theme?.colors.accent || "#6f93a8";
}

/** The theme tokens the After tint offers, each shown as its resolved swatch. */
const COMPARE_TINT_TOKENS = ["accent", "text", "muted"] as const;

type CompareTint = "none" | (typeof COMPARE_TINT_TOKENS)[number];
