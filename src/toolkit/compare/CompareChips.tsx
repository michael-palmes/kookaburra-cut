import { Text } from "@react-three/drei";
import { useContext, useId, useLayoutEffect, useMemo } from "react";
import {
  compareChipDefaultColour,
  compareChipFallbackText,
  compareChipTextKeyForSide,
  compareChipTextStyle,
} from "../../engine/compareChipText";
import { useFormat } from "../../engine/format";
import { compareCoverageAt, compareSampleAt, compareSpecOf } from "../../engine/sceneCompare";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneText } from "../../engine/sceneDoc";
import { useTextKeyRegistry } from "../../engine/textKeyRegistry";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { fontUrl } from "../../theme/fonts";

/** The comparison's label chips, mounted host-side inside EACH side's subtree so the mask clips a chip with its own half: side A renders the before label, side B the after. Positions are fixed at the top quarters; opacity fades by the side's coverage at the chip's spot (the compositor's exact field maths via compareCoverageAt), so a sweeping divider dissolves a label as its half shrinks instead of stranding it. Copy and typography are inspector-owned text content (`text.beforeLabel` / `text.afterLabel` plus the usual `textStyle` suffixes, resolved by the managed-text renderer's rules); an unstyled chip draws exactly its coded defaults. Deterministic: the divider value derives from the timeline through the same sampler the compositor uses; colours and the face come from the side's own theme. Renders null on every scene without `compare.chrome.chips`. */
export function CompareChips() {
  const doc = useContext(SceneDocContext);
  const ctx = useSceneContext();
  const theme = useTheme();
  const format = useFormat();
  const { localMs } = useTimeline();
  const spec = useMemo(() => compareSpecOf(doc ?? undefined, theme), [doc, theme]);
  const side = ctx?.side === "b" ? "b" : "a";
  const textKey = compareChipTextKeyForSide(side);
  const label = useSceneText(textKey, compareChipFallbackText(textKey), "managed");
  // The colour swatch's default and the "this key takes style overrides" mark, for the text drill.
  const sceneIndex = ctx?.index;
  const mountId = useId();
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useTextKeyRegistry.getState().register(sceneIndex, textKey, mountId, {
      colorDefault: compareChipDefaultColour(textKey),
      styleCapable: true,
      managedTextRole: "managed",
    });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, textKey, mountId);
  }, [sceneIndex, textKey, mountId]);
  if (!spec?.chrome.chips || !label) return null;
  const portrait = format.aspect < 1;
  const x = (side === "a" ? -1 : 1) * format.frame.width * 0.25;
  const y = format.frame.height / 2 - format.safe.top - (portrait ? 0.24 : 0.3);
  const uv: [number, number] = [0.5 + x / format.frame.width, 0.5 + y / format.frame.height];
  const sample = compareSampleAt(spec, localMs);
  const opacity = compareCoverageAt(spec, sample.value, sample.angleDeg, uv, format.aspect, side);
  if (opacity <= 0.01) return null;
  const style = compareChipTextStyle({
    doc,
    key: textKey,
    theme,
    baseFontSize: portrait ? 0.13 : 0.18,
    x,
    y,
  });
  return (
    <Text
      font={fontUrl(style.fontRef)}
      fontSize={style.fontSize}
      color={style.colour}
      fillOpacity={opacity}
      position={style.position}
      anchorX="center"
      anchorY="middle"
      {...(style.lineHeight !== undefined ? { lineHeight: style.lineHeight } : {})}
      {...(style.rotationRad !== undefined
        ? { rotation: [0, 0, style.rotationRad] as [number, number, number] }
        : {})}
    >
      {label}
    </Text>
  );
}
