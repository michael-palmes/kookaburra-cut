import { Environment, Lightformer, useGLTF, useTexture } from "@react-three/drei";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box3,
  type BufferAttribute,
  Color,
  type Group,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  type Object3D,
  Vector3,
} from "three";
import { useClipTexture } from "../../engine/clipTexture";
import { deviceAcknowledgementMatches, useDeviceEditStore } from "../../engine/deviceEditStore";
import { useSceneConsumesDevices } from "../../engine/deviceRegistry";
import { ease } from "../../engine/ease";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { presentSlideshowActive } from "../../engine/presentMode";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { resolveAssetUrl } from "../../engine/project";
import { SceneOutline } from "../../engine/SceneOutline";
import { ProjectIdContext, SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import type { SceneDeviceProps } from "../../engine/sceneDoc";
import { coverCropRect, remapUv, type UvRect } from "../../engine/screenFit";
import { useTimeline } from "../../engine/timeline";
import { useEditorStore } from "../../store/editorStore";
import { AssetBoundary } from "../media/AssetBoundary";
import { preparingVideoTexture } from "../media/preparingTexture";
import { useSceneStaged, useStageFloorY, useStageMapShadows } from "../stage/context";
import type { V3 } from "../types";
import {
  AVAILABLE_DEVICE_IDS,
  DEVICE_CATALOG,
  type DeviceId,
  deviceColour,
  resolveAvailableDeviceId,
} from "./catalog";
import { DeviceGizmo } from "./DeviceGizmo";
import { DeviceShadow } from "./DeviceShadow";
import { type DevicePose, deviceGizmoMovedY } from "./gizmoCommit";
import { resolveDeviceLayout } from "./layout";
import { HIDDEN_NODES } from "./models";
import { useScreenImageTexture } from "./screenTexture";
import type { DeviceShadowMode, ShadowPose } from "./shadowProjector";
import { deviceFittedHeight, resolveDeviceWorldAnchor } from "./worldAnchor";

/** Media shown on the device screen. Videos ride the deterministic clip-frame pipeline. */
export interface DeviceMediaSpec {
  /** Project-relative path, e.g. `"assets/demo.mp4"` or `"assets/screen.png"`. */
  src: string;
  kind: "video" | "image";
  /** Video only: when playback starts, in ms of scene-local time (default 0). */
  startMs?: number;
  /** Cover-fit is the rule: fill the screen, keep the media's aspect, crop the overflow. */
  fit?: "cover";
}

export type DeviceMotionPreset = "none" | "turntable" | "float" | "tilt-reveal" | "push-in";

export interface DeviceMotionSpec {
  preset: DeviceMotionPreset;
  /** `turntable`: idle spin about Y, degrees/second (default 18). */
  degPerSec?: number;
  /** `float`: vertical bob amplitude in world units (default 0.12). */
  amplitude?: number;
  /** `float`: bob frequency in cycles/second (default 0.4). */
  hz?: number;
  /** `tilt-reveal` / `push-in`: intro length in ms (defaults 1000 / 1200). */
  durationMs?: number;
}

export interface DevicePlacement {
  position?: V3;
  /** Base rotation in DEGREES (scene documents are authored in degrees). */
  rotationDeg?: V3;
  /** Multiplier on the auto-fit scale. */
  scale?: number;
  /** Rest the fitted base on the staged floor (its y replaces `position[1]`); inert when the scene stages no floor backdrop, so the authored position stands. */
  ground?: boolean;
  /** Stamped by `resolveDeviceLayout`, never authored or persisted: the block's authoritative pose. `Device` prefers it over the scalar fields, so scene TSX that post-processes placements (the templates' portrait scale multipliers, frozen at scaffold time) cannot drift a laid-out scene. Post-process only block-less scenes, or delete this field first. */
  resolvedLayout?: { position: V3; rotationDeg: V3; scale: number };
}

export type { DeviceShadowMode };

export function effectiveDeviceShadowMode(shadow: DeviceShadowMode | undefined): DeviceShadowMode {
  return shadow ?? "soft";
}

export interface DeviceProps {
  /** Scene-document id: sidecar devices carry it (it is what the inspector and the gizmo select on), hand-authored ones do not. */
  id?: string;
  /** Catalog id, e.g. `"iphone-15-pro"`. */
  model: DeviceId;
  /** Colour id from the catalog (default: the model's default colour). */
  colour?: string;
  media?: DeviceMediaSpec;
  placement?: DevicePlacement;
  motion?: DeviceMotionSpec;
  /** Presentation shadow: defaults to `"soft"` and remains independent from real `<SceneStage>` map shadows; an explicit value wins. */
  shadow?: DeviceShadowMode;
  /** Bundle the lit set (rig + one-shot environment); defaults true, or false under a lighting `<SceneStage>` since the stage lights the scene; an explicit value wins. */
  lit?: boolean;
  /** Laptop lid opening in degrees (0 closed, default the model's authored angle); ignored by devices with no hinge. */
  lidDeg?: number;
}

export function shouldNeutraliseDeviceMotion(sectionOpen: boolean, exporting: boolean): boolean {
  return sectionOpen && !exporting;
}

export function deviceMotionForRender(
  motion: DeviceMotionSpec,
  sectionOpen: boolean,
  exporting: boolean,
): DeviceMotionSpec {
  return shouldNeutraliseDeviceMotion(sectionOpen, exporting) ? { preset: "none" } : motion;
}

export function deviceAcknowledgementDisposition(
  acknowledgement: Parameters<typeof deviceAcknowledgementMatches>[0],
  commitId: number,
  sceneIndex: number | undefined,
  deviceId: string | undefined,
  editable: boolean,
  requestedCommitIds: ReadonlySet<number>,
  activeCommitId: number | null,
): "ignore" | "consume" | "clear-preview" {
  if (
    !editable ||
    !requestedCommitIds.has(commitId) ||
    !deviceAcknowledgementMatches(acknowledgement, sceneIndex, deviceId)
  ) {
    return "ignore";
  }
  return activeCommitId === commitId ? "clear-preview" : "consume";
}

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
/** Present-slideshow turntable sway amplitude: 45 degrees each way. */
const TURNTABLE_SWAY_RAD = Math.PI / 4;
/** World-space height devices auto-fit to; the framing constant shared with DeviceMockup. */
const TARGET_WORLD_HEIGHT = 2.6;
/** Ground plane sits just under the auto-fit device's bottom edge. */
const GROUND_EPSILON = 0.02;
/** Geometric specular AA (Kaplanyan/Tokuyoshi-Kaplanyan): widens roughness by the perturbed-normal's screen-space variance to kill normal-map specular shimmer (three's own geometryRoughness derives from the non-perturbed normal and misses it); the σ²/κ constants are export contract, applied only to Device's private material clones, never the shared drei glTF cache that DeviceMockup/HeroObject also read. */
const GSAA_FRAGMENT = /* glsl */ `#include <lights_physical_fragment>
{
	vec3 gsaaDx = dFdx( normal );
	vec3 gsaaDy = dFdy( normal );
	float gsaaVariance = 0.25 * ( dot( gsaaDx, gsaaDx ) + dot( gsaaDy, gsaaDy ) );
	float gsaaKernel = min( gsaaVariance, 0.18 );
	material.roughness = min( sqrt( material.roughness * material.roughness + gsaaKernel ), 1.0 );
}`;

function applyDeviceGsaa(material: Material): void {
  if (!(material as MeshStandardMaterial).isMeshStandardMaterial) return;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_physical_fragment>",
      GSAA_FRAGMENT,
    );
  };
  // One stable cache key: all GSAA'd device materials share program variants normally.
  material.customProgramCacheKey = () => "kookaburra-device-gsaa-v1";
}

function materialName(material: Material | Material[]): string | undefined {
  return Array.isArray(material) ? material[0]?.name : material.name;
}

/** Bakes a cover-crop rect into the screen mesh's UVs; stashes the pristine UV set on first bake so a media change re-bakes from the original (re-baking the same rect is a no-op via `uvRectKey`), cloning geometry first since `Object3D.clone` shares geometry with drei's cache. */
function bakeScreenUvs(mesh: Mesh, rect: UvRect): void {
  const key = `${rect.u0}/${rect.v0}/${rect.u1}/${rect.v1}`;
  if (mesh.userData.uvRectKey === key) return;
  if (!mesh.userData.screenBaseUv) {
    mesh.geometry = mesh.geometry.clone();
    const uv = mesh.geometry.getAttribute("uv") as BufferAttribute | undefined;
    if (!uv) return;
    // Read via the attribute API, never the raw array: glTF vertex data is often interleaved (this glb strides 32 bytes), so raw `[i * 2]` indexing reads positions and bakes garbage UVs; getX/getY handle the stride.
    const base = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      base[i * 2] = uv.getX(i);
      base[i * 2 + 1] = uv.getY(i);
    }
    mesh.userData.screenBaseUv = base;
  }
  const base = mesh.userData.screenBaseUv as Float32Array;
  const uv = mesh.geometry.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = remapUv(base[i * 2], base[i * 2 + 1], rect);
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  mesh.userData.uvRectKey = key;
}

/** Video media: drives the screen material from the shared clip-frame pipeline. */
function ScreenVideo(props: {
  src: string;
  startMs: number;
  material: MeshBasicMaterial;
  screens: Mesh[];
  screenAspect: number;
}) {
  const { src, startMs, material, screens, screenAspect } = props;

  // The readiness node lives in this component's own subtree since own-subtree refs attach before layout effects run; a parent's ref is still null during the mount commit, which previously left the binding effect bailing on stale deps and the screen black for the whole clamp window.
  const readyRef = useRef<Group>(null);

  // Until the first frame binds, the screen shows the "Preparing video…" card, except during export where it stays plain black (belt-and-braces atop the preamble/barrier guarantees; the frame bind overwrites `map`, so no cleanup is needed).
  const onPending = useCallback(() => {
    if (isExporting()) {
      material.map = null;
      material.color.set(0x000000);
      material.needsUpdate = true;
      return;
    }
    const rect = coverCropRect(screenAspect, screenAspect, false); // identity, unflipped
    for (const mesh of screens) bakeScreenUvs(mesh, rect);
    material.map = preparingVideoTexture(screenAspect, false);
    material.color.set(0xffffff);
    material.needsUpdate = true;
  }, [material, screens, screenAspect]);
  const onBound = useCallback(() => material.color.set(0xffffff), [material]);

  const { info } = useClipTexture({
    src,
    startMs,
    material,
    readyObjectRef: readyRef,
    onPending,
    onBound,
  });

  useLayoutEffect(() => {
    if (!info) return;
    // Pre-flipped clip bitmaps put the source's bottom row at v=0, but glTF screens have v=0 at the top; flip V in the baked crop (see engine/screenFit.ts).
    const rect = coverCropRect(info.width / info.height, screenAspect, true);
    for (const mesh of screens) bakeScreenUvs(mesh, rect);
  }, [info, screens, screenAspect]);

  return <group ref={readyRef} />;
}

/** Image media: a static texture on the screen material (the DeviceMockup path). A missing asset degrades to an untextured screen; never tear down the canvas tree. */
function ScreenImage(props: {
  src: string;
  material: MeshBasicMaterial;
  screens: Mesh[];
  screenAspect: number;
  projectId: string;
}) {
  const { src, projectId, ...rest } = props;
  let url: string | null = null;
  try {
    url = resolveAssetUrl(projectId, src);
  } catch (e) {
    console.warn(`[device] screen image "${src}" unresolved:`, e);
  }
  if (!url) return null;
  return <ScreenImageLoaded url={url} {...rest} />;
}

function ScreenImageLoaded(props: {
  url: string;
  material: MeshBasicMaterial;
  screens: Mesh[];
  screenAspect: number;
}) {
  const { url, material, screens, screenAspect } = props;
  const loaded = useTexture(url);
  const tex = useScreenImageTexture(loaded);

  useLayoutEffect(() => {
    material.map = tex;
    material.color.set(0xffffff);
    material.needsUpdate = true;
    const image = tex.image as { width?: number; height?: number } | undefined;
    const aspect = image?.width && image?.height ? image.width / image.height : screenAspect;
    const rect = coverCropRect(aspect, screenAspect, false);
    for (const mesh of screens) bakeScreenUvs(mesh, rect);
  }, [tex, material, screens, screenAspect]);

  return null;
}

/** The pillar device primitive: the export preamble awaits `preloadCatalogModels` / `preextractClips` / `preloadProjectImages` so every frame renders synchronously after load; see docs/determinism.md and docs/decisions.md. */
export function Device(props: DeviceProps) {
  const {
    id,
    model,
    colour,
    media,
    placement = {},
    motion = { preset: "none" },
    shadow,
    lit,
    lidDeg,
  } = props;
  // The layout stamp wins over the scalar fields (see DevicePlacement.resolvedLayout).
  const position = placement.resolvedLayout?.position ?? placement.position ?? [0, 0, 0];
  const rotationDeg = placement.resolvedLayout?.rotationDeg ?? placement.rotationDeg ?? [0, 0, 0];
  const scale = placement.resolvedLayout?.scale ?? placement.scale ?? 1;
  const ground = placement.ground ?? false;

  const { localMs } = useTimeline();
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const groupRef = useRef<Group>(null);

  const ctx = useSceneContext();
  const sceneIndex = ctx?.index;
  // The gizmo drives the pose through state, not the group directly: the clock re-renders this component every frame, which would stomp a mutated group. Never reaches an export (the gizmo unmounts when `exportPreamble` clears the selection, and `isExporting` is the belt to that brace).
  const [drag, setDrag] = useState<DevicePose | null>(null);
  const [gizmoResetKey, setGizmoResetKey] = useState(0);
  const activeCommitId = useRef<number | null>(null);
  const requestedCommitIds = useRef(new Set<number>());
  const selected = useDeviceEditStore((s) => s.selected);
  const acknowledgements = useDeviceEditStore((s) => s.acknowledgements);
  const sectionOpen = useGizmoSectionOpen("devices");
  const exporting = isExporting();
  // What a click selects, or null for a hand-authored device and for a comparison's B side (which edits through the compare drill, so a write would land on the wrong doc).
  const editTarget =
    id !== undefined && sceneIndex !== undefined && ctx?.side === undefined
      ? { sceneIndex, deviceId: id }
      : null;
  const editable = editTarget !== null;
  const gizmoOn =
    !exporting &&
    editTarget !== null &&
    sectionOpen &&
    selected?.sceneIndex === editTarget.sceneIndex &&
    selected.deviceId === editTarget.deviceId;
  const dragged = drag && !exporting ? drag : null;
  const committed: DevicePose = { position, rotationDeg, scale };
  const raw = dragged ?? committed;
  // `patchDoc` is async, so the drag pose holds until the COMMITTED placement changes (a commit, a slider, a preset or an undo), never on pointer-up.
  const poseKey = `${position.join()}|${rotationDeg.join()}|${scale}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the committed pose IS the clear signal
  useEffect(() => {
    setDrag(null);
  }, [poseKey]);
  useEffect(() => {
    if (!gizmoOn) {
      activeCommitId.current = null;
      setDrag(null);
    }
  }, [gizmoOn]);
  useEffect(() => {
    if (!editable) return;
    for (const [rawCommitId, acknowledgement] of Object.entries(acknowledgements)) {
      const commitId = Number(rawCommitId);
      const disposition = deviceAcknowledgementDisposition(
        acknowledgement,
        commitId,
        sceneIndex,
        id,
        editable,
        requestedCommitIds.current,
        activeCommitId.current,
      );
      if (disposition === "ignore") continue;
      requestedCommitIds.current.delete(commitId);
      if (disposition === "clear-preview") {
        activeCommitId.current = null;
        setDrag(null);
        setGizmoResetKey((key) => key + 1);
      }
      useDeviceEditStore.getState().clearAcknowledgement(commitId);
    }
  }, [acknowledgements, editable, id, sceneIndex]);
  const renderedMotion = deviceMotionForRender(motion, sectionOpen, exporting);
  const introMs =
    motion.preset === "tilt-reveal"
      ? (motion.durationMs ?? 1000)
      : motion.preset === "push-in"
        ? (motion.durationMs ?? 1200)
        : null;
  useEffect(() => {
    if (sceneIndex === undefined || introMs === null) return;
    return registerPresentTiming(sceneIndex, { kind: "device-motion", toMs: introMs });
  }, [sceneIndex, introMs]);

  // Staged scenes light themselves; the bundled lit set stands down by default.
  const staged = useSceneStaged();
  const isLit = lit ?? !staged;
  // Map-shadowed stages add real cast/receive shadows; the independent presentation shadow remains governed only by shadow.
  const mapShadows = useStageMapShadows();
  const stageFloorY = useStageFloorY();
  const shadowMode = effectiveDeviceShadowMode(shadow);

  const renderModel = resolveAvailableDeviceId(model);
  const activeSpec = DEVICE_CATALOG[renderModel];
  useEffect(() => {
    if (renderModel !== model) {
      console.warn(`Device: model "${model}" is unavailable in this build, using Android`);
    }
  }, [model, renderModel]);

  const { scene } = useGLTF(activeSpec.glbUrl);
  // Memoised because custom tints mint a fresh spec per call, and colourSpec keys the clone below.
  const colourSpec = useMemo(() => deviceColour(activeSpec, colour), [activeSpec, colour]);

  // The media material is owned here (StrictMode-safe, see VideoClip) and starts black so a device with no media, or frames not yet bound, shows a dark plausible screen.
  const screenMaterial = useMemo(() => {
    const m = new MeshBasicMaterial({ color: new Color(0x000000) });
    m.toneMapped = false;
    return m;
  }, []);
  useLayoutEffect(() => () => screenMaterial.dispose(), [screenMaterial]);

  // Clone once per (model, colour) since drei's glTF cache is shared: hide helper nodes, swap the display material, and give every lit material a private clone (Object3D.clone shares materials) so colour overrides and GSAA apply without touching the shared cache that DeviceMockup/HeroObject also read; then recentre + auto-fit.
  const { root, fit, screens, lidNode, lidBaseX, bodySize } = useMemo(() => {
    const clone = scene.clone(true);
    const screens: Mesh[] = [];
    const hide: Object3D[] = [];
    let lidNode: Object3D | null = null;
    const prepared = new Map<Material, Material>();
    clone.traverse((obj: Object3D) => {
      if (HIDDEN_NODES.has(obj.name)) {
        hide.push(obj);
        return;
      }
      if (activeSpec.lid && obj.name === activeSpec.lid.node) lidNode = obj;
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const name = materialName(mesh.material);
      if (name === activeSpec.screen.material) {
        mesh.material = screenMaterial;
        screens.push(mesh);
        return;
      }
      if (Array.isArray(mesh.material)) return;
      let preparedMaterial = prepared.get(mesh.material);
      if (!preparedMaterial) {
        preparedMaterial = mesh.material.clone();
        const override = name ? colourSpec.overrides[name] : undefined;
        if (override?.color) {
          (preparedMaterial as unknown as { color?: Color }).color?.set(override.color);
        }
        const std = preparedMaterial as MeshStandardMaterial;
        if (override?.roughness !== undefined) std.roughness = override.roughness;
        if (override?.metalness !== undefined) std.metalness = override.metalness;
        applyDeviceGsaa(preparedMaterial);
        prepared.set(mesh.material, preparedMaterial);
      }
      mesh.material = preparedMaterial;
    });
    for (const obj of hide) obj.removeFromParent();

    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    clone.position.sub(center);
    const fitAxis = activeSpec.fit?.axis ?? "height";
    const fitTarget = activeSpec.fit?.target ?? TARGET_WORLD_HEIGHT;
    const fit =
      fitAxis === "width"
        ? size.x > 1e-6
          ? fitTarget / size.x
          : 1
        : size.y > 1e-6
          ? fitTarget / size.y
          : 1;
    // The hinge's authored rotation; the lid effect scales it by lidDeg / openDeg.
    const lidBaseX = lidNode ? (lidNode as Object3D).rotation.x : 0;
    // Perf-probe marker: the no-devices elimination pass hides these roots.
    clone.userData.kookaburraDevice = true;
    return {
      root: clone,
      fit,
      screens,
      lidNode,
      lidBaseX,
      bodySize: [size.x, size.y, size.z] as V3,
    };
  }, [scene, activeSpec, colourSpec, screenMaterial]);
  const fittedHeight = deviceFittedHeight(activeSpec.id);

  // Lid angle: a static pose from the doc (pure data, no clock), applied pre-paint.
  useLayoutEffect(() => {
    if (!lidNode || !activeSpec.lid) return;
    const open = Math.max(0, Math.min(activeSpec.lid.openDeg, lidDeg ?? activeSpec.lid.defaultDeg));
    (lidNode as Object3D).rotation.x = lidBaseX * (open / activeSpec.lid.openDeg);
  }, [lidNode, lidBaseX, lidDeg, activeSpec]);

  // Real shadows on map-shadowed stages flip the private clone's meshes; inert (no recompiles, no shadow passes) for unstaged scenes, where no shadow-casting light exists.
  useLayoutEffect(() => {
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = mapShadows;
        mesh.receiveShadow = mapShadows;
      }
    });
  }, [root, mapShadows]);

  // Motion presets: pure functions of the timeline value, never the wall clock.
  const t = localMs / 1000;
  let spinY = 0;
  let floatY = 0;
  let introScale = 1;
  let introRotX = 0;
  let introRotY = 0;
  switch (renderedMotion.preset) {
    case "turntable": {
      const rate = (renderedMotion.degPerSec ?? 18) * DEG2RAD;
      // Slideshow holds are open-ended, where an endless 360 spin distracts; sway 45 degrees each way instead, with the peak sway speed matching the authored spin rate. Video playback and export keep the true turntable.
      spinY = presentSlideshowActive()
        ? TURNTABLE_SWAY_RAD * Math.sin((rate / TURNTABLE_SWAY_RAD) * t)
        : rate * t;
      break;
    }
    case "float":
      // Rises from the resting pose to amplitude and back, never below it: devices sit on the stage floor, so the old symmetric sine clipped through on the down half.
      floatY =
        (renderedMotion.amplitude ?? 0.12) *
        0.5 *
        (1 - Math.cos(TWO_PI * (renderedMotion.hz ?? 0.4) * t));
      break;
    case "tilt-reveal": {
      // Entrance: eases from tilted-away to the resting pose, then holds.
      const p = ease("outCubic", Math.min(1, localMs / (renderedMotion.durationMs ?? 1000)));
      introRotX = (1 - p) * -14 * DEG2RAD;
      introRotY = (1 - p) * -40 * DEG2RAD;
      break;
    }
    case "push-in": {
      // Entrance: slightly small and angled, easing up to full framing.
      const p = ease("outCubic", Math.min(1, localMs / (renderedMotion.durationMs ?? 1200)));
      introScale = 0.86 + 0.14 * p;
      introRotY = (1 - p) * -8 * DEG2RAD;
      break;
    }
    default:
      break;
  }

  const groundY = -(fittedHeight / 2) * raw.scale - GROUND_EPSILON;
  // Everything the inner group applies, handed to the shadow projector so the cast follows the pose.
  const shadowPose: ShadowPose = {
    scale: raw.scale,
    rotation: [
      raw.rotationDeg[0] * DEG2RAD + introRotX,
      raw.rotationDeg[1] * DEG2RAD + spinY + introRotY,
      raw.rotationDeg[2] * DEG2RAD,
    ],
    offset: [0, floatY, 0],
    introScale,
    lidDeg: lidDeg ?? activeSpec.lid?.defaultDeg ?? 0,
  };
  // Grounded placement: the pure anchor resolver is shared with object-bound camera aims.
  const grounded = (pose: DevicePose): V3 =>
    resolveDeviceWorldAnchor(
      { model: activeSpec.id },
      { position: pose.position, rotationDeg: pose.rotationDeg, scale: pose.scale, ground },
      stageFloorY,
    ) ?? pose.position;
  const renderedCommitted = { ...committed, position: grounded(committed) };
  const groupPosition =
    dragged && deviceGizmoMovedY(dragged, renderedCommitted) ? dragged.position : grounded(raw);

  return (
    <>
      <group ref={groupRef} position={groupPosition}>
        {isLit && (
          <>
            <ambientLight intensity={0.7} />
            <directionalLight position={[4, 6, 5]} intensity={2.4} />
            <directionalLight position={[-5, 2, -3]} intensity={0.9} />
            {/* Procedural, offline environment (rendered once) so the titanium reads as metal; the DeviceMockup set. */}
            <Environment resolution={256} frames={1}>
              <Lightformer form="rect" intensity={2} position={[0, 3, 4]} scale={8} />
              <Lightformer form="rect" intensity={1.2} position={[-4, 1, 2]} scale={5} />
              <Lightformer form="rect" intensity={1} position={[4, -1, 3]} scale={5} />
            </Environment>
          </>
        )}
        {shadowMode !== "none" && (
          <DeviceShadow spec={activeSpec} mode={shadowMode} pose={shadowPose} groundY={groundY} />
        )}
        {/* Float rides an inner group; the shadow reads its pose instead of riding with it, so the receiver stays on the floor while the occluder lifts. */}
        <group
          position={[0, floatY, 0]}
          rotation={[
            raw.rotationDeg[0] * DEG2RAD + introRotX,
            raw.rotationDeg[1] * DEG2RAD + spinY + introRotY,
            raw.rotationDeg[2] * DEG2RAD,
          ]}
          scale={introScale}
        >
          <group scale={raw.scale * fit}>
            <primitive object={root} />
            {editTarget && (
              <SceneOutline
                size={bodySize}
                domain="devices"
                selected={gizmoOn}
                onSelect={() => useDeviceEditStore.getState().select(editTarget)}
              />
            )}
          </group>
        </group>
        {media?.kind === "video" && (
          <ScreenVideo
            src={media.src}
            startMs={media.startMs ?? 0}
            material={screenMaterial}
            screens={screens}
            screenAspect={activeSpec.screen.aspect}
          />
        )}
        {media?.kind === "image" && (
          <AssetBoundary key={media.src} label={media.src}>
            <ScreenImage
              src={media.src}
              material={screenMaterial}
              screens={screens}
              screenAspect={activeSpec.screen.aspect}
              projectId={projectId}
            />
          </AssetBoundary>
        )}
      </group>
      {editTarget && gizmoOn && !exporting && (
        <DeviceGizmo
          deviceId={editTarget.deviceId}
          sceneIndex={editTarget.sceneIndex}
          committed={committed}
          rendered={renderedCommitted}
          resetKey={gizmoResetKey}
          onDrag={(pose) => {
            if (pose) activeCommitId.current = null;
            setDrag(pose);
          }}
          onCommitRequested={(commitId) => {
            requestedCommitIds.current.add(commitId);
            activeCommitId.current = commitId;
          }}
        />
      )}
    </>
  );
}

/** Host-side devices for scenes whose TSX never wires `useSceneDevices` (mounted by App's SceneHost, never scene TSX): reads the doc directly so it can't register as a consumer itself, and mirrors the device template's portrait scale so Add device looks the same on any scene kind. A `deviceLayout` block routes through `resolveDeviceLayout` instead; block-less scenes keep the legacy path byte-identically. */
export function DevicesFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesDevices(sceneIndex);
  const format = useFormat();
  const portrait = format.aspect < 1;
  const devices = doc?.devices ?? [];
  const layout = doc?.deviceLayout;
  if (consumed || devices.length === 0) return null;
  if (layout) {
    const placements = resolveDeviceLayout(devices, layout, format);
    return (
      <>
        {devices.map((d, i) => (
          <Device key={d.id} {...(d as SceneDeviceProps)} placement={placements[i]} />
        ))}
      </>
    );
  }
  return (
    <>
      {devices.map((d) => (
        <Device
          key={d.id}
          {...(d as SceneDeviceProps)}
          placement={{
            ...d.placement,
            scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
          }}
        />
      ))}
    </>
  );
}

// Warm drei's cache so the first render has geometry ready; the export preamble awaits `preloadCatalogModels()` for the hard barrier.
{
  const urls = new Set(AVAILABLE_DEVICE_IDS.map((id) => DEVICE_CATALOG[id].glbUrl));
  for (const url of urls) useGLTF.preload(url);
}
