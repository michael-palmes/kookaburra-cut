import { useRef } from "react";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  resolveLighting,
  resolveLightingColour,
  SUN_ANGULAR_REFERENCE,
  sunShadowSoftness,
} from "../../engine/sceneLighting";
import type {
  LightingSpec,
  SunSpec,
  Theme,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import { DebouncedRange } from "../TextAnimationPicker";
import { ActionRow, DrillBack, DrillGroup, NumberField, ToggleRow } from "./rows";

/** The Lighting drill-in (v9 · PR 1): edits the subset v8 already renders (sun, ambient, fills, shadow) against the resolved theme -> project -> scene layers. Inherited values render from the resolve, never written on open (writing on open would diff every scene the user merely looked at); each edit writes its WHOLE field into the sidecar (the mergeLighting whole-field contract). Environment is a read-only summary until PR 3; the free-light list arrives in PR 2. */

/** Seed rig for "Light this scene" on an unlit theme: the soft-studio starting point. */
const DEFAULT_SUN: SunSpec = { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8 };
const DEFAULT_AMBIENT = 0.4;
const DEFAULT_SHADOW: ThemeShadowSpec = {
  technique: "map",
  softness: 0.5,
  opacity: 0.3,
  mapSize: 2048,
  bias: -0.0005,
};
const MAP_SIZES = [1024, 2048, 4096];

/** Which layer a field currently comes from, for the group hints ("From theme" placeholders). */
function fieldSource(
  field: keyof LightingSpec,
  doc: LightingSpec | undefined,
  project: LightingSpec | undefined,
): string | undefined {
  if (doc?.[field] !== undefined) return undefined;
  if (project?.[field] !== undefined) return "From project";
  return "From theme";
}

export function LightingSectionBody({
  doc,
  theme,
  projectLighting,
  onBack,
  patchDoc,
  commitFromBaseline,
}: {
  doc: SceneDoc;
  theme: Theme;
  projectLighting: LightingSpec | undefined;
  onBack: () => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
}) {
  const resolved = resolveLighting(theme.lighting, projectLighting, doc.lighting);
  const dragBaseline = useRef<SceneDoc | null>(null);

  // Live slider ticks write history-less; the release records one entry from the drag-start snapshot (the video-window pattern).
  const live = (mutate: (next: SceneDoc) => void) => {
    if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
    void patchDoc(mutate, { history: false });
  };
  const commit = (mutate: (next: SceneDoc) => void) => {
    const baseline = dragBaseline.current;
    dragBaseline.current = null;
    if (baseline) void commitFromBaseline(baseline, mutate);
    else void patchDoc(mutate);
  };

  // Each writer patches the WHOLE field from the resolved base (whole-field replacement), so a first edit on an inherited value captures the base rather than a partial fragment.
  const writeSun =
    (mutate: (s: SunSpec) => void) =>
    (next: SceneDoc): void => {
      const sun = structuredClone(resolved?.sun ?? DEFAULT_SUN);
      mutate(sun);
      next.lighting = { ...(next.lighting ?? {}), sun };
    };
  const writeAmbient =
    (value: number) =>
    (next: SceneDoc): void => {
      next.lighting = { ...(next.lighting ?? {}), ambient: value };
    };
  const writeFills =
    (mutate: (fills: ThemeLightSpec[]) => void) =>
    (next: SceneDoc): void => {
      const fills = structuredClone(resolved?.fills ?? []);
      mutate(fills);
      next.lighting = { ...(next.lighting ?? {}), fills };
    };
  const writeShadow =
    (mutate: (s: ThemeShadowSpec) => void) =>
    (next: SceneDoc): void => {
      const shadow = structuredClone(resolved?.shadow ?? DEFAULT_SHADOW);
      mutate(shadow);
      next.lighting = { ...(next.lighting ?? {}), shadow };
    };

  const sun = resolved?.sun;
  const shadow = resolved?.shadow;
  const sunSwatch = sun ? resolveLightingColour(sun, theme.colors) : "#ffffff";
  const angularDisplay = sun?.angularDeg ?? sunShadowSoftness(sun, shadow) * SUN_ANGULAR_REFERENCE;
  const environment = doc.lighting?.environment ?? theme.environment;
  const environmentLabel = environment
    ? environment.source === "none"
      ? "None"
      : environment.source.replace(/^kookaburra:/, "").replace(/-/g, " ")
    : "None";

  return (
    <div className="inspector-drill">
      <DrillBack label="Scene" onClick={onBack} />
      <div className="inspector-drill-title">Lighting</div>
      <div className="inspector-drill-body inspector-section-body">
        {!resolved ? (
          <>
            <p className="modal-hint">
              This scene isn't lit: its theme has no lighting and nothing overrides it. Lighting the
              scene stands the primitives' bundled rigs down and lights them from here.
            </p>
            <ActionRow
              label="Light this scene"
              chevron={false}
              onClick={() =>
                commit((next) => {
                  next.lighting = {
                    ...(next.lighting ?? {}),
                    sun: structuredClone(DEFAULT_SUN),
                    ambient: DEFAULT_AMBIENT,
                  };
                })
              }
            />
          </>
        ) : (
          <>
            <DrillGroup label="Environment">
              {/* Read-only this PR; the picker + intensity/rotation arrive with the HDRI expansion. */}
              <ActionRow label="Reflections" value={environmentLabel} chevron={false} />
            </DrillGroup>

            <DrillGroup label="Sun" hint={fieldSource("sun", doc.lighting, projectLighting)}>
              {sun ? (
                <>
                  <DebouncedRange
                    label="Azimuth"
                    value={sun.azimuthDeg}
                    min={-180}
                    max={180}
                    step={1}
                    onInput={(n) => live(writeSun((s) => (s.azimuthDeg = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.azimuthDeg = n)))}
                  />
                  <DebouncedRange
                    label="Elevation"
                    value={sun.elevationDeg}
                    min={-90}
                    max={90}
                    step={1}
                    onInput={(n) => live(writeSun((s) => (s.elevationDeg = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.elevationDeg = n)))}
                  />
                  <DebouncedRange
                    label="Intensity"
                    value={sun.intensity}
                    min={0}
                    max={6}
                    step={0.05}
                    onInput={(n) => live(writeSun((s) => (s.intensity = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.intensity = n)))}
                  />
                  <DebouncedRange
                    label="Angular size °"
                    value={angularDisplay}
                    min={0}
                    max={16}
                    step={0.1}
                    onInput={(n) => live(writeSun((s) => (s.angularDeg = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.angularDeg = n)))}
                  />
                  <div className="lighting-kelvin-row">
                    <span
                      className="lighting-kelvin-swatch"
                      style={{ background: sunSwatch }}
                      title={sun.kelvin !== undefined ? `${sun.kelvin} K` : "Theme colour"}
                    />
                    <DebouncedRange
                      label="Temperature K"
                      value={sun.kelvin ?? 6500}
                      min={1000}
                      max={20000}
                      step={100}
                      onInput={(n) => live(writeSun((s) => (s.kelvin = n)))}
                      onCommit={(n) => commit(writeSun((s) => (s.kelvin = n)))}
                    />
                  </div>
                  {sun.kelvin !== undefined && (
                    <ActionRow
                      label="Use the theme's sun colour"
                      chevron={false}
                      onClick={() =>
                        commit(
                          writeSun((s) => {
                            delete s.kelvin;
                          }),
                        )
                      }
                    />
                  )}
                  <ToggleRow
                    label="Sun enabled"
                    description="Off keeps the sun's settings without lighting anything."
                    checked={sun.enabled !== false}
                    onChange={(on) => commit(writeSun((s) => (s.enabled = on ? undefined : false)))}
                  />
                  <ToggleRow
                    label="Cast shadows"
                    description="Real shadow maps need a floor or backdrop staged."
                    checked={sun.castShadow !== false}
                    onChange={(on) =>
                      commit(writeSun((s) => (s.castShadow = on ? undefined : false)))
                    }
                  />
                </>
              ) : (
                <ActionRow
                  label="Add a sun"
                  chevron={false}
                  onClick={() => commit(writeSun(() => {}))}
                />
              )}
            </DrillGroup>

            <DrillGroup
              label="Ambient"
              hint={fieldSource("ambient", doc.lighting, projectLighting)}
            >
              <DebouncedRange
                label="Intensity"
                value={resolved.ambient ?? 0}
                min={0}
                max={2}
                step={0.01}
                onInput={(n) => live(writeAmbient(n))}
                onCommit={(n) => commit(writeAmbient(n))}
              />
            </DrillGroup>

            {(resolved.fills?.length ?? 0) > 0 && (
              <DrillGroup label="Fills" hint={fieldSource("fills", doc.lighting, projectLighting)}>
                {(resolved.fills ?? []).map((fill, i) => (
                  <DebouncedRange
                    // Fills are a static ordered list; index identity is stable.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static ordered list
                    key={i}
                    label={`Fill ${i + 1}`}
                    value={fill.intensity}
                    min={0}
                    max={4}
                    step={0.05}
                    onInput={(n) => live(writeFills((fills) => (fills[i].intensity = n)))}
                    onCommit={(n) => commit(writeFills((fills) => (fills[i].intensity = n)))}
                  />
                ))}
              </DrillGroup>
            )}

            <DrillGroup label="Shadow" hint={fieldSource("shadow", doc.lighting, projectLighting)}>
              <ToggleRow
                label="Real shadow maps"
                description="Renders only when the scene stages a floor or backdrop."
                checked={(shadow?.technique ?? DEFAULT_SHADOW.technique) === "map"}
                onChange={(on) => commit(writeShadow((s) => (s.technique = on ? "map" : "none")))}
              />
              {(shadow?.technique ?? "map") === "map" && (
                <>
                  <DebouncedRange
                    label="Opacity"
                    value={shadow?.opacity ?? DEFAULT_SHADOW.opacity}
                    min={0}
                    max={1}
                    step={0.01}
                    onInput={(n) => live(writeShadow((s) => (s.opacity = n)))}
                    onCommit={(n) => commit(writeShadow((s) => (s.opacity = n)))}
                  />
                  <div className="camera-loop-modes">
                    {MAP_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`chip${(shadow?.mapSize ?? DEFAULT_SHADOW.mapSize) === size ? " selected" : ""}`}
                        title={`${size} px shadow map`}
                        onClick={() => commit(writeShadow((s) => (s.mapSize = size)))}
                      >
                        {size}
                      </button>
                    ))}
                    <NumberField
                      label="bias"
                      value={shadow?.bias ?? DEFAULT_SHADOW.bias}
                      decimals={4}
                      dragScale={0.0001}
                      onCommit={(n) => commit(writeShadow((s) => (s.bias = n)))}
                    />
                    <ColourPicker
                      value={shadow?.color ?? "#000000"}
                      label="Shadow tint"
                      defaultValue="#000000"
                      onCommit={(hex) => commit(writeShadow((s) => (s.color = hex)))}
                    />
                  </div>
                </>
              )}
            </DrillGroup>

            {doc.lighting && (
              <>
                <div className="inspector-section-divider" />
                <ActionRow
                  label="Reset to theme"
                  chevron={false}
                  onClick={() =>
                    commit((next) => {
                      delete next.lighting;
                    })
                  }
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
