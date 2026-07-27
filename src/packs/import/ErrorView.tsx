/** One screen for every refusal. Tampering and traversal get a plain-language framing, because "invalid pack" tells a user nothing. */
export function ErrorView({
  message,
  path,
  onClose,
  onChooseAnother,
}: {
  message: string;
  path?: string;
  onClose: () => void;
  onChooseAnother?: () => void;
}) {
  const details = [message, path ? `File: ${path}` : null].filter(Boolean).join("\n");
  return (
    <div className="packs-main">
      <div className="packs-scroll">
        <h1 className="packs-pack-title">This pack was not imported</h1>
        <div className="packs-verdict packs-verdict-bad">
          <span className="packs-verdict-icon" aria-hidden="true">
            !
          </span>
          <div className="packs-verdict-body">
            {message}
            <div className="packs-verdict-note">Nothing on your Mac has changed.</div>
          </div>
        </div>
      </div>
      <div className="packs-footer">
        <div className="packs-footer-summary" />
        <div className="packs-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void navigator.clipboard.writeText(details)}
          >
            Copy details
          </button>
          {onChooseAnother && (
            <button type="button" className="btn" onClick={onChooseAnother}>
              Choose another pack
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
