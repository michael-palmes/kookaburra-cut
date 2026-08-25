import { useTexture } from "@react-three/drei";
import { useContext, useLayoutEffect, useMemo } from "react";
import {
  DataTexture,
  MeshBasicMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
} from "three";
import { useEditorStore } from "../store/editorStore";
import { useTheme } from "../theme";
import { AssetBoundary } from "../toolkit/media/AssetBoundary";
import {
  applyCardMask,
  cardUniforms,
  SHADOW_FRAG,
  SHADOW_VERT,
} from "../toolkit/media/LayeredScreenshot";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import { useFormat } from "./format";
import { resolveAssetUrl } from "./project";
import { ProjectIdContext } from "./sceneContext";
import { useSceneDoc } from "./sceneDoc";
import {
  type ResolvedSceneTerminal,
  resolveSceneTerminal,
  type SceneTerminalFrameLayout,
  sceneTerminalLayout,
} from "./sceneTerminal";
import { resolveTerminalColours, type SceneTerminalColours } from "./sceneTerminalTheme";

/** The terminal block's screen-locked window: chrome (shadow, rounded body, bezel, traffic lights, title) rendered live from the theme, with the captured snapshot raster as the screen pixels and a resting block cursor before any capture exists. Mounted inside the frame-panel group, so the compositor draws it over the composited slide from the base pose; everything here is a pure function of the doc + theme (no clock reads). The interactive DOM overlay shares `sceneTerminalLayout`, so the live xterm and these pixels cannot drift. */

const WINDOW_STROKE_ALPHA = 0.16;
/** Window edge stroke, as a fraction of the cell height. */
const WINDOW_STROKE_CELLS = 0.045;
/** macOS traffic-light chrome constants (fixed, not themed), in title-bar heights. */
const LIGHT_RADIUS = 0.214;
const LIGHT_SPACING = 0.714;
const LIGHT_COLOURS = ["#ff5f57", "#febc2e", "#28c840"] as const;

/** One shared 1x1 white map so colour-only planes compile the shipped card-mask program (its SDF lives under `USE_MAP`). */
let whiteMap: DataTexture | null = null;
function sharedWhiteMap(): DataTexture {
  if (!whiteMap) {
    whiteMap = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteMap.colorSpace = SRGBColorSpace;
    whiteMap.needsUpdate = true;
  }
  return whiteMap;
}

interface RectCS {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A flat rounded-rect plane through the shared card-mask program (radius 0 leaves it square). */
function CardPlane({
  rect,
  colour,
  radius,
  strokeColour,
  strokeWidth = 0,
  strokeAlpha = 0,
  renderOrder,
}: {
  rect: RectCS;
  colour: string;
  radius: number;
  strokeColour?: string;
  strokeWidth?: number;
  strokeAlpha?: number;
  renderOrder: number;
}) {
  const card = useMemo(() => cardUniforms(), []);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    m.map = sharedWhiteMap();
    applyCardMask(m, card);
    return m;
  }, [card]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  material.color.set(colour);
  card.uCardSize.value.set(rect.width, rect.height);
  card.uCardRadius.value = radius;
  if (strokeColour) card.uCardStrokeColor.value.set(strokeColour);
  card.uCardStrokeWidth.value = strokeWidth;
  card.uCardStrokeAlpha.value = strokeAlpha;
  return (
    <mesh position={[rect.x, rect.y, 0]} material={material} renderOrder={renderOrder}>
      <planeGeometry args={[rect.width, rect.height]} />
    </mesh>
  );
}

/** The window's analytic drop shadow (the shared rounded-rect shadow shaders), a soft undirected drop. */
function TerminalShadow({
  rect,
  radius,
  cellH,
  renderOrder,
}: {
  rect: RectCS;
  radius: number;
  cellH: number;
  renderOrder: number;
}) {
  const blur = cellH * 1.4;
  const width = rect.width + blur * 2;
  const height = rect.height + blur * 2;
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: {
          uSize: { value: new Vector2(width, height) },
          uHalf: { value: new Vector2(rect.width / 2, rect.height / 2) },
          uRadius: { value: radius },
          uBlur: { value: blur },
          uOpacity: { value: 0.34 },
        },
      }),
    [width, height, rect.width, rect.height, radius, blur],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);
  return (
    <mesh
      position={[rect.x, rect.y - cellH * 0.35, -0.01]}
      material={material}
      renderOrder={renderOrder}
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}

/** The captured raster, contain-fitted and anchored to the grid's top-left so a cols/rows change never stretches old pixels. */
function SnapshotImage({
  url,
  layout,
  renderOrder,
}: {
  url: string;
  layout: SceneTerminalFrameLayout;
  renderOrder: number;
}) {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    m.toneMapped = false;
    m.map = texture;
    return m;
  }, [texture]);
  useLayoutEffect(() => () => material.dispose(), [material]);

  const img = texture.image as { width: number; height: number };
  const { grid } = layout;
  const textureAspect = img.width / img.height;
  const fitWidth = textureAspect >= grid.width / grid.height;
  const width = fitWidth ? grid.width : grid.height * textureAspect;
  const height = fitWidth ? grid.width / textureAspect : grid.height;
  return (
    <mesh
      position={[grid.left + width / 2, grid.top - height / 2, 0]}
      material={material}
      renderOrder={renderOrder}
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}

function TerminalWindow({
  terminal,
  orderBase,
}: {
  terminal: ResolvedSceneTerminal;
  orderBase: number;
}) {
  const format = useFormat();
  const theme = useTheme();
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const layout = useMemo(
    () => sceneTerminalLayout(terminal, format.frame),
    [terminal, format.frame],
  );
  const colours: SceneTerminalColours = useMemo(
    () => resolveTerminalColours(terminal.theme, theme),
    [terminal.theme, theme],
  );

  const mac = terminal.chrome.style === "mac";
  const { window, screen, grid, cell, radius, titleBarHeight } = layout;
  let snapshotUrl: string | null = null;
  if (terminal.snapshot?.src) {
    try {
      snapshotUrl = resolveAssetUrl(projectId, terminal.snapshot.src);
    } catch (e) {
      console.warn(`[terminal] snapshot "${terminal.snapshot.src}" unresolved:`, e);
    }
  }

  const lightY = window.y + window.height / 2 - titleBarHeight / 2;
  const lightR = LIGHT_RADIUS * titleBarHeight;
  const lightX0 = window.x - window.width / 2 + LIGHT_SPACING * titleBarHeight;
  return (
    <>
      <TerminalShadow rect={window} radius={radius} cellH={cell.height} renderOrder={orderBase} />
      <CardPlane
        rect={window}
        colour={mac ? colours.bezel : colours.screen}
        radius={radius}
        strokeColour={colours.stroke}
        strokeWidth={WINDOW_STROKE_CELLS * cell.height}
        strokeAlpha={WINDOW_STROKE_ALPHA}
        renderOrder={orderBase + 1}
      />
      {mac && (
        <CardPlane rect={screen} colour={colours.screen} radius={0} renderOrder={orderBase + 2} />
      )}
      {snapshotUrl ? (
        <AssetBoundary key={snapshotUrl} label={terminal.snapshot?.src ?? "terminal snapshot"}>
          <SnapshotImage url={snapshotUrl} layout={layout} renderOrder={orderBase + 3} />
        </AssetBoundary>
      ) : (
        <CardPlane
          rect={{
            x: grid.left + (cell.width * 0.92) / 2,
            y: grid.top - (cell.height * 0.82) / 2,
            width: cell.width * 0.92,
            height: cell.height * 0.82,
          }}
          colour={colours.cursor}
          radius={0}
          renderOrder={orderBase + 3}
        />
      )}
      {mac &&
        LIGHT_COLOURS.map((colour, i) => (
          <mesh
            key={colour}
            position={[lightX0 + i * LIGHT_SPACING * titleBarHeight, lightY, 0]}
            renderOrder={orderBase + 4}
          >
            <circleGeometry args={[lightR, 24]} />
            <meshBasicMaterial color={colour} toneMapped={false} transparent depthWrite={false} />
          </mesh>
        ))}
      {mac && terminal.chrome.title.trim().length > 0 && (
        <group renderOrder={orderBase + 5}>
          <AnimatedHeadline
            text={terminal.chrome.title}
            fontSize={titleBarHeight * 0.42}
            face="body"
            color={colours.titleText}
            anchorX="center"
            anchorY="middle"
            position={[window.x, lightY, 0]}
            maxWidth={window.width - 6 * LIGHT_SPACING * titleBarHeight}
            managedTextRole="embedded"
          />
        </group>
      )}
    </>
  );
}

/** Mounts the doc's terminal window, standing down when the scene has no block (the null-for-legacy path). */
export function SceneTerminalPanel({ orderBase }: { orderBase: number }) {
  const doc = useSceneDoc();
  const terminal = useMemo(() => resolveSceneTerminal(doc ?? undefined), [doc]);
  if (!terminal) return null;
  return <TerminalWindow terminal={terminal} orderBase={orderBase} />;
}
