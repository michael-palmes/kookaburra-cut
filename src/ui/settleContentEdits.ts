import { flushSync } from "react-dom";
import { commitFocusedInspectorEdit } from "./textEditFocus";

export async function settleContentEdits(): Promise<void> {
  flushSync(commitFocusedInspectorEdit);
  await settlePendingContentEdits();
}

export async function settlePendingContentEdits(): Promise<void> {
  const { settleSceneDocPatches } = await import("./useSceneDocPatch");
  const { settleSceneDocWrites } = await import("../engine/sceneDoc");
  await settleSceneDocPatches();
  await settleSceneDocWrites();
}
