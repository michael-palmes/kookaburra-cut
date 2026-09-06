import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { updateBuiltinTheme } from "../../theme/registry";
import { settleContentEdits } from "../settleContentEdits";

export interface ThemeMoveResult {
  oldId: string;
  themeId: string;
  json: string;
  updatedFiles: number;
  recoveryPath: string;
}

export async function moveTheme(
  slug: string,
  id: string,
  name: string,
  category: string,
): Promise<ThemeMoveResult> {
  await settleContentEdits();
  const result = await invoke<ThemeMoveResult>("dev_move_theme", { slug, id, name, category });
  updateBuiltinTheme(result.themeId, JSON.parse(result.json));
  return result;
}

export function onThemeMoved(handler: (result: ThemeMoveResult) => void): () => void {
  let disposed = false;
  const listener = listen<ThemeMoveResult & { error?: string }>(
    "kookaburra://theme-move-finished",
    ({ payload }) => {
      if (disposed || payload.error) return;
      updateBuiltinTheme(payload.themeId, JSON.parse(payload.json));
      handler(payload);
    },
  );
  return () => {
    disposed = true;
    void listener.then((unlisten) => unlisten()).catch(() => {});
  };
}
