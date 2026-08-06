/** Host-side chart for scenes whose TSX never wires `useSceneChart` (mounted by SceneHost, the ObjectsFallback pattern): resolves the doc directly and renders `MountedChart`, never `<Chart />`, so it can't register as its own consumer and cycle its render gate. */

import { useContext, useMemo } from "react";
import { useSceneConsumesChart } from "../../engine/chartRegistry";
import { resolveChart } from "../../engine/sceneChart";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { MountedChart } from "./Chart";

export function ChartFallback() {
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesChart(sceneIndex);
  const chart = useMemo(() => resolveChart(doc ?? undefined), [doc]);
  if (consumed || !chart) return null;
  return <MountedChart chart={chart} />;
}
