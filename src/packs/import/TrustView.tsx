import { formatBytes, formatDate, formatKeyId, type PackInspection } from "../types";

/** Screen 1. The honesty rule: a publisher name is rendered as self-declared, always. No tick, no badge, no green for a name. */
export function TrustView({
  inspection,
  onViewCode,
  onCancel,
  onContinue,
}: {
  inspection: PackInspection;
  onViewCode: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const { manifest, archiveBytes, installBytes } = inspection;
  const projects = manifest.contents.projects;
  const itemCount =
    projects.length +
    manifest.contents.themes.length +
    manifest.contents.fonts.length +
    manifest.contents.objects.length +
    manifest.contents.gradients.length +
    manifest.contents.exportPresets.length +
    manifest.contents.screenshots.length;
  const sceneFileCount = projects.reduce((n, p) => n + p.sceneCount, 0);

  return (
    <div className="packs-main">
      <div className="packs-scroll">
        <h1 className="packs-pack-title">{manifest.pack.name}</h1>
        {manifest.pack.description && (
          <p className="packs-pack-desc">{manifest.pack.description}</p>
        )}

        <div className="packs-verdict packs-verdict-ok">
          <span className="packs-verdict-icon" aria-hidden="true">
            ✓
          </span>
          <div className="packs-verdict-body">
            <strong>Contents verified</strong>
            Every file matches the signed list inside this pack.
          </div>
        </div>

        <PublisherBlock inspection={inspection} />

        {projects.length > 0 && (
          <div className="packs-verdict packs-verdict-warn">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>This pack contains scene code</strong>
              {projects.length} project{projects.length === 1 ? "" : "s"} include {sceneFileCount}{" "}
              scene file{sceneFileCount === 1 ? "" : "s"} that run on your Mac when you open them.
              Importing only copies files. You will be asked again before any code runs.
              <div style={{ marginTop: 8 }}>
                <button type="button" onClick={onViewCode}>
                  View the code
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="packs-footer">
        <div className="packs-footer-summary">
          {itemCount} item{itemCount === 1 ? "" : "s"} · {formatBytes(archiveBytes)} in the pack ·{" "}
          {formatBytes(installBytes)} installed
        </div>
        <div className="packs-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function PublisherBlock({ inspection }: { inspection: PackInspection }) {
  const { manifest, publisher } = inspection;
  const p = manifest.publisher;
  const who = [p.organisation, p.name].filter(Boolean).join(" · ");
  const identity = (
    <>
      {who}
      <div className="packs-verdict-note">
        {p.device} · {formatDate(manifest.pack.createdAt)}
        <br />
        Key {formatKeyId(p.keyId)}
      </div>
    </>
  );

  if (publisher.kind === "known") {
    return (
      <div className="packs-verdict packs-verdict-ok">
        <span className="packs-verdict-icon" aria-hidden="true">
          ✓
        </span>
        <div className="packs-verdict-body">
          <strong>Same publisher as “{publisher.lastPack}”</strong>
          {identity}
          <div className="packs-verdict-note">
            First seen {formatDate(publisher.firstSeen)}. {publisher.packCount} pack
            {publisher.packCount === 1 ? "" : "s"} so far.
          </div>
        </div>
      </div>
    );
  }

  if (publisher.kind === "nameChanged") {
    return (
      <div className="packs-verdict packs-verdict-warn">
        <span className="packs-verdict-icon" aria-hidden="true">
          !
        </span>
        <div className="packs-verdict-body">
          <strong>This publisher has changed its name</strong>
          {identity}
          <div className="packs-verdict-note">
            This signing key previously identified itself as <strong>{publisher.previous}</strong>.
            That can mean a rename, or it can mean someone is using a name they should not.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="packs-verdict packs-verdict-warn">
      <span className="packs-verdict-icon" aria-hidden="true">
        !
      </span>
      <div className="packs-verdict-body">
        <strong>First time from this publisher</strong>
        {identity}
        <div className="packs-verdict-note">
          These details were entered by whoever made the pack. Nothing has checked that they are
          true.
        </div>
      </div>
    </div>
  );
}
