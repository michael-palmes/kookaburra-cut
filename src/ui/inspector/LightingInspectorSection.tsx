import { type ReactNode, useEffect, useRef, useState } from "react";
import { useClockStore } from "../../engine/clock";
import {
  BUNDLED_ENVIRONMENT_IDS,
  NONE_SOURCE,
  resolveSceneEnvironment,
  SOFTBOX_SOURCE,
} from "../../engine/environments";
import { useLightEditStore } from "../../engine/lightEditStore";
import { useLightingEditStore } from "../../engine/lightingEditStore";
import { listProjectEnvironmentAssets } from "../../engine/project";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  captureLightingPose,
  resolveLighting,
  resolveLightingColour,
  SUN_ANGULAR_REFERENCE,
  sunShadowSoftness,
} from "../../engine/sceneLighting";
import type {
  EnvironmentSpec,
  FixtureSpec,
  LightingPose,
  LightingSpec,
  LightSpec,
  Placement,
  SunSpec,
  Theme,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "../../theme/tokens";
import { LIGHTING_PRESETS } from "../../toolkit/lighting/presets";
import { ColourPicker } from "../colour/ColourPicker";
import { OptionCard } from "../OptionCard";
import { LightingDirectionDial } from "./LightingDirectionDial";
import { LightingIcon } from "./LightingIcon";
import {
  FIXTURE_DEFAULTS,
  FixtureEditor,
  FixtureFormIcon,
  FORM_LABEL,
  LIGHT_DEFAULTS,
  LightEditor,
  LightTypeIcon,
  lightingThumbFor,
  NoReflectionsIcon,
  nextFixtureId,
  nextLightId,
  TYPE_LABEL,
  thumbFor,
} from "./LightingSection";
import {
  adjacentLightingKey,
  applyLightingLook,
  applyLightingShadowStyle,
  deleteLightingKey,
  duplicateLightingKey,
  keyLightingAtPlayhead,
  type LightingAnimationScope,
  lightingLookChangeCount,
  lightingShadowStyle,
  setIncomingLightingEase,
  updateLightingKeyPose,
} from "./lightingEditorModel";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  InspectorSliderRow,
  NumberField,
  ToggleRow,
} from "./rows";

const DEFAULT_SUN: SunSpec = { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8 };
const DEFAULT_SHADOW: ThemeShadowSpec = {
  technique: "map",
  softness: 0.5,
  opacity: 0.3,
  mapSize: 2048,
  bias: -0.0005,
};
const MAP_SIZES = [1024, 2048, 4096];
export const LIGHTING_EASING_OPTIONS = [
  { id: "linear", label: "Linear" },
  { id: "inOutSine", label: "Smooth" },
  { id: "outExpo", label: "Snappy" },
] as const;

export type LightingInspectorScreen =
  | "overview"
  | "environment"
  | "sun"
  | "fixtures"
  | "shadows"
  | "animation";

export interface LightingInspectorSectionProps {
  doc: SceneDoc;
  theme: Theme;
  projectId: string;
  projectLighting: LightingSpec | undefined;
  slot: { startMs: number; durationMs: number };
  backLabel: string;
  screen: LightingInspectorScreen;
  onBack: () => void;
  onScreenChange: (screen: LightingInspectorScreen) => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  patchDocResult: (
    patch: (next: SceneDoc) => unknown,
    opts?: { history?: string | false },
  ) => Promise<boolean>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
  animationScope?: LightingAnimationScope;
  onAnimationScopeChange?: (scope: LightingAnimationScope) => void;
  onSeek?: (globalMs: number) => void;
}

function environmentLabel(source: string): string {
  if (source === NONE_SOURCE) return "None";
  if (source === SOFTBOX_SOURCE) return "Softbox";
  return source
    .replace(/^kookaburra:/, "")
    .replace(/^assets\//, "")
    .replace(/\.(hdr|exr)$/i, "")
    .replace(/[-_]/g, " ");
}

function shadowLabel(shadow: ThemeShadowSpec | undefined): string {
  if (shadow?.enabled === false) return "Off";
  const style = lightingShadowStyle(shadow);
  if (style === "none") return "None";
  return style === "cast" ? "Cast" : "Soft contact";
}

function scopeLabel(scope: LightingAnimationScope): string {
  if (scope.kind === "rig") return "Whole rig";
  return scope.kind === "light" ? "Light" : "Fixture";
}

export function effectiveLightingPoseForScope(
  captured: LightingPose,
  lighting: LightingSpec | undefined,
  scope: LightingAnimationScope,
): LightingPose {
  if (scope.kind === "rig") return captured;
  if (scope.kind === "light") {
    const light = lighting?.lights?.find((candidate) => candidate.id === scope.id);
    if (!light) return {};
    return {
      lights: {
        [light.id]: {
          intensity: light.intensity,
          ...(light.kelvin !== undefined ? { kelvin: light.kelvin } : {}),
          placement: structuredClone(light.placement),
        },
      },
    };
  }
  const fixture = lighting?.fixtures?.find((candidate) => candidate.id === scope.id);
  if (!fixture) return {};
  return {
    fixtures: {
      [fixture.id]: {
        emissive: fixture.emissive,
        lightIntensity: fixture.lightIntensity,
        placement: structuredClone(fixture.placement),
      },
    },
  };
}

function placementLabel(placement: Placement): string {
  if (placement.mode === "orbit") {
    return `${Math.round(placement.azimuthDeg)}° · ${Math.round(placement.elevationDeg)}°`;
  }
  return placement.position.map((value) => value.toFixed(1)).join(", ");
}

function VisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.8 10s2.7-4.5 7.2-4.5 7.2 4.5 7.2 4.5-2.7 4.5-7.2 4.5S2.8 10 2.8 10z" />
      <circle cx="10" cy="10" r="2" />
      {!visible && <path d="M4 4l12 12" />}
    </svg>
  );
}

function ShadowStyleIcon({ style }: { style: "none" | "soft-contact" | "cast" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.5" />
      {style !== "none" && (
        <ellipse
          cx="13"
          cy="16"
          rx={style === "cast" ? 5.5 : 7}
          ry={style === "cast" ? 1.6 : 2.4}
          strokeDasharray={style === "soft-contact" ? "2 2" : undefined}
        />
      )}
      {style === "none" && <path d="M5 19L19 5" />}
    </svg>
  );
}

function incomingSegmentIndex(lighting: LightingSpec | undefined, keyId: string): number | null {
  const index = lighting?.segments?.findIndex((segment) => segment.to === keyId) ?? -1;
  return index >= 0 ? index : null;
}

export function LightingInspectorSection({
  doc,
  theme,
  projectId,
  projectLighting,
  slot,
  backLabel,
  screen,
  onBack,
  onScreenChange,
  patchDoc,
  patchDocResult,
  commitFromBaseline,
  animationScope,
  onAnimationScopeChange,
  onSeek,
}: LightingInspectorSectionProps) {
  const resolved = resolveLighting(theme.lighting, projectLighting, doc.lighting);
  const dragBaseline = useRef<SceneDoc | null>(null);
  const [projectMaps, setProjectMaps] = useState<string[]>([]);
  const [lightId, setLightId] = useState<string | null>(null);
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const [localScope, setLocalScope] = useState<LightingAnimationScope>({ kind: "rig" });
  const selectedKeyId = useLightingEditStore((state) => state.selectedKeyId);
  const scope = animationScope ?? localScope;

  useEffect(() => {
    let cancelled = false;
    void listProjectEnvironmentAssets(projectId).then((assets) => {
      if (!cancelled) setProjectMaps(assets);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (screen !== "animation") return;
    useLightingEditStore.getState().setOpen(true);
    return () => useLightingEditStore.getState().setOpen(false);
  }, [screen]);

  useEffect(() => {
    if (screen !== "fixtures") useLightEditStore.getState().select(null);
    return () => useLightEditStore.getState().select(null);
  }, [screen]);

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
  const commitResult = async (mutate: (next: SceneDoc) => unknown): Promise<boolean> => {
    return patchDocResult(mutate);
  };
  const resolveNext = (next: SceneDoc) =>
    resolveLighting(theme.lighting, projectLighting, next.lighting);
  const resolveLook = (look: LightingSpec) =>
    resolveLighting(theme.lighting, projectLighting, look) ?? look;
  const writeLighting = (mutate: (lighting: LightingSpec) => void) => (next: SceneDoc) => {
    const lighting = structuredClone(next.lighting ?? {});
    mutate(lighting);
    next.lighting = lighting;
  };
  const writeSun = (mutate: (sun: SunSpec) => void) => (next: SceneDoc) => {
    const sun = structuredClone(resolveNext(next)?.sun ?? DEFAULT_SUN);
    mutate(sun);
    next.lighting = { ...(next.lighting ?? {}), sun };
  };
  const writeEnvironment = (mutate: (environment: EnvironmentSpec) => void) => (next: SceneDoc) => {
    const environment = structuredClone(
      resolveSceneEnvironment(theme, projectLighting, next) ?? {
        source: NONE_SOURCE,
        intensity: 1,
        rotationDeg: 0,
      },
    );
    mutate(environment);
    next.lighting = { ...(next.lighting ?? {}), environment };
  };
  const writeShadow = (mutate: (shadow: ThemeShadowSpec) => void) => (next: SceneDoc) => {
    const shadow = structuredClone(resolveNext(next)?.shadow ?? DEFAULT_SHADOW);
    mutate(shadow);
    next.lighting = { ...(next.lighting ?? {}), shadow };
  };
  const writeFills = (mutate: (fills: ThemeLightSpec[]) => void) => (next: SceneDoc) => {
    const fills = structuredClone(resolveNext(next)?.fills ?? []);
    mutate(fills);
    next.lighting = { ...(next.lighting ?? {}), fills };
  };
  const writeLights = (mutate: (lights: LightSpec[]) => unknown) => (next: SceneDoc) => {
    const lights = structuredClone(resolveNext(next)?.lights ?? []);
    if (mutate(lights) === false) return false;
    next.lighting = { ...(next.lighting ?? {}), lights };
  };
  const writeFixtures = (mutate: (fixtures: FixtureSpec[]) => unknown) => (next: SceneDoc) => {
    const fixtures = structuredClone(resolveNext(next)?.fixtures ?? []);
    if (mutate(fixtures) === false) return false;
    next.lighting = { ...(next.lighting ?? {}), fixtures };
  };
  const writeLight = (id: string, mutate: (light: LightSpec) => void) =>
    writeLights((lights) => {
      const light = lights.find((candidate) => candidate.id === id);
      if (!light) return false;
      mutate(light);
    });
  const writeFixture = (id: string, mutate: (fixture: FixtureSpec) => void) =>
    writeFixtures((fixtures) => {
      const fixture = fixtures.find((candidate) => candidate.id === id);
      if (!fixture) return false;
      mutate(fixture);
    });
  const setScope = (next: LightingAnimationScope) => {
    setLocalScope(next);
    onAnimationScopeChange?.(next);
  };
  const openAnimation = (next: LightingAnimationScope) => {
    setScope(next);
    onScreenChange("animation");
  };
  const seek = (localMs: number) => {
    const globalMs = slot.startMs + localMs;
    if (onSeek) onSeek(globalMs);
    else useClockStore.getState().setCurrentMs(globalMs);
  };

  const shell = (title: string, content: ReactNode) => (
    <div className="inspector-drill" data-lighting-screen={screen}>
      <DrillBack label={backLabel} title={title} onClick={onBack} />
      <div className="inspector-drill-body inspector-section-body">{content}</div>
    </div>
  );

  if (screen === "overview") {
    const selectedLook = LIGHTING_PRESETS.find((look) => look.id === doc.lighting?.preset);
    const changeCount = selectedLook
      ? lightingLookChangeCount(resolved, resolveLook(selectedLook.spec))
      : 0;
    const sun = resolved?.sun;
    const sunEnabled = !!sun && sun.enabled !== false;
    return shell(
      "Lighting",
      <>
        {!resolved && (
          <p className="modal-hint">
            This scene has no lighting rig. Choose a tuned look to light it.
          </p>
        )}
        <DrillGroup
          label="Looks"
          hint={
            selectedLook
              ? changeCount > 0
                ? `${changeCount} ${changeCount === 1 ? "change" : "changes"}`
                : "Tuned look"
              : "Choose a tuned starting point"
          }
        >
          <fieldset className="option-grid" aria-label="Lighting looks">
            {LIGHTING_PRESETS.filter((look) => look.id !== "overcast").map((look) => (
              <OptionCard
                key={look.id}
                label={look.label}
                title={look.description}
                image={lightingThumbFor(look.id)}
                selected={doc.lighting?.preset === look.id}
                onSelect={() =>
                  commit((next) => {
                    next.lighting = applyLightingLook(
                      next.lighting,
                      look.spec,
                      look.id,
                      resolveLook(look.spec),
                    );
                  })
                }
              />
            ))}
          </fieldset>
        </DrillGroup>

        <DrillGroup label="Sun" hint={sunEnabled ? undefined : "Sun off"}>
          <fieldset disabled={!sunEnabled} aria-label={sunEnabled ? "Sun controls" : "Sun off"}>
            <InspectorSliderRow
              icon={<LightingIcon name="brightness" />}
              label="Brightness"
              value={sun?.intensity ?? 0}
              min={0}
              max={6}
              step={0.05}
              onInput={(value) => live(writeSun((next) => (next.intensity = value)))}
              onCommit={(value) => commit(writeSun((next) => (next.intensity = value)))}
            />
            <InspectorSliderRow
              icon={<LightingIcon name="warmth" />}
              label="Warmth"
              value={sun?.kelvin ?? 6500}
              min={1000}
              max={20000}
              step={100}
              onInput={(value) => live(writeSun((next) => (next.kelvin = value)))}
              onCommit={(value) => commit(writeSun((next) => (next.kelvin = value)))}
            />
            <InspectorSliderRow
              icon={<LightingIcon name="direction" />}
              label="Direction"
              value={sun?.azimuthDeg ?? 0}
              min={-180}
              max={180}
              step={1}
              onInput={(value) => live(writeSun((next) => (next.azimuthDeg = value)))}
              onCommit={(value) => commit(writeSun((next) => (next.azimuthDeg = value)))}
            />
          </fieldset>
        </DrillGroup>

        <DrillGroup label="Details">
          <ActionRow
            icon={<LightingIcon name="environment" />}
            label="Environment"
            value={environmentLabel(
              resolveSceneEnvironment(theme, projectLighting, doc)?.source ?? NONE_SOURCE,
            )}
            onClick={() => onScreenChange("environment")}
          />
          <ActionRow
            icon={<LightingIcon name="sun" />}
            label="Sun & ambient"
            value={sunEnabled ? "On" : "Sun off"}
            onClick={() => onScreenChange("sun")}
          />
          <ActionRow
            icon={<LightingIcon name="lights" />}
            label="Lights & fixtures"
            value={`${resolved?.lights?.length ?? 0} + ${resolved?.fixtures?.length ?? 0}`}
            onClick={() => onScreenChange("fixtures")}
          />
          <ActionRow
            icon={<LightingIcon name="shadow" />}
            label="Shadows"
            value={shadowLabel(resolved?.shadow)}
            onClick={() => onScreenChange("shadows")}
          />
          <ActionRow
            icon={<LightingIcon name="animation" />}
            label="Animation"
            value={
              doc.lighting?.animationEnabled === false
                ? "Off"
                : `${doc.lighting?.keys?.length ?? 0} keys`
            }
            onClick={() => openAnimation({ kind: "rig" })}
          />
        </DrillGroup>

        <div className="inspector-section-divider" />
        <ActionRow
          label="Reset lighting to theme"
          chevron={false}
          disabled={!doc.lighting}
          onClick={() =>
            commit((next) => {
              delete next.lighting;
            })
          }
        />
      </>,
    );
  }

  if (screen === "environment") {
    const environment = resolveSceneEnvironment(theme, projectLighting, doc) ?? {
      source: NONE_SOURCE,
      intensity: 1,
      rotationDeg: 0,
    };
    return shell(
      "Environment",
      <>
        <p className="modal-hint">
          Reflections and specular light only. The background stays unchanged.
        </p>
        <fieldset className="option-grid" aria-label="Environment maps">
          <OptionCard
            label="None"
            title="No environment reflections"
            image={null}
            icon={<NoReflectionsIcon />}
            selected={environment.source === NONE_SOURCE}
            onSelect={() => commit(writeEnvironment((next) => (next.source = NONE_SOURCE)))}
          />
          <OptionCard
            label="Softbox"
            title="Procedural studio panels"
            image={lightingThumbFor("softbox")}
            selected={environment.source === SOFTBOX_SOURCE}
            onSelect={() => commit(writeEnvironment((next) => (next.source = SOFTBOX_SOURCE)))}
          />
          {BUNDLED_ENVIRONMENT_IDS.map((id) => (
            <OptionCard
              key={id}
              label={environmentLabel(id)}
              image={thumbFor(id)}
              selected={environment.source === id}
              onSelect={() => commit(writeEnvironment((next) => (next.source = id)))}
            />
          ))}
          {projectMaps.map((source) => (
            <OptionCard
              key={source}
              label={environmentLabel(source)}
              title={source}
              image={null}
              selected={environment.source === source}
              onSelect={() => commit(writeEnvironment((next) => (next.source = source)))}
            />
          ))}
        </fieldset>
        {environment.source !== NONE_SOURCE && (
          <>
            <InspectorSliderRow
              icon={<LightingIcon name="brightness" />}
              label="Intensity"
              value={environment.intensity}
              min={0}
              max={3}
              step={0.05}
              onInput={(value) => live(writeEnvironment((next) => (next.intensity = value)))}
              onCommit={(value) => commit(writeEnvironment((next) => (next.intensity = value)))}
            />
            <InspectorSliderRow
              icon={<LightingIcon name="rotation" />}
              label="Rotation"
              value={environment.rotationDeg}
              min={0}
              max={360}
              step={1}
              onInput={(value) => live(writeEnvironment((next) => (next.rotationDeg = value)))}
              onCommit={(value) => commit(writeEnvironment((next) => (next.rotationDeg = value)))}
            />
          </>
        )}
        {doc.lighting?.environment && (
          <ActionRow
            label="Use inherited environment"
            chevron={false}
            onClick={() =>
              commit((next) => {
                if (next.lighting) delete next.lighting.environment;
              })
            }
          />
        )}
      </>,
    );
  }

  if (screen === "sun") {
    const sun = resolved?.sun;
    const enabled = !!sun && sun.enabled !== false;
    const shadow = resolved?.shadow;
    const angular = sun?.angularDeg ?? sunShadowSoftness(sun, shadow) * SUN_ANGULAR_REFERENCE;
    const swatch = sun ? resolveLightingColour(sun, theme.colors) : "#ffffff";
    return shell(
      "Sun & ambient",
      <>
        {sun ? (
          <>
            <ToggleRow
              label="Sun"
              description="Off retains every sun setting."
              checked={enabled}
              onChange={(on) => commit(writeSun((next) => (next.enabled = on ? undefined : false)))}
            />
            {!enabled && <p className="modal-hint">Sun off</p>}
            <div aria-disabled={!enabled}>
              {enabled && (
                <LightingDirectionDial
                  value={sun.azimuthDeg}
                  onInput={(value) => live(writeSun((next) => (next.azimuthDeg = value)))}
                  onCommit={(value) => commit(writeSun((next) => (next.azimuthDeg = value)))}
                />
              )}
              <fieldset disabled={!enabled} aria-label={enabled ? "Sun controls" : "Sun off"}>
                <InspectorSliderRow
                  icon={<LightingIcon name="brightness" />}
                  label="Brightness"
                  value={sun.intensity}
                  min={0}
                  max={6}
                  step={0.05}
                  onInput={(value) => live(writeSun((next) => (next.intensity = value)))}
                  onCommit={(value) => commit(writeSun((next) => (next.intensity = value)))}
                />
                <InspectorSliderRow
                  icon={<LightingIcon name="warmth" />}
                  label="Warmth"
                  value={sun.kelvin ?? 6500}
                  min={1000}
                  max={20000}
                  step={100}
                  onInput={(value) => live(writeSun((next) => (next.kelvin = value)))}
                  onCommit={(value) => commit(writeSun((next) => (next.kelvin = value)))}
                />
                <InspectorSliderRow
                  icon={<LightingIcon name="direction" />}
                  label="Elevation"
                  value={sun.elevationDeg}
                  min={-90}
                  max={90}
                  step={1}
                  onInput={(value) => live(writeSun((next) => (next.elevationDeg = value)))}
                  onCommit={(value) => commit(writeSun((next) => (next.elevationDeg = value)))}
                />
                <InspectorSliderRow
                  icon={<LightingIcon name="softness" />}
                  label="Angular size"
                  value={angular}
                  min={0}
                  max={16}
                  step={0.1}
                  onInput={(value) => live(writeSun((next) => (next.angularDeg = value)))}
                  onCommit={(value) => commit(writeSun((next) => (next.angularDeg = value)))}
                />
                <span
                  className="lighting-kelvin-swatch"
                  style={{ background: swatch }}
                  title={sun.kelvin !== undefined ? `${sun.kelvin} K` : "Sun colour"}
                />
                <ToggleRow
                  label="Cast shadows"
                  description="Requires the Shadows master and a stage catcher."
                  checked={sun.castShadow !== false}
                  onChange={(on) =>
                    commit(writeSun((next) => (next.castShadow = on ? undefined : false)))
                  }
                />
              </fieldset>
              {enabled && sun.kelvin !== undefined ? (
                <ActionRow
                  label="Use a custom colour instead"
                  chevron={false}
                  disabled={!enabled}
                  onClick={() =>
                    commit(
                      writeSun((next) => {
                        delete next.kelvin;
                      }),
                    )
                  }
                />
              ) : enabled ? (
                <div className="camera-loop-modes">
                  <span className="drill-group-hint">Custom colour</span>
                  <ColourPicker
                    value={sun.color ?? "#ffffff"}
                    label="Sun colour"
                    onCommit={(color) =>
                      commit(
                        writeSun((next) => {
                          next.color = color;
                          delete next.kelvin;
                        }),
                      )
                    }
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <ActionRow label="Add a sun" chevron={false} onClick={() => commit(writeSun(() => {}))} />
        )}

        <DrillGroup label="Ambient">
          <InspectorSliderRow
            icon={<LightingIcon name="ambient" />}
            label="Ambient level"
            value={resolved?.ambient ?? 0}
            min={0}
            max={2}
            step={0.01}
            onInput={(value) => live(writeLighting((lighting) => (lighting.ambient = value)))}
            onCommit={(value) => commit(writeLighting((lighting) => (lighting.ambient = value)))}
          />
          <div className="camera-loop-modes">
            <span className="drill-group-hint">Ambient tint</span>
            <ColourPicker
              value={resolved?.ambientColor ?? "#ffffff"}
              label="Ambient tint"
              defaultValue="#ffffff"
              onCommit={(color) =>
                commit(writeLighting((lighting) => (lighting.ambientColor = color)))
              }
            />
          </div>
        </DrillGroup>

        {(resolved?.fills?.length ?? 0) > 0 && (
          <DrillGroup label="Legacy fills">
            {(resolved?.fills ?? []).map((fill, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fills are a static ordered legacy list
              <div key={index}>
                <InspectorSliderRow
                  icon={<LightingIcon name="lights" />}
                  label={`Fill ${index + 1}`}
                  value={fill.intensity}
                  min={0}
                  max={4}
                  step={0.05}
                  onInput={(value) => live(writeFills((fills) => (fills[index].intensity = value)))}
                  onCommit={(value) =>
                    commit(writeFills((fills) => (fills[index].intensity = value)))
                  }
                />
              </div>
            ))}
          </DrillGroup>
        )}
        {(doc.lighting?.sun !== undefined ||
          doc.lighting?.ambient !== undefined ||
          doc.lighting?.ambientColor !== undefined) && (
          <ActionRow
            label="Reset sun & ambient to theme"
            chevron={false}
            onClick={() =>
              commit((next) => {
                if (!next.lighting) return;
                delete next.lighting.sun;
                delete next.lighting.ambient;
                delete next.lighting.ambientColor;
              })
            }
          />
        )}
      </>,
    );
  }

  if (screen === "fixtures") {
    const selectedLight = lightId
      ? resolved?.lights?.find((light) => light.id === lightId)
      : undefined;
    const selectedFixture = fixtureId
      ? resolved?.fixtures?.find((fixture) => fixture.id === fixtureId)
      : undefined;
    return shell(
      "Lights & fixtures",
      <>
        <DrillGroup label="Lights">
          {(resolved?.lights ?? []).map((light) => (
            <div className="lighting-entity-row" key={light.id}>
              <ActionRow
                icon={<LightTypeIcon type={light.type} size={17} />}
                label={light.name ?? TYPE_LABEL[light.type]}
                value={`${TYPE_LABEL[light.type]} · ${placementLabel(light.placement)} · ${light.intensity}`}
                selected={light.id === lightId}
                onClick={() => {
                  setFixtureId(null);
                  setLightId(light.id);
                  useLightEditStore.getState().select("light", light.id);
                }}
              />
              <button
                type="button"
                className="lighting-entity-visibility"
                aria-label={`${light.enabled === false ? "Show" : "Hide"} ${light.name ?? TYPE_LABEL[light.type]}`}
                aria-pressed={light.enabled === false}
                onClick={() =>
                  commit(
                    writeLight(light.id, (next) => {
                      if (next.enabled === false) delete next.enabled;
                      else next.enabled = false;
                    }),
                  )
                }
              >
                <VisibilityIcon visible={light.enabled !== false} />
              </button>
            </div>
          ))}
        </DrillGroup>
        <DrillGroup label="Fixtures" hint="Bloom makes emissive fixtures read hot.">
          {(resolved?.fixtures ?? []).map((fixture) => (
            <div className="lighting-entity-row" key={fixture.id}>
              <ActionRow
                icon={<FixtureFormIcon form={fixture.form} size={17} />}
                label={fixture.name ?? FORM_LABEL[fixture.form]}
                value={`${FORM_LABEL[fixture.form]} · ${placementLabel(fixture.placement)} · ${fixture.lightIntensity}`}
                selected={fixture.id === fixtureId}
                onClick={() => {
                  setLightId(null);
                  setFixtureId(fixture.id);
                  useLightEditStore.getState().select("fixture", fixture.id);
                }}
              />
              <button
                type="button"
                className="lighting-entity-visibility"
                aria-label={`${fixture.enabled === false ? "Show" : "Hide"} ${fixture.name ?? FORM_LABEL[fixture.form]}`}
                aria-pressed={fixture.enabled === false}
                onClick={() =>
                  commit(
                    writeFixture(fixture.id, (next) => {
                      if (next.enabled === false) delete next.enabled;
                      else next.enabled = false;
                    }),
                  )
                }
              >
                <VisibilityIcon visible={fixture.enabled !== false} />
              </button>
            </div>
          ))}
        </DrillGroup>

        <DrillGroup label="Add" hint="Always available">
          <fieldset className="camera-loop-modes" aria-label="Add a light">
            {(Object.keys(TYPE_LABEL) as LightSpec["type"][]).map((type) => (
              <button
                key={type}
                type="button"
                className="chip"
                onClick={async () => {
                  let id: string | null = null;
                  const written = await commitResult(
                    writeLights((lights) => {
                      id = nextLightId(lights);
                      lights.push(LIGHT_DEFAULTS[type](id));
                    }),
                  );
                  if (!written || !id) return;
                  setFixtureId(null);
                  setLightId(id);
                  useLightEditStore.getState().select("light", id);
                }}
              >
                <LightTypeIcon type={type} />
                {TYPE_LABEL[type]}
              </button>
            ))}
          </fieldset>
          <fieldset className="camera-loop-modes" aria-label="Add a fixture">
            {(Object.keys(FORM_LABEL) as FixtureSpec["form"][]).map((form) => (
              <button
                key={form}
                type="button"
                className="chip"
                onClick={async () => {
                  let id: string | null = null;
                  const written = await commitResult(
                    writeFixtures((fixtures) => {
                      id = nextFixtureId(fixtures);
                      fixtures.push(FIXTURE_DEFAULTS[form](id));
                    }),
                  );
                  if (!written || !id) return;
                  setLightId(null);
                  setFixtureId(id);
                  useLightEditStore.getState().select("fixture", id);
                }}
              >
                <FixtureFormIcon form={form} />
                {FORM_LABEL[form]}
              </button>
            ))}
          </fieldset>
        </DrillGroup>

        {selectedLight && (
          <LightEditor
            embedded
            light={selectedLight}
            colors={theme.colors}
            onBack={() => setLightId(null)}
            onLive={(mutate) => live(writeLight(selectedLight.id, mutate))}
            onCommit={(mutate) => commit(writeLight(selectedLight.id, mutate))}
            onAnimate={() => openAnimation({ kind: "light", id: selectedLight.id })}
            onDuplicate={async () => {
              let id: string | null = null;
              const written = await commitResult(
                writeLights((lights) => {
                  const source = lights.find((light) => light.id === selectedLight.id);
                  if (!source) return false;
                  id = nextLightId(lights);
                  lights.push({ ...structuredClone(source), id, name: undefined });
                }),
              );
              if (!written || !id) return;
              setLightId(id);
            }}
            onDelete={async () => {
              const written = await commitResult(
                writeLights((lights) => {
                  const index = lights.findIndex((light) => light.id === selectedLight.id);
                  if (index < 0) return false;
                  lights.splice(index, 1);
                }),
              );
              if (!written) return;
              setLightId(null);
              useLightEditStore.getState().select(null);
            }}
          />
        )}
        {selectedFixture && (
          <FixtureEditor
            embedded
            fixture={selectedFixture}
            colors={theme.colors}
            onBack={() => setFixtureId(null)}
            onLive={(mutate) => live(writeFixture(selectedFixture.id, mutate))}
            onCommit={(mutate) => commit(writeFixture(selectedFixture.id, mutate))}
            onAnimate={() => openAnimation({ kind: "fixture", id: selectedFixture.id })}
            onDuplicate={async () => {
              let id: string | null = null;
              const written = await commitResult(
                writeFixtures((fixtures) => {
                  const source = fixtures.find((fixture) => fixture.id === selectedFixture.id);
                  if (!source) return false;
                  id = nextFixtureId(fixtures);
                  const copy = structuredClone(source);
                  copy.id = id;
                  copy.name = undefined;
                  fixtures.push(copy);
                }),
              );
              if (!written || !id) return;
              setFixtureId(id);
            }}
            onDelete={async () => {
              const written = await commitResult(
                writeFixtures((fixtures) => {
                  const index = fixtures.findIndex((fixture) => fixture.id === selectedFixture.id);
                  if (index < 0) return false;
                  fixtures.splice(index, 1);
                }),
              );
              if (!written) return;
              setFixtureId(null);
              useLightEditStore.getState().select(null);
            }}
          />
        )}
      </>,
    );
  }

  if (screen === "shadows") {
    const shadow = resolved?.shadow ?? DEFAULT_SHADOW;
    const style = lightingShadowStyle(shadow);
    return shell(
      "Shadows",
      <>
        <ToggleRow
          label="Shadows"
          description="Disables real cast shadows and stage catchers, while retaining this style."
          checked={shadow.enabled !== false}
          onChange={(enabled) =>
            commit(
              writeShadow((next) => {
                if (enabled) delete next.enabled;
                else next.enabled = false;
              }),
            )
          }
        />
        <DrillGroup label="Style">
          <div className="option-grid" role="radiogroup" aria-label="Shadow style">
            {(
              [
                ["none", "None", "No shadow map style"],
                ["soft-contact", "Soft contact", "Soft grounded shadows"],
                ["cast", "Cast", "Defined directional shadows"],
              ] as const
            ).map(([id, label, title]) => (
              <OptionCard
                key={id}
                label={label}
                title={title}
                image={null}
                icon={<ShadowStyleIcon style={id} />}
                selected={style === id}
                onSelect={() =>
                  commit(
                    writeShadow((next) => Object.assign(next, applyLightingShadowStyle(next, id))),
                  )
                }
              />
            ))}
          </div>
        </DrillGroup>
        {style !== "none" && (
          <>
            <InspectorSliderRow
              icon={<LightingIcon name="shadow" />}
              label="Strength"
              value={shadow.opacity}
              min={0}
              max={1}
              step={0.01}
              onInput={(value) => live(writeShadow((next) => (next.opacity = value)))}
              onCommit={(value) => commit(writeShadow((next) => (next.opacity = value)))}
            />
            <InspectorSliderRow
              icon={<LightingIcon name="softness" />}
              label="Softness"
              value={shadow.softness}
              min={0}
              max={1}
              step={0.01}
              onInput={(value) => live(writeShadow((next) => (next.softness = value)))}
              onCommit={(value) => commit(writeShadow((next) => (next.softness = value)))}
            />
            <div className="camera-loop-modes">
              <span className="drill-group-hint">Colour</span>
              <ColourPicker
                value={shadow.color ?? "#000000"}
                label="Shadow colour"
                defaultValue="#000000"
                onCommit={(color) => commit(writeShadow((next) => (next.color = color)))}
              />
            </div>
            <ToggleRow
              label="Catch on background"
              description="Off keeps floor catching but removes vertical background shadows."
              checked={shadow.catchBackdrop !== false}
              onChange={(enabled) =>
                commit(writeShadow((next) => (next.catchBackdrop = enabled ? undefined : false)))
              }
            />
            <details className="drill-group lighting-shadow-advanced">
              <summary>Advanced</summary>
              <fieldset className="camera-loop-modes" aria-label="Shadow map size">
                {MAP_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`chip${shadow.mapSize === size ? " selected" : ""}`}
                    aria-pressed={shadow.mapSize === size}
                    onClick={() => commit(writeShadow((next) => (next.mapSize = size)))}
                  >
                    {size}
                  </button>
                ))}
              </fieldset>
              <div className="inspector-pose-grid">
                <NumberField
                  label="bias"
                  value={shadow.bias}
                  decimals={4}
                  dragScale={0.0001}
                  onCommit={(value) => commit(writeShadow((next) => (next.bias = value)))}
                />
              </div>
            </details>
          </>
        )}
        <ActionRow
          label="Reset shadows to theme"
          chevron={false}
          disabled={!doc.lighting?.shadow}
          onClick={() =>
            commit((next) => {
              if (next.lighting) delete next.lighting.shadow;
            })
          }
        />
      </>,
    );
  }

  const lighting = doc.lighting ?? {};
  const keys = [...(lighting.keys ?? [])].sort((a, b) => a.tMs - b.tMs);
  const selectedKey = keys.find((key) => key.id === selectedKeyId);
  const incoming = selectedKey
    ? lighting.segments?.find((segment) => segment.to === selectedKey.id)
    : undefined;
  const captured = captureLightingPose(theme, projectLighting, doc.lighting);
  const scopedPose = effectiveLightingPoseForScope(captured, resolved, scope);
  const selectedLight =
    scope.kind === "light" ? resolved?.lights?.find((light) => light.id === scope.id) : undefined;
  const selectedFixture =
    scope.kind === "fixture"
      ? resolved?.fixtures?.find((fixture) => fixture.id === scope.id)
      : undefined;
  const editSelectedPose = (mutate: (pose: LightingPose) => void) => {
    if (!selectedKey) return;
    commit(
      writeLighting((next) => {
        Object.assign(next, updateLightingKeyPose(next, selectedKey.id, mutate));
      }),
    );
  };
  const selectAndSeek = (keyId: string, tMs: number, source = lighting) => {
    useLightingEditStore.getState().select(keyId, incomingSegmentIndex(source, keyId));
    seek(tMs);
  };
  const scopeEntry = selectedKey
    ? scope.kind === "light"
      ? selectedKey.pose.lights?.[scope.id]
      : scope.kind === "fixture"
        ? selectedKey.pose.fixtures?.[scope.id]
        : undefined
    : undefined;

  return shell(
    "Animation",
    <>
      <ToggleRow
        label="Animation"
        description="Off mutes the track and retains every key."
        checked={lighting.animationEnabled !== false}
        onChange={(enabled) =>
          commit(
            writeLighting((next) => {
              if (enabled) delete next.animationEnabled;
              else next.animationEnabled = false;
            }),
          )
        }
      />
      <DrillGroup label="Scope" hint="One shared lighting lane">
        <fieldset className="camera-loop-modes" aria-label="Lighting animation scope">
          <button
            type="button"
            className={`chip${scope.kind === "rig" ? " selected" : ""}`}
            aria-pressed={scope.kind === "rig"}
            onClick={() => setScope({ kind: "rig" })}
          >
            Whole rig
          </button>
          {(resolved?.lights ?? []).map((light) => (
            <button
              key={light.id}
              type="button"
              className={`chip${scope.kind === "light" && scope.id === light.id ? " selected" : ""}`}
              aria-pressed={scope.kind === "light" && scope.id === light.id}
              onClick={() => setScope({ kind: "light", id: light.id })}
            >
              <LightTypeIcon type={light.type} />
              {light.name ?? TYPE_LABEL[light.type]}
            </button>
          ))}
          {(resolved?.fixtures ?? []).map((fixture) => (
            <button
              key={fixture.id}
              type="button"
              className={`chip${scope.kind === "fixture" && scope.id === fixture.id ? " selected" : ""}`}
              aria-pressed={scope.kind === "fixture" && scope.id === fixture.id}
              onClick={() => setScope({ kind: "fixture", id: fixture.id })}
            >
              <FixtureFormIcon form={fixture.form} />
              {fixture.name ?? FORM_LABEL[fixture.form]}
            </button>
          ))}
        </fieldset>
      </DrillGroup>

      <ActionRow
        icon={<LightingIcon name="key" />}
        label="Key at playhead"
        value={scopeLabel(scope)}
        chevron={false}
        onClick={async () => {
          const localMs = Math.min(
            slot.durationMs,
            Math.max(0, useClockStore.getState().currentMs - slot.startMs),
          );
          const visibleResult = keyLightingAtPlayhead(
            doc.lighting,
            localMs,
            slot.durationMs,
            scopedPose,
          );
          if (!visibleResult.created) {
            selectAndSeek(visibleResult.keyId, visibleResult.tMs);
            return;
          }
          const created: { value: ReturnType<typeof keyLightingAtPlayhead> | null } = {
            value: null,
          };
          const written = await commitResult((next) => {
            const currentResolved = resolveNext(next);
            const currentCaptured = captureLightingPose(theme, projectLighting, next.lighting);
            const currentPose = effectiveLightingPoseForScope(
              currentCaptured,
              currentResolved,
              scope,
            );
            const result = keyLightingAtPlayhead(
              next.lighting,
              localMs,
              slot.durationMs,
              currentPose,
            );
            created.value = result;
            if (!result.created) return false;
            next.lighting = result.lighting;
          });
          if (created.value && (written || !created.value.created)) {
            selectAndSeek(created.value.keyId, created.value.tMs, created.value.lighting);
          }
        }}
      />

      <DrillGroup label="Keys" hint={`${keys.length} ${keys.length === 1 ? "key" : "keys"}`}>
        {keys.map((key) => (
          <ActionRow
            key={key.id}
            icon={<LightingIcon name="key" />}
            label={`${(key.tMs / 1000).toFixed(2)}s`}
            value={key.id === selectedKeyId ? "Selected" : undefined}
            selected={key.id === selectedKeyId}
            chevron={false}
            onClick={() => selectAndSeek(key.id, key.tMs)}
          />
        ))}
      </DrillGroup>

      <fieldset className="camera-loop-modes" aria-label="Key navigation">
        <button
          type="button"
          className="chip"
          aria-label="Previous lighting key"
          disabled={keys.length === 0}
          onClick={() => {
            const key = adjacentLightingKey(keys, selectedKeyId, -1);
            if (key) selectAndSeek(key.id, key.tMs);
          }}
        >
          ←
        </button>
        <button
          type="button"
          className="chip"
          aria-label="Next lighting key"
          disabled={keys.length === 0}
          onClick={() => {
            const key = adjacentLightingKey(keys, selectedKeyId, 1);
            if (key) selectAndSeek(key.id, key.tMs);
          }}
        >
          →
        </button>
      </fieldset>

      {selectedKey && (
        <>
          <DrillGroup label="Incoming easing" hint={incoming ? undefined : "First key"}>
            <div className="camera-loop-modes">
              {LIGHTING_EASING_OPTIONS.map((ease) => (
                <button
                  key={ease.id}
                  type="button"
                  className={`chip${incoming?.ease === ease.id ? " selected" : ""}`}
                  aria-pressed={incoming?.ease === ease.id}
                  disabled={!incoming}
                  onClick={() =>
                    commit(
                      writeLighting((next) =>
                        Object.assign(next, setIncomingLightingEase(next, selectedKey.id, ease.id)),
                      ),
                    )
                  }
                >
                  {ease.label}
                </button>
              ))}
            </div>
          </DrillGroup>

          {scope.kind === "rig" && (
            <DrillGroup label="Whole rig key">
              <InspectorSliderRow
                icon={<LightingIcon name="ambient" />}
                label="Ambient"
                value={selectedKey.pose.ambient ?? resolved?.ambient ?? 0}
                min={0}
                max={2}
                step={0.01}
                onCommit={(value) => editSelectedPose((pose) => (pose.ambient = value))}
              />
              <InspectorSliderRow
                icon={<LightingIcon name="environment" />}
                label="Environment"
                value={
                  selectedKey.pose.environmentIntensity ?? resolved?.environment?.intensity ?? 0
                }
                min={0}
                max={3}
                step={0.05}
                onCommit={(value) =>
                  editSelectedPose((pose) => (pose.environmentIntensity = value))
                }
              />
              <InspectorSliderRow
                icon={<LightingIcon name="brightness" />}
                label="Brightness"
                value={selectedKey.pose.sun?.intensity ?? resolved?.sun?.intensity ?? 0}
                min={0}
                max={6}
                step={0.05}
                onCommit={(value) =>
                  editSelectedPose((pose) => {
                    pose.sun = { ...(pose.sun ?? {}), intensity: value };
                  })
                }
              />
              <InspectorSliderRow
                icon={<LightingIcon name="warmth" />}
                label="Warmth"
                value={selectedKey.pose.sun?.kelvin ?? resolved?.sun?.kelvin ?? 6500}
                min={1000}
                max={20000}
                step={100}
                onCommit={(value) =>
                  editSelectedPose((pose) => {
                    pose.sun = { ...(pose.sun ?? {}), kelvin: value };
                  })
                }
              />
              <InspectorSliderRow
                icon={<LightingIcon name="direction" />}
                label="Direction"
                value={selectedKey.pose.sun?.azimuthDeg ?? resolved?.sun?.azimuthDeg ?? 0}
                min={-180}
                max={180}
                step={1}
                onCommit={(value) =>
                  editSelectedPose((pose) => {
                    pose.sun = { ...(pose.sun ?? {}), azimuthDeg: value };
                  })
                }
              />
            </DrillGroup>
          )}

          {scope.kind === "light" && selectedLight && (
            <KeyedLightFields
              light={selectedLight}
              pose={
                scopeEntry as
                  | { intensity?: number; kelvin?: number; placement?: Placement }
                  | undefined
              }
              onCommit={editSelectedPose}
            />
          )}
          {scope.kind === "fixture" && selectedFixture && (
            <KeyedFixtureFields
              fixture={selectedFixture}
              pose={
                scopeEntry as
                  | { emissive?: number; lightIntensity?: number; placement?: Placement }
                  | undefined
              }
              onCommit={editSelectedPose}
            />
          )}

          <div className="inspector-section-divider" />
          <ActionRow
            label="Duplicate key"
            chevron={false}
            onClick={async () => {
              const result: { value: ReturnType<typeof duplicateLightingKey> | null } = {
                value: null,
              };
              const written = await commitResult((next) => {
                const duplicated = duplicateLightingKey(
                  next.lighting ?? {},
                  selectedKey.id,
                  slot.durationMs,
                );
                if (!duplicated.created) return false;
                next.lighting = duplicated.lighting;
                result.value = duplicated;
              });
              if (!written || !result.value) return;
              const key = result.value.lighting.keys?.find(
                (candidate) => candidate.id === result.value?.keyId,
              );
              if (key) selectAndSeek(key.id, key.tMs, result.value.lighting);
            }}
          />
          <ActionRow
            label="Delete key"
            chevron={false}
            danger
            onClick={async () => {
              const written = await commitResult((next) => {
                if (!next.lighting?.keys?.some((key) => key.id === selectedKey.id)) return false;
                next.lighting = deleteLightingKey(next.lighting, selectedKey.id);
              });
              if (!written) return;
              useLightingEditStore.getState().select(null, null);
            }}
          />
        </>
      )}
    </>,
  );
}

function KeyedPlacementFields({
  placement,
  onCommit,
}: {
  placement: Placement;
  onCommit: (placement: Placement) => void;
}) {
  if (placement.mode === "orbit") {
    return (
      <>
        <InspectorSliderRow
          icon={<LightingIcon name="direction" />}
          label="Azimuth"
          value={placement.azimuthDeg}
          min={-180}
          max={180}
          step={1}
          onCommit={(value) => onCommit({ ...placement, azimuthDeg: value })}
        />
        <InspectorSliderRow
          icon={<LightingIcon name="direction" />}
          label="Elevation"
          value={placement.elevationDeg}
          min={-90}
          max={90}
          step={1}
          onCommit={(value) => onCommit({ ...placement, elevationDeg: value })}
        />
        <NumberField
          label="distance"
          value={placement.distance}
          decimals={2}
          min={0}
          onCommit={(value) => onCommit({ ...placement, distance: value })}
        />
      </>
    );
  }
  return (
    <div className="inspector-pose-grid">
      {(["x", "y", "z"] as const).map((axis, index) => (
        <NumberField
          key={axis}
          label={axis}
          value={placement.position[index]}
          decimals={2}
          onCommit={(value) => {
            const position: [number, number, number] = [...placement.position];
            position[index] = value;
            onCommit({ mode: "point", position });
          }}
        />
      ))}
    </div>
  );
}

function KeyedLightFields({
  light,
  pose,
  onCommit,
}: {
  light: LightSpec;
  pose: { intensity?: number; kelvin?: number; placement?: Placement } | undefined;
  onCommit: (mutate: (pose: LightingPose) => void) => void;
}) {
  const placement = pose?.placement ?? light.placement;
  return (
    <DrillGroup label="Light key">
      <InspectorSliderRow
        icon={<LightingIcon name="brightness" />}
        label="Intensity"
        value={pose?.intensity ?? light.intensity}
        min={0}
        max={light.type === "spot" ? 200 : light.type === "point" ? 40 : 30}
        step={0.05}
        onCommit={(value) =>
          onCommit((next) => {
            next.lights = {
              ...(next.lights ?? {}),
              [light.id]: { ...(next.lights?.[light.id] ?? {}), intensity: value },
            };
          })
        }
      />
      <InspectorSliderRow
        icon={<LightingIcon name="warmth" />}
        label="Warmth"
        value={pose?.kelvin ?? light.kelvin ?? 6500}
        min={1000}
        max={20000}
        step={100}
        onCommit={(value) =>
          onCommit((next) => {
            next.lights = {
              ...(next.lights ?? {}),
              [light.id]: { ...(next.lights?.[light.id] ?? {}), kelvin: value },
            };
          })
        }
      />
      <KeyedPlacementFields
        placement={placement}
        onCommit={(value) =>
          onCommit((next) => {
            next.lights = {
              ...(next.lights ?? {}),
              [light.id]: { ...(next.lights?.[light.id] ?? {}), placement: value },
            };
          })
        }
      />
    </DrillGroup>
  );
}

function KeyedFixtureFields({
  fixture,
  pose,
  onCommit,
}: {
  fixture: FixtureSpec;
  pose: { emissive?: number; lightIntensity?: number; placement?: Placement } | undefined;
  onCommit: (mutate: (pose: LightingPose) => void) => void;
}) {
  const placement = pose?.placement ?? fixture.placement;
  return (
    <DrillGroup label="Fixture key">
      <InspectorSliderRow
        icon={<LightingIcon name="brightness" />}
        label="Emissive"
        value={pose?.emissive ?? fixture.emissive}
        min={0}
        max={8}
        step={0.1}
        onCommit={(value) =>
          onCommit((next) => {
            next.fixtures = {
              ...(next.fixtures ?? {}),
              [fixture.id]: { ...(next.fixtures?.[fixture.id] ?? {}), emissive: value },
            };
          })
        }
      />
      <InspectorSliderRow
        icon={<LightingIcon name="lights" />}
        label="Light intensity"
        value={pose?.lightIntensity ?? fixture.lightIntensity}
        min={0}
        max={40}
        step={0.5}
        onCommit={(value) =>
          onCommit((next) => {
            next.fixtures = {
              ...(next.fixtures ?? {}),
              [fixture.id]: {
                ...(next.fixtures?.[fixture.id] ?? {}),
                lightIntensity: value,
              },
            };
          })
        }
      />
      <KeyedPlacementFields
        placement={placement}
        onCommit={(value) =>
          onCommit((next) => {
            next.fixtures = {
              ...(next.fixtures ?? {}),
              [fixture.id]: { ...(next.fixtures?.[fixture.id] ?? {}), placement: value },
            };
          })
        }
      />
    </DrillGroup>
  );
}
