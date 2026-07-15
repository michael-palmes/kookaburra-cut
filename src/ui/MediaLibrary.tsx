import { useState } from "react";
import { MediaBrowser } from "./MediaBrowser";
import { mediaCardMenu } from "./mediaCardMenu";
import { useEscapeClose } from "./useEscapeClose";

/** The media library modal: the shared MediaBrowser in a modal shell. Card actions live in the shared ⋯/right-click menu (2026-07-12: the old four-button row overflowed the card): Edit / Open in editor (videos), Insert (hands the relative path to the Claude session) and the two-step Delete. */
export function MediaLibrary({
  slug,
  projectPath,
  refreshKey,
  onInsert,
  onClose,
}: {
  slug: string;
  /** Absolute project folder, full-res previews load from it via the asset protocol. */
  projectPath: string;
  /** Bump to re-scan (e.g. after a drag-drop import while the modal is open). */
  refreshKey: number;
  /** Receives the project-relative path (the parent pastes it or copies it). */
  onInsert: (rel: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  // Shared Escape stack: the browser's fullscreen preview registers above this modal, so Escape closes the preview first, the modal second.
  useEscapeClose(onClose);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Media library">
      <div className="modal media-modal">
        <div className="media-header">
          <h2>Media</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {error && <p className="modal-error">{error}</p>}
        <MediaBrowser
          slug={slug}
          projectPath={projectPath}
          refreshKey={refreshKey + localRefresh}
          cardMenu={mediaCardMenu({
            slug,
            primaryLabel: "Insert",
            onPrimary: (rel) => onInsert(rel),
            onChanged: () => setLocalRefresh((n) => n + 1),
            onError: setError,
          })}
        />
      </div>
    </div>
  );
}
