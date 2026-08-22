import { Text } from "@react-three/drei";
import { useContext, useMemo } from "react";
import { useFormat } from "../../engine/format";
import { compareCoverageAt, compareSampleAt, compareSpecOf } from "../../engine/sceneCompare";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneText } from "../../engine/sceneDoc";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { fontUrl } from "../../theme/fonts";

/** The comparison's label chips, mounted host-side inside EACH side's subtree so the mask clips a chip with its own half: side A renders the before label, side B the after. Positions are fixed at the top quarters; opacity fades by the side's coverage at the chip's spot (the compositor's exact field maths via compareCoverageAt), so a sweeping divider dissolves a label as its half shrinks instead of stranding it. Deterministic: the divider value derives from the timeline through the same sampler the compositor uses; colours and the face come from the side's own theme. Renders null on every scene without `compare.chrome.chips`. */
export function CompareChips() {
  const doc = useContext(SceneDocContext);
  const ctx = useSceneContext();
  const theme = useTheme();
  const format = useFormat();
  const { localMs } = useTimeline();
  const spec = useMemo(() => compareSpecOf(doc ?? undefined, theme), [doc, theme]);
  const side = ctx?.side === "b" ? "b" : "a";
  const label = useSceneText(
    side === "a" ? "beforeLabel" : "afterLabel",
    side === "a" ? "Before" : "After",
    "embedded",
  );
  if (!spec?.chrome.chips || !label) return null;
  const portrait = format.aspect < 1;
  const x = (side === "a" ? -1 : 1) * format.frame.width * 0.25;
  const y = format.frame.height / 2 - format.safe.top - (portrait ? 0.24 : 0.3);
  const uv: [number, number] = [0.5 + x / format.frame.width, 0.5 + y / format.frame.height];
  const sample = compareSampleAt(spec, localMs);
  const opacity = compareCoverageAt(spec, sample.value, sample.angleDeg, uv, format.aspect, side);
  if (opacity <= 0.01) return null;
  return (
    <Text
      font={fontUrl(theme.typography.body)}
      fontSize={portrait ? 0.13 : 0.18}
      color={side === "a" ? theme.colors.muted : theme.colors.accent}
      fillOpacity={opacity}
      position={[x, y, 0]}
      anchorX="center"
      anchorY="middle"
    >
      {label}
    </Text>
  );
}
