import { useContext, useId, useLayoutEffect } from "react";
import { isAssetReference, isUnloadableAssetPath } from "../toolkit/frame/icon";
import { AnimatedGroup } from "../toolkit/group/AnimatedGroup";
import { ImageCard } from "../toolkit/media/ImageCard";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";
import { type ManagedTextRenderRole, shouldRenderManagedTextRole } from "./managedText";
import { SceneDocContext, useSceneContext } from "./sceneContext";
import { useTextKeyRegistry } from "./textKeyRegistry";

/** Asset images draw at this multiple of the nominal glyph size, grown around the nominal box's centre so header stacking budgets still hold: an emoji's ink under-fills its em box while an image fills its box, and a header image should read a touch larger than an emoji mark (tuned by eye). */
const ASSET_ICON_SCALE = 1.3;

/** One frame icon: the panel's top icon, or a chip's inline mark. An emoji or glyph draws through the text pipeline (so emoji route to colour quads); a project asset path draws through `ImageCard` (Suspense-settled in the export preamble). `position` anchors the icon's TOP-LEFT so it stacks with sibling text; images fit a square `size` box. All motion is a timeline window, never the wall clock. See docs/overlays.md. */
export function FrameIcon({
  icon,
  position,
  size,
  from,
  to,
  color,
  anchorX = "left",
  textKey,
  managedTextRole = "scene",
}: {
  icon: string;
  /** The anchor point, world (y-up); `anchorX` picks which horizontal edge it pins, `anchorY` is always top. */
  position: V3;
  /** Icon box edge, world units, BEFORE the sidecar's size multiplier (callers scale their own stacking budget). */
  size: number;
  from?: number;
  to?: number;
  /** Fill for a glyph mark (e.g. a chip tick); ignored for emoji (own colour) and images. */
  color?: "text" | "muted" | "accent" | (string & {});
  /** Which horizontal edge `position[0]` pins; default "left". */
  anchorX?: "left" | "center" | "right";
  /** The sidecar style key this mark honours ("icon" for a header icon); a chip's inline mark passes none and never scales. */
  textKey?: string;
  managedTextRole?: ManagedTextRenderRole;
}) {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const mountId = useId();
  const registeredSize = textKey ? doc?.textStyle?.[`${textKey}Size`] : undefined;
  const registeredOffsetX = textKey ? doc?.textStyle?.[`${textKey}OffsetX`] : undefined;
  const registeredOffsetY = textKey ? doc?.textStyle?.[`${textKey}OffsetY`] : undefined;
  const registeredRotation = textKey ? doc?.textStyle?.[`${textKey}RotationDeg`] : undefined;
  useLayoutEffect(() => {
    if (
      sceneIndex === undefined ||
      !textKey ||
      managedTextRole !== "scene" ||
      doc?.managedText !== undefined
    ) {
      return;
    }
    useTextKeyRegistry.getState().register(sceneIndex, textKey, mountId, {
      resolvedText: "",
      managedType: "icon",
      icon,
      styleCapable: true,
      style: {
        size: typeof registeredSize === "number" ? registeredSize : 1,
        offsetX: typeof registeredOffsetX === "number" ? registeredOffsetX : 0,
        offsetY: typeof registeredOffsetY === "number" ? registeredOffsetY : 0,
        rotationDeg: typeof registeredRotation === "number" ? registeredRotation : 0,
      },
    });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, textKey, mountId);
  }, [
    sceneIndex,
    textKey,
    mountId,
    managedTextRole,
    doc?.managedText,
    icon,
    registeredSize,
    registeredOffsetX,
    registeredOffsetY,
    registeredRotation,
  ]);
  if (!shouldRenderManagedTextRole(doc, managedTextRole)) return null;
  if (isAssetReference(icon)) {
    // ImageCard centres its plane on `position`; offset by the anchor so the square box pins the chosen edge. The glyph branch gets its multiplier inside AnimatedHeadline, so only images apply it here.
    const sizeValue = textKey ? doc?.textStyle?.[`${textKey}Size`] : undefined;
    const offX = textKey ? doc?.textStyle?.[`${textKey}OffsetX`] : undefined;
    const offY = textKey ? doc?.textStyle?.[`${textKey}OffsetY`] : undefined;
    const rotation = textKey ? doc?.textStyle?.[`${textKey}RotationDeg`] : undefined;
    const box = size * (typeof sizeValue === "number" ? sizeValue : 1);
    const f = anchorX === "left" ? 1 : anchorX === "center" ? 0 : -1;
    const centre: V3 = [
      position[0] + (box / 2) * f + (typeof offX === "number" ? offX : 0),
      position[1] - box / 2 + (typeof offY === "number" ? offY : 0),
      position[2],
    ];
    if (managedTextRole === "managed") {
      return (
        <AnimatedGroup
          position={centre}
          from={from}
          to={to}
          textKey={textKey}
          extent={[box, box]}
          imageEffects
        >
          <group rotation={[0, 0, typeof rotation === "number" ? (-rotation * Math.PI) / 180 : 0]}>
            <ImageCard src={icon} width={box * ASSET_ICON_SCALE} />
          </group>
        </AnimatedGroup>
      );
    }
    if (typeof rotation === "number" && rotation !== 0) {
      return (
        <group position={centre} rotation={[0, 0, (-rotation * Math.PI) / 180]}>
          <ImageCard src={icon} width={box * ASSET_ICON_SCALE} from={from} to={to} />
        </group>
      );
    }
    return (
      <ImageCard src={icon} position={centre} width={box * ASSET_ICON_SCALE} from={from} to={to} />
    );
  }
  if (isUnloadableAssetPath(icon)) return null;
  return (
    <AnimatedHeadline
      text={icon}
      position={position}
      fontSize={size}
      anchorX={anchorX}
      anchorY="top"
      {...(from !== undefined ? { from } : {})}
      {...(to !== undefined ? { to } : {})}
      {...(color !== undefined ? { color } : {})}
      {...(textKey !== undefined ? { textKey } : {})}
      managedTextRole={managedTextRole}
    />
  );
}
