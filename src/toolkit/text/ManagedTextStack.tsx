import { FrameIcon } from "../../engine/FrameIcon";
import { useFormat } from "../../engine/format";
import {
  isTemplateManagedText,
  type ManagedTextRegion,
  resolveManagedTextRenderPlan,
} from "../../engine/managedText";
import { useSceneDoc } from "../../engine/sceneDoc";
import { useTheme } from "../../theme";
import { AnimatedHeadline } from "./AnimatedHeadline";

export interface ManagedTextStackProps {
  region?: ManagedTextRegion;
}

/** Inspector-owned deterministic safe-area text stack. It renders only for a present managed block. */
export function ManagedTextStack({ region }: ManagedTextStackProps) {
  const doc = useSceneDoc();
  const format = useFormat();
  const theme = useTheme();
  if (isTemplateManagedText(doc)) return null;
  const plan = resolveManagedTextRenderPlan(
    doc,
    format,
    theme.typography.scale,
    region,
    theme.textAnimation,
  );
  if (!plan.ownsSceneText || plan.nodes.length === 0) return null;
  return (
    <>
      {plan.nodes.map((node) => {
        if (node.kind === "icon" && node.icon) {
          return (
            <FrameIcon
              key={node.key}
              icon={node.icon}
              position={node.position}
              size={node.fontSize}
              from={node.from}
              to={node.to}
              anchorX={node.anchorX}
              textKey={node.itemKey}
              managedTextRole="managed"
            />
          );
        }
        if (!node.text) return null;
        return (
          <AnimatedHeadline
            key={node.key}
            text={node.text}
            textKey={node.itemKey}
            from={node.from}
            to={node.to}
            position={node.position}
            fontSize={node.fontSize}
            face={node.face}
            defaultColor={node.kind === "subtitle" ? "muted" : undefined}
            anchorX={node.anchorX}
            anchorY="top"
            textAlign={node.anchorX}
            maxWidth={node.maxWidth}
            managedTextRole="managed"
          />
        );
      })}
    </>
  );
}
