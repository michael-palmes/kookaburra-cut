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
import { assetVersionKey, useAssetVersionStore } from "../store/assetVersionStore";
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
  type ResolvedSceneWebsite,
  resolveSceneWebsite,
  type SceneWebsiteFrameLayout,
  sceneWebsiteLayout,
} from "./sceneWebsite";
import { resolveWebsiteColours } from "./sceneWebsiteTheme";

interface RectCS {
  x: number;
  y: number;
  width: number;
  height: number;
}

let whiteMap: DataTexture | null = null;
function sharedWhiteMap(): DataTexture {
  if (!whiteMap) {
    whiteMap = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteMap.colorSpace = SRGBColorSpace;
    whiteMap.needsUpdate = true;
  }
  return whiteMap;
}

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
    const next = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    next.toneMapped = false;
    next.map = sharedWhiteMap();
    applyCardMask(next, card);
    return next;
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

function WebsiteShadow({
  website,
  layout,
  renderOrder,
}: {
  website: ResolvedSceneWebsite;
  layout: SceneWebsiteFrameLayout;
  renderOrder: number;
}) {
  const strong = website.frame.shadow === "strong";
  const blur = layout.toolbarHeight * (strong ? 1.15 : 0.72);
  const width = layout.window.width + blur * 2;
  const height = layout.window.height + blur * 2;
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: {
          uSize: { value: new Vector2(width, height) },
          uHalf: { value: new Vector2(layout.window.width / 2, layout.window.height / 2) },
          uRadius: { value: layout.radius },
          uBlur: { value: blur },
          uOpacity: { value: strong ? 0.42 : 0.24 },
        },
      }),
    [width, height, layout.window.width, layout.window.height, layout.radius, blur, strong],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);
  if (website.frame.shadow === "none") return null;
  return (
    <mesh
      position={[
        layout.window.x,
        layout.window.y - layout.toolbarHeight * (strong ? 0.34 : 0.2),
        -0.01,
      ]}
      material={material}
      renderOrder={renderOrder}
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  );
}

function CaptureImage({
  url,
  page,
  renderOrder,
}: {
  url: string;
  page: RectCS;
  renderOrder: number;
}) {
  const texture = useTexture(url) as Texture;
  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  const material = useMemo(() => {
    const next = new MeshBasicMaterial({ transparent: true, depthWrite: false, map: texture });
    next.toneMapped = false;
    return next;
  }, [texture]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  return (
    <mesh position={[page.x, page.y, 0]} material={material} renderOrder={renderOrder}>
      <planeGeometry args={[page.width, page.height]} />
    </mesh>
  );
}

function WebsiteWindow({
  website,
  orderBase,
}: {
  website: ResolvedSceneWebsite;
  orderBase: number;
}) {
  const format = useFormat();
  const theme = useTheme();
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((state) => state.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const layout = useMemo(() => sceneWebsiteLayout(website, format.frame), [website, format.frame]);
  const colours = useMemo(() => resolveWebsiteColours(website, theme), [website, theme]);
  const captureSrc = website.capture?.src ?? null;
  const version = useAssetVersionStore((state) =>
    projectId && captureSrc ? (state.versions[assetVersionKey(projectId, captureSrc)] ?? 0) : 0,
  );
  let captureUrl: string | null = null;
  if (captureSrc) {
    try {
      captureUrl = resolveAssetUrl(projectId, captureSrc) + (version > 0 ? `?v=${version}` : "");
    } catch (error) {
      console.warn(`[website] capture "${captureSrc}" unresolved:`, error);
    }
  }

  const { window, toolbar, page, originBar, controls, radius, toolbarHeight } = layout;
  const originLabel = website.origin ?? "Website not configured";
  return (
    <>
      <WebsiteShadow website={website} layout={layout} renderOrder={orderBase} />
      <CardPlane
        rect={window}
        colour={colours.toolbar}
        radius={radius}
        strokeColour={colours.stroke}
        strokeWidth={Math.max(window.width / website.viewport.width, 0.004)}
        strokeAlpha={0.18}
        renderOrder={orderBase + 1}
      />
      <CardPlane rect={page} colour={colours.page} radius={0} renderOrder={orderBase + 2} />
      {captureUrl ? (
        <AssetBoundary key={captureUrl} label={captureSrc ?? "website capture"}>
          <CaptureImage url={captureUrl} page={page} renderOrder={orderBase + 3} />
        </AssetBoundary>
      ) : (
        <group renderOrder={orderBase + 3}>
          <AnimatedHeadline
            text="Capture required"
            preset="none"
            fontSize={Math.min(page.width, page.height) * 0.045}
            face="body"
            color={colours.muted}
            anchorX="center"
            anchorY="middle"
            position={[page.x, page.y, 0]}
            managedTextRole="embedded"
          />
        </group>
      )}
      <CardPlane
        rect={toolbar}
        colour={colours.toolbar}
        radius={radius * 0.72}
        renderOrder={orderBase + 4}
      />
      <CardPlane
        rect={originBar}
        colour={colours.originBar}
        radius={originBar.height / 2}
        renderOrder={orderBase + 5}
      />
      {["‹", "›", "↻"].map((label, index) => (
        <group key={label} renderOrder={orderBase + 6}>
          <AnimatedHeadline
            text={label}
            preset="none"
            fontSize={toolbarHeight * 0.34}
            face="body"
            color={index === 1 ? colours.muted : colours.text}
            anchorX="center"
            anchorY="middle"
            position={[controls.x + index * controls.gap, controls.y, 0]}
            managedTextRole="embedded"
          />
        </group>
      ))}
      <group renderOrder={orderBase + 7}>
        <AnimatedHeadline
          text={originLabel}
          preset="none"
          fontSize={toolbarHeight * 0.24}
          face="body"
          color={colours.text}
          anchorX="left"
          anchorY="middle"
          position={[originBar.x - originBar.width / 2 + originBar.height * 0.35, originBar.y, 0]}
          maxWidth={originBar.width - originBar.height * 0.7}
          managedTextRole="embedded"
        />
      </group>
    </>
  );
}

export function SceneWebsitePanel({ orderBase }: { orderBase: number }) {
  const doc = useSceneDoc();
  const website = useMemo(() => resolveSceneWebsite(doc ?? undefined), [doc]);
  if (!website) return null;
  return <WebsiteWindow website={website} orderBase={orderBase} />;
}
