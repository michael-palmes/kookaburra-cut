import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

export function useNativeTextUndo(): void {
  useEffect(() => {
    const undo = listen("kookaburra://undo", () => document.execCommand("undo"));
    const redo = listen("kookaburra://redo", () => document.execCommand("redo"));
    return () => {
      void undo.then((unlisten) => unlisten());
      void redo.then((unlisten) => unlisten());
    };
  }, []);
}
