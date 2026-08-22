import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { revealApp } from "../engine/reveal";
import { useNativeTextUndo } from "../ui/useNativeTextUndo";
import { ExportView } from "./ExportView";
import { ImportFlow } from "./import/ImportFlow";
import "./packs.css";

// `mode` is serde's lowercase variant tag from `packs_win::PacksTarget`, pinned by a Rust test.
type PacksTarget = { mode: "export" } | { mode: "import"; path?: string | null; queued: number };

/** The packs window shell. Export and import are separate flows sharing one window, chosen by the target the native side stashed before opening us. */
export function PacksApp() {
  useNativeTextUndo();
  const [target, setTarget] = useState<PacksTarget | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    revealApp();
    invoke<PacksTarget | null>("get_packs_target")
      .then((t) => setTarget(t ?? { mode: "export" }))
      .catch(() => setTarget({ mode: "export" }));
  }, []);

  useEffect(() => {
    const un = listen<PacksTarget>("kookaburra://packs-target", (e) => {
      setDropError(null);
      setTarget(e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Native drag-drop stays enabled on this window so a dropped pack arrives as a real path.
  useEffect(() => {
    const un = listen<{ paths?: string[] }>("tauri://drag-drop", (e) => {
      const paths = e.payload?.paths ?? [];
      const packs = paths.filter((p) => p.toLowerCase().endsWith(".kbpack"));
      if (packs.length === 0) {
        setDropError(
          paths.length === 1
            ? "That is not a Kookaburra Pack."
            : "None of those are Kookaburra Packs.",
        );
        return;
      }
      setDropError(null);
      void invoke("open_pack_import", { path: packs[0] });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const close = useCallback(() => {
    void getCurrentWindow().close();
  }, []);

  if (!target) return <div className="packs-shell" />;

  return (
    <div className="packs-shell">
      <div className="packs-titlebar" data-tauri-drag-region />
      {dropError && (
        <div className="packs-drop-error" role="status">
          {dropError}
        </div>
      )}
      {target.mode === "export" ? (
        <ExportView onClose={close} />
      ) : (
        <ImportFlow initialPath={target.path ?? null} queued={target.queued} onClose={close} />
      )}
    </div>
  );
}
