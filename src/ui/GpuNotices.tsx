import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useEffect, useState } from "react";
import { canvasContextLosses, onCanvasContextLost } from "../engine/exportBridge";
import { runningSceneTerminalCount } from "../engine/sceneTerminalSession";
import { stageOrNull } from "../engine/stageHandle";
import { liveSessionCount } from "../engine/terminal";
import { settleContentEdits } from "./settleContentEdits";

/** Mirror of `capture_service::status` in src-tauri/src/capture_service.rs. */
interface CaptureServiceStatus {
  stalledUntilMs: number | null;
  wedged: boolean;
  stallsLast10Min: number;
  recycles: number;
}

function LineIcon({
  size = 14,
  className,
  children,
}: {
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const GpuIcon = () => (
  <LineIcon size={16} className="load-notice-icon">
    <rect x="2.5" y="4" width="11" height="8" rx="1.5" />
    <path d="M5.5 4V2.5M10.5 4V2.5M5.5 13.5V12M10.5 13.5V12M6 8h4" />
  </LineIcon>
);

const ReloadIcon = () => (
  <LineIcon>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5v2.8h-2.8" />
  </LineIcon>
);

const RetryCapturesIcon = () => (
  <LineIcon>
    <path d="M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11z" />
    <circle cx="8" cy="9" r="2" />
  </LineIcon>
);

/** Reloading the main webview is the only way to a fresh realm: the module caches (PMREM, mirror bakes) outlive a canvas remount. Pending edits land first; live terminals keep running but detach. */
async function reloadPreview(): Promise<void> {
  const terminals = liveSessionCount() + runningSceneTerminalCount();
  if (terminals > 0) {
    const go = await ask(
      `${terminals} terminal session${terminals === 1 ? "" : "s"} keep running but detach from the panel.`,
      { title: "Reload the preview?", kind: "warning", okLabel: "Reload preview" },
    );
    if (!go) return;
  }
  await settleContentEdits();
  window.location.reload();
}

/** The editor's GPU notices: the stage canvas lost its context (Reload preview), and Claude's captures paused after repeated stalls (Retry captures). In dev builds it also answers `kb debug lose-context --window editor`. */
export function GpuNotices() {
  const [stageLost, setStageLost] = useState(() => canvasContextLosses() > 0);
  const [service, setService] = useState<CaptureServiceStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => onCanvasContextLost(() => setStageLost(true)), []);

  useEffect(() => {
    void invoke<CaptureServiceStatus>("capture_service_status")
      .then(setService)
      .catch(() => {});
    const unlisten = listen<CaptureServiceStatus>("kookaburra://capture-service", (event) =>
      setService(event.payload),
    );
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const unlisten = listen("kookaburra://debug-lose-context", () => {
      void stageOrNull()?.forceContextLoss();
    });
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const retryCaptures = async () => {
    setRetrying(true);
    try {
      setService(await invoke<CaptureServiceStatus>("capture_service_reset"));
    } catch (e) {
      console.warn("[bridge] retry captures failed:", e);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      {stageLost && (
        <div className="load-notice load-notice-danger" role="alert">
          <GpuIcon />
          <div className="load-notice-body">
            <p className="load-notice-title">
              The GPU reset. The preview may be missing reflections, and exports stay paused until
              the preview reloads.
            </p>
            <div className="load-notice-actions">
              <button type="button" className="btn primary" onClick={() => void reloadPreview()}>
                <ReloadIcon />
                Reload preview
              </button>
            </div>
          </div>
        </div>
      )}
      {service?.wedged && (
        <div className="load-notice" role="status">
          <GpuIcon />
          <div className="load-notice-body">
            <p className="load-notice-title">Claude’s captures are paused</p>
            <p className="load-notice-hint">
              The GPU stalled 3 times in 10 minutes, so Kookaburra Cut stopped restarting its hidden
              render window. Quit and reopen Kookaburra Cut, or retry captures.
            </p>
            <div className="load-notice-actions">
              <button
                type="button"
                className="btn"
                disabled={retrying}
                aria-busy={retrying}
                onClick={() => void retryCaptures()}
              >
                <RetryCapturesIcon />
                Retry captures
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
