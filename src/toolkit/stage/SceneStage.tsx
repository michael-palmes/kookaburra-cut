import { type ReactNode, useContext, useEffect, useMemo } from "react";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useStageRegistry } from "../../engine/stageRegistry";
import { useTheme } from "../../theme";
import { mergeLighting } from "../../theme/schema";
import type { ThemeLightSpec } from "../../theme/tokens";
import { StageBackdrop } from "./backdrops";
import { SceneStageContext, type SceneStageState } from "./context";

/** The theme-driven stage: lights the scene from `theme.lighting` tokens (merged with the sidecar's partial `lighting` override), mounts the resolved backdrop, and tells staged primitives to stand their bundled lit sets down; the camera-locked fixed background and environment reflections do NOT mount here (mounted elsewhere, at the scene host and the compositor seam respectively). Shadows are the HYBRID decision: the key light casts real shadow maps only when a floor/backdrop is staged AND the shadow technique is "map", else the procedural blob shadows remain the default; a theme without a `lighting` block renders no lights and leaves primitives lit (context null) so a scaffolded scene stays visible under a legacy theme. */

/** Lights sit on a fixed-radius sphere aimed at the origin. EXPORT CONTRACT. */
const LIGHT_RADIUS = 8;

// ── Shadow rig (export contract) ─────────────────────────────────────
/** Ortho shadow-camera half-extent, covers the stage; FIXED, never auto-fit. */
const SHADOW_FRUSTUM_EXTENT = 8;
const SHADOW_NEAR = 0.5;
const SHADOW_FAR = 30;
/** `softness` 0..1 → VSM blur radius. */
const SHADOW_RADIUS_SCALE = 8;
/** VSM gaussian tap count (three default, pinned explicitly). */
const SHADOW_BLUR_SAMPLES = 8;

const DEG2RAD = Math.PI / 180;

/** Orbit direction (azimuth from +z, elevation up) → a world position at LIGHT_RADIUS. */
function lightPosition(spec: ThemeLightSpec): [number, number, number] {
  const az = spec.azimuthDeg * DEG2RAD;
  const el = spec.elevationDeg * DEG2RAD;
  return [
    LIGHT_RADIUS * Math.sin(az) * Math.cos(el),
    LIGHT_RADIUS * Math.sin(el),
    LIGHT_RADIUS * Math.cos(az) * Math.cos(el),
  ];
}

export function SceneStage({
  children,
  floorY,
}: {
  children?: ReactNode;
  /** Stage floor height for a floor backdrop (world y; default −1.5). */
  floorY?: number;
}) {
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const lighting = mergeLighting(theme.lighting, doc?.lighting);
  const backdrop = doc?.backdrop ?? theme.backdrop;
  const hasBackdrop = backdrop !== undefined && backdrop.type !== "none";
  const shadow = lighting?.shadow;
  const mapShadows = Boolean(hasBackdrop && shadow && shadow.technique === "map");

  // Report staging to the registry so the Background editor can warn about occluded fills.
  const sceneIndex = useSceneContext()?.index;
  const backdropType = backdrop?.type ?? "none";
  useEffect(() => {
    if (sceneIndex === undefined) return;
    useStageRegistry.getState().register(sceneIndex, backdropType);
    return () => useStageRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex, backdropType]);

  const stageState = useMemo<SceneStageState | null>(
    () => (lighting ? { mapShadows } : null),
    [lighting, mapShadows],
  );

  return (
    <SceneStageContext.Provider value={stageState}>
      {lighting && (
        <>
          <ambientLight intensity={lighting.ambient} />
          <directionalLight
            position={lightPosition(lighting.key)}
            intensity={lighting.key.intensity}
            color={lighting.key.color ?? "#ffffff"}
            castShadow={mapShadows}
            shadow-mapSize={[shadow?.mapSize ?? 2048, shadow?.mapSize ?? 2048]}
            shadow-radius={(shadow?.softness ?? 0.5) * SHADOW_RADIUS_SCALE}
            shadow-blurSamples={SHADOW_BLUR_SAMPLES}
            shadow-bias={shadow?.bias ?? -0.0005}
            shadow-camera-left={-SHADOW_FRUSTUM_EXTENT}
            shadow-camera-right={SHADOW_FRUSTUM_EXTENT}
            shadow-camera-top={SHADOW_FRUSTUM_EXTENT}
            shadow-camera-bottom={-SHADOW_FRUSTUM_EXTENT}
            shadow-camera-near={SHADOW_NEAR}
            shadow-camera-far={SHADOW_FAR}
          />
          {lighting.fills.map((fill, i) => (
            <directionalLight
              // Fills are a static ordered list from the theme; index identity is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: static theme-token list
              key={i}
              position={lightPosition(fill)}
              intensity={fill.intensity}
              color={fill.color ?? "#ffffff"}
            />
          ))}
        </>
      )}
      {backdrop && (
        <StageBackdrop spec={backdrop} shadow={mapShadows ? shadow : undefined} floorY={floorY} />
      )}
      {children}
    </SceneStageContext.Provider>
  );
}
