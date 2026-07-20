/** The Present modal: playback mode, surface (window or fullscreen with a display picker), soundtrack and clip quality. Options are remembered per project in AppSettings, with a cross-project default via "Save as default". UI chrome only, never mounted during export/autorun. */

import { invoke } from "@tauri-apps/api/core";
import { availableMonitors } from "@tauri-apps/api/window";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { AspectName } from "../engine/format";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import { getSettings, type PresentOptions, setPresentOptions } from "../engine/workspace";
import {
  DISPLAY_ICON,
  FULL_QUALITY_ICON,
  FULLSCREEN_ICON,
  SLIDESHOW_ICON,
  SMOOTH_ICON,
  VIDEO_ICON,
  WINDOW_ICON,
} from "./presentIcons";
import { PresentIcon } from "./Titlebar";
import { useEscapeClose } from "./useEscapeClose";

const DEFAULT_OPTIONS: PresentOptions = {
  mode: "slideshow",
  quality: "full",
  soundtrack: false,
  fullscreen: false,
};

interface MonitorChoice {
  name: string;
  /** Logical coordinates (physical / scaleFactor), what LogicalPosition expects. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Physical size, for the picker's subtitle. */
  physicalWidth: number;
  physicalHeight: number;
}

export function PresentModal({
  project,
  currentAspect,
  onClose,
}: {
  project: LoadedProject;
  currentAspect: AspectName;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<PresentOptions>(DEFAULT_OPTIONS);
  const [monitors, setMonitors] = useState<MonitorChoice[]>([]);
  const [monitorIndex, setMonitorIndex] = useState(0);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(onClose);

  useEffect(() => {
    void getSettings().then((s) => {
      const stored = s.presentOptionsByProject?.[project.id] ?? s.presentOptionsDefault;
      if (!stored) return;
      // Coerce loose stored strings back onto the known unions.
      setOptions({
        mode: stored.mode === "video" ? "video" : "slideshow",
        quality: stored.quality === "smooth" ? "smooth" : "full",
        soundtrack: !!stored.soundtrack,
        fullscreen: !!stored.fullscreen,
      });
    });
    void availableMonitors()
      .then((ms) => {
        setMonitors(
          ms.map((m, i) => ({
            name: m.name ?? `Display ${i + 1}`,
            x: m.position.x / m.scaleFactor,
            y: m.position.y / m.scaleFactor,
            width: m.size.width / m.scaleFactor,
            height: m.size.height / m.scaleFactor,
            physicalWidth: m.size.width,
            physicalHeight: m.size.height,
          })),
        );
      })
      .catch(() => setMonitors([]));
  }, [project.id]);

  const set = <K extends keyof PresentOptions>(key: K, value: PresentOptions[K]) =>
    setOptions((o) => ({ ...o, [key]: value }));

  const present = () => {
    const picked = monitors[monitorIndex];
    const monitor =
      options.fullscreen && picked
        ? { x: picked.x, y: picked.y, width: picked.width, height: picked.height }
        : undefined;
    void setPresentOptions(project.id, options, saveAsDefault).catch(() => {});
    const open = async () => {
      // The present window re-checks the F-001 gate against the STORED fingerprint; re-stamp from this already-consented session so in-session edits (e.g. a device tweak) never wedge it.
      if (isWorkspaceProjectId(project.id)) {
        await invoke("trust_project", { slug: workspaceSlug(project.id) }).catch(() => {});
      }
      await invoke("open_present", {
        target: {
          projectId: project.id,
          mode: options.mode,
          quality: options.quality,
          aspect: currentAspect,
          soundtrack: options.soundtrack,
          fullscreen: options.fullscreen,
          ...(monitor ? { monitor } : {}),
        },
      });
    };
    open()
      .then(onClose)
      .catch((e) => setError(String(e)));
  };

  const chip = (
    selected: boolean,
    icon: ReactElement,
    label: string,
    onClick: () => void,
    title?: string,
  ) => (
    <button
      type="button"
      key={label}
      className={`chip${selected ? " selected" : ""}`}
      title={title}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Present"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal present-modal">
        <div className="modal-title-row">
          <h2 className="modal-title">Present</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} />
        </div>

        <div className="popover-row present-group">
          <span className="popover-group-label">Play as</span>
        </div>
        <div className="popover-row">
          {chip(
            options.mode === "slideshow",
            SLIDESHOW_ICON,
            "Slideshow",
            () => set("mode", "slideshow"),
            "Each scene holds until you click, press space or arrow through",
          )}
          {chip(
            options.mode === "video",
            VIDEO_ICON,
            "Video",
            () => set("mode", "video"),
            "Plays straight through with transitions and soundtrack",
          )}
        </div>

        <div className="popover-row present-group">
          <span className="popover-group-label">Surface</span>
        </div>
        <div className="popover-row">
          {chip(
            !options.fullscreen,
            WINDOW_ICON,
            "Window",
            () => set("fullscreen", false),
            "A chromeless window, ideal for sharing in Zoom or Teams",
          )}
          {chip(
            options.fullscreen,
            FULLSCREEN_ICON,
            "Fullscreen",
            () => set("fullscreen", true),
            "Takes over a display, ideal for a connected screen",
          )}
        </div>
        {options.fullscreen && monitors.length > 1 && (
          <div className="popover-row">
            {monitors.map((m, i) =>
              chip(
                monitorIndex === i,
                DISPLAY_ICON,
                `${m.name} (${m.physicalWidth}×${m.physicalHeight})`,
                () => setMonitorIndex(i),
              ),
            )}
          </div>
        )}

        {options.mode === "slideshow" && project.audio && (
          <div className="popover-row">
            <label
              className="popover-inline"
              title="Loops the soundtrack as background music while you present"
            >
              <input
                type="checkbox"
                checked={options.soundtrack}
                onChange={(e) => set("soundtrack", e.target.checked)}
              />
              Play soundtrack
            </label>
          </div>
        )}

        <div className="popover-row present-group">
          <span className="popover-group-label">Video clips</span>
        </div>
        <div className="popover-row">
          {chip(
            options.quality === "full",
            FULL_QUALITY_ICON,
            "Full quality",
            () => set("quality", "full"),
            "Exact full-resolution frames; crispest on a big screen",
          )}
          {chip(
            options.quality === "smooth",
            SMOOTH_ICON,
            "Smooth playback",
            () => set("quality", "smooth"),
            "Preview-tier frames while moving; smoother on clip-heavy projects",
          )}
        </div>

        {error && <p className="modal-error">{error}</p>}

        <div className="export-footer">
          <label className="popover-inline" title="Use these options for every project from now on">
            <input
              type="checkbox"
              checked={saveAsDefault}
              onChange={(e) => setSaveAsDefault(e.target.checked)}
            />
            Save as default
          </label>
          <button type="button" className="btn primary" onClick={present}>
            <PresentIcon />
            Present
          </button>
        </div>
      </div>
    </div>
  );
}
