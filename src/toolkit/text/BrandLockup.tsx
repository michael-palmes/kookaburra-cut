import { useContext, useId, useLayoutEffect, useMemo } from "react";
import { ASSET_ICON_SCALE, FrameIcon } from "../../engine/FrameIcon";
import { useFormat } from "../../engine/format";
import {
  isTemplateManagedText,
  resolveTemplateManagedTextCopy,
  resolveTemplateManagedTextIcon,
  specialisedBrandLockupMode,
  templateManagedTextOverridesCodedMotion,
} from "../../engine/managedText";
import {
  SceneDocContext,
  SceneTextClaimedContext,
  useSceneContext,
} from "../../engine/sceneContext";
import { useTextKeyRegistry } from "../../engine/textKeyRegistry";
import { AnimatedGroup } from "../group/AnimatedGroup";
import { ImageCard } from "../media/ImageCard";
import type { V3 } from "../types";
import { AnimatedHeadline } from "./AnimatedHeadline";
import {
  brandLockupItemMotionTiming,
  brandLockupManagedMotion,
  lockupLayout,
} from "./brandLockupLayout";

/** Title label size, world units. */
const TITLE_SIZE = 0.36;
/** Hero subtitle size, world units. */
const SUBTITLE_SIZE = 0.82;

export interface BrandLockupProps {
  /** Small muted label above the hero line (usually the app name). */
  title: string;
  /** The hero line (usually the version number). */
  subtitle: string;
  /** Project-relative icon path; every project ships `assets/app-icon.png`. */
  icon?: string;
  /** Group reveal window (scene-local ms). */
  from?: number;
  to?: number;
  /** Offset added after the built-in centring (world units). */
  position?: V3;
  /** Icon width in world units; height follows the image's aspect. */
  iconWidth?: number;
  /** Title fill token or raw hex (default "muted"); beats the sidecar's `textStyle.titleColor`. */
  titleColor?: "text" | "muted" | "accent" | (string & {});
  /** Subtitle fill token or raw hex; beats the sidecar's `textStyle.subtitleColor`. */
  subtitleColor?: "text" | "muted" | "accent" | (string & {});
}

/** Horizontal brand lockup: app icon left, small muted title over a large hero subtitle to its right, revealed as ONE unit (fade-scale + a single shine sweep). Text lives in the sidecar under `title`/`subtitle`; centring and overflow shrink come from character-count estimates so layout never waits on font measurement. */
export function BrandLockup(props: BrandLockupProps) {
  const { from = 200, to = 1100, position = [0, 0, 0], iconWidth = 1.4 } = props;
  const format = useFormat();
  const doc = useContext(SceneDocContext);
  const templateManaged = isTemplateManagedText(doc);
  const claimed = useContext(SceneTextClaimedContext);
  const claimedMode = specialisedBrandLockupMode(doc, claimed);
  const title = resolveTemplateManagedTextCopy(doc, "title", props.title);
  const subtitle = resolveTemplateManagedTextCopy(doc, "subtitle", props.subtitle);
  const icon = resolveTemplateManagedTextIcon(doc, "icon", props.icon ?? "assets/app-icon.png");
  const sceneIndex = useSceneContext()?.index;
  const iconMountId = useId();
  const managedMotion = useMemo(() => brandLockupManagedMotion(from, to), [from, to]);
  useLayoutEffect(() => {
    if (sceneIndex === undefined || (doc?.managedText !== undefined && !templateManaged) || !icon) {
      return;
    }
    useTextKeyRegistry.getState().register(sceneIndex, "icon", iconMountId, {
      resolvedText: "",
      managedType: "icon",
      icon,
      styleCapable: true,
      style: { size: 1, offsetX: 0, offsetY: 0, rotationDeg: 0 },
      codedMotion: managedMotion,
    });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, "icon", iconMountId);
  }, [sceneIndex, doc?.managedText, templateManaged, icon, iconMountId, managedMotion]);
  if (doc?.managedText !== undefined && !templateManaged) return null;

  // A horizontal lockup is widest in 16:9; shrink it to fit square and portrait frames.
  const scale = format.aspect >= 1.4 ? 1 : format.aspect >= 0.9 ? 0.7 : 0.48;
  const usableWidth = (format.frame.width - format.safe.left - format.safe.right) / scale;
  const layout = lockupLayout({
    title,
    subtitle,
    iconWidth,
    titleSize: TITLE_SIZE,
    subtitleSize: SUBTITLE_SIZE,
    usableWidth,
  });
  const templateIconSize = iconWidth / ASSET_ICON_SCALE;
  const titleInspectorMotion = templateManagedTextOverridesCodedMotion(doc, "title");
  const subtitleInspectorMotion = templateManagedTextOverridesCodedMotion(doc, "subtitle");
  const iconInspectorMotion = templateManagedTextOverridesCodedMotion(doc, "icon");
  const forceInspectorMotion = templateManaged && doc?.textAnimationForce === true;
  const titleTiming = brandLockupItemMotionTiming(titleInspectorMotion, from, to);
  const subtitleTiming = brandLockupItemMotionTiming(subtitleInspectorMotion, from, to);
  const content = (
    <>
      {icon &&
        (templateManaged ? (
          <FrameIcon
            icon={icon}
            position={[layout.iconX, templateIconSize / 2, 0]}
            size={templateIconSize}
            anchorX="center"
            textKey="icon"
            templateMotion="item-or-force"
            {...(iconInspectorMotion ? { from, to } : {})}
          />
        ) : (
          <ImageCard src={icon} position={[layout.iconX, 0, 0]} width={iconWidth} />
        ))}
      {claimedMode === "all" && (
        <>
          <AnimatedHeadline
            text={title}
            textKey="title"
            {...titleTiming}
            position={[0, 0.46, 0]}
            fontSize={TITLE_SIZE}
            anchorX="left"
            textAlign="left"
            color={props.titleColor}
            defaultColor="muted"
            managedTextCodedMotion={managedMotion}
          />
          <AnimatedHeadline
            text={subtitle}
            textKey="subtitle"
            {...subtitleTiming}
            position={[0, -0.28, 0]}
            fontSize={SUBTITLE_SIZE}
            anchorX="left"
            textAlign="left"
            color={props.subtitleColor}
            managedTextCodedMotion={managedMotion}
          />
        </>
      )}
    </>
  );

  return (
    <group scale={scale * layout.fit} position={position}>
      {forceInspectorMotion ? (
        <group position={[layout.centreOffset, 0, 0]}>{content}</group>
      ) : (
        <AnimatedGroup
          from={from}
          to={to}
          preset="fade-scale"
          startScale={0.9}
          shine
          extent={[layout.width, 2]}
          position={[layout.centreOffset, 0, 0]}
          ignoreSceneMotion={templateManaged}
        >
          {content}
        </AnimatedGroup>
      )}
    </group>
  );
}
