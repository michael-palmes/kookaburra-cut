import type { PackReview } from "../packReview";
import { formatBytes, formatDate, formatKeyId, type PackInspection } from "../types";

/** Screen 1. The honesty rule: a publisher name is rendered as self-declared, always. No tick, no badge, no green for a name. The publisher verdict comes first and the integrity tick below it, so "Contents verified" never heads a pack from a stranger or a changed key. Scene code counts, pre-typed terminal commands and website origins come from the signed files the reader checked, never the manifest's description of itself, and are all here before Continue. Continue is primary only for a publisher this Mac knows under this key; otherwise Cancel is. */
export function TrustView({
  inspection,
  review,
  onViewCode,
  onCancel,
  onContinue,
}: {
  inspection: PackInspection;
  review: PackReview;
  onViewCode: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const { manifest, archiveBytes, installBytes, sceneSources } = inspection;
  const projects = manifest.contents.projects;
  const itemCount =
    projects.length +
    manifest.contents.themes.length +
    manifest.contents.brands.length +
    manifest.contents.fonts.length +
    manifest.contents.objects.length +
    manifest.contents.gradients.length +
    manifest.contents.exportPresets.length +
    manifest.contents.screenshots.length;
  const sceneFileCount = sceneSources.length;
  const codeItems = new Set(sceneSources.map((s) => `${s.kind}:${s.slug}`)).size;
  const knownPublisher = inspection.publisher.kind === "known";

  return (
    <div className="packs-main">
      <div className="packs-scroll">
        <h1 className="packs-pack-title">{manifest.pack.name}</h1>
        {manifest.pack.description && (
          <p className="packs-pack-desc">{manifest.pack.description}</p>
        )}

        <PublisherBlock inspection={inspection} />

        <div className="packs-verdict packs-verdict-ok">
          <span className="packs-verdict-icon" aria-hidden="true">
            ✓
          </span>
          <div className="packs-verdict-body">
            <strong>Manifest signature valid</strong>
            The signed list inside this pack has not been changed. Every file is checked against it
            as it is unpacked. That proves the pack is whole, not who made it.
          </div>
        </div>

        {sceneFileCount > 0 && (
          <div className="packs-verdict packs-verdict-warn">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>This pack contains scene code</strong>
              {codeItems} item{codeItems === 1 ? "" : "s"} carry {sceneFileCount} scene file
              {sceneFileCount === 1 ? "" : "s"} that run on your Mac when you open them. Importing
              only copies files. You will be asked again before any code runs, and a project this
              pack replaces asks again on its next open.
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn" onClick={onViewCode}>
                  View the code
                </button>
              </div>
            </div>
          </div>
        )}

        {review.terminals.length > 0 && (
          <div className="packs-verdict packs-verdict-warn">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>Terminal scenes come with pre-typed commands</strong>
              Nothing runs on its own: a pre-typed command only runs when you press Enter on it.
              Review these before presenting, since they were written by the pack's author.
              {review.terminals.map((row) => (
                <div className="packs-terminal-review-row" key={`${row.project}:${row.file}`}>
                  <span className="packs-verdict-note">
                    {row.project} · {row.scene}
                    {row.startPath ? ` · opens at ${row.startPath}` : ""}
                  </span>
                  {row.command && <code className="packs-terminal-command">{row.command}</code>}
                </div>
              ))}
            </div>
          </div>
        )}

        {review.websites.length > 0 && (
          <div className="packs-verdict packs-verdict-warn">
            <span className="packs-verdict-icon" aria-hidden="true">
              !
            </span>
            <div className="packs-verdict-body">
              <strong>Website scenes request network access</strong>
              Nothing loads and no approval travels with the pack. Each origin asks for local
              approval before its first request.
              {review.websites.map((row) => (
                <div className="packs-terminal-review-row" key={`${row.project}:${row.file}`}>
                  <span className="packs-verdict-note">
                    {row.project} · {row.scene}
                  </span>
                  {row.origins.map((origin) => (
                    <code className="packs-terminal-command" key={origin.origin}>
                      {origin.origin}
                      {origin.loopback ? " · local address, session approval only" : ""}
                    </code>
                  ))}
                </div>
              ))}
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
          <button
            type="button"
            className={knownPublisher ? "btn" : "btn primary"}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={knownPublisher ? "btn primary" : "btn"}
            onClick={onContinue}
          >
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

  if (publisher.kind === "keyChanged") {
    return (
      <div className="packs-verdict packs-verdict-warn">
        <span className="packs-verdict-icon" aria-hidden="true">
          !
        </span>
        <div className="packs-verdict-body">
          <strong>A publisher you know as {publisher.knownAs} is using a different key</strong>
          {identity}
          <div className="packs-verdict-note">
            Packs from {publisher.knownAs} (last “{publisher.lastPack}”) were signed with key{" "}
            {formatKeyId(publisher.previousKeyId)}. A new Mac or a rotated key looks like this, and
            so does someone borrowing the name. Check with them before you continue.
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
