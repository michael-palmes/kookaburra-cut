import type { ReactNode } from "react";
import type { SceneImageHost } from "../../engine/sceneDocSchema";

export function ImageHostPicker({
  stageIcon,
  overlayIcon,
  overlayAvailable,
  onPick,
}: {
  stageIcon: ReactNode;
  overlayIcon: ReactNode;
  overlayAvailable: boolean;
  onPick: (host: SceneImageHost) => void;
}) {
  return (
    <>
      <div className="image-host-options">
        <button type="button" className="btn image-host-option" onClick={() => onPick("stage")}>
          {stageIcon}
          <span>
            <strong>Stage</strong>
            <small>A 3D card among devices and objects</small>
          </span>
        </button>
        <button
          type="button"
          className={`btn image-host-option${overlayAvailable ? "" : " disabled"}`}
          aria-disabled={!overlayAvailable}
          aria-describedby={overlayAvailable ? undefined : "image-host-overlay-reason"}
          onClick={() => {
            if (overlayAvailable) onPick("overlay");
          }}
        >
          {overlayIcon}
          <span>
            <strong>Overlay</strong>
            <small>Frame-relative editorial artwork</small>
          </span>
        </button>
      </div>
      {!overlayAvailable && (
        <p id="image-host-overlay-reason" className="image-host-reason">
          Add an Overlay to this scene before placing an image there.
        </p>
      )}
    </>
  );
}
