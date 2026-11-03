import { flushSync } from "react-dom";
import { commitFocusedInspectorEdit } from "./textEditFocus";

export async function settleContentEdits(): Promise<void> {
  flushSync(commitFocusedInspectorEdit);
  await settlePendingContentEdits();
}

export async function settlePendingContentEdits(): Promise<void> {
  const { settleTerminalBakes } = await import("../engine/sceneTerminalBaker");
  const { settleSceneDocPatches } = await import("../engine/sceneDocPatchQueue");
  const { settleSceneDocWrites } = await import("../engine/sceneDoc");
  await settleTerminalBakes();
  await settleSceneDocPatches();
  await settleSceneDocWrites();
}
