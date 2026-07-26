import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/** Settings panes for packs: who this install says it is on the packs it signs, and the publishers it has already imported from. The private key is never shown and there is no reveal; see src-tauri/src/pack/publisher.rs. */

interface PublisherProfile {
  name: string;
  organisation?: string | null;
  website?: string | null;
}

interface PublisherKey {
  keyId: string;
  /** The same id in groups of four, for reading out loud. */
  keyIdDisplay: string;
  publicKey: string;
}

interface PublisherProfileView {
  /** Absent until this pane has been saved once. */
  profile: PublisherProfile | null;
  /** What a pack signed right now would carry (the macOS full name when nothing is set). */
  effectiveName: string;
  organisation: string | null;
  website: string | null;
  device: string;
  /** Absent until the first pack is signed: the key is created lazily. */
  key: PublisherKey | null;
}

interface KnownPublisherRow {
  keyId: string;
  keyIdDisplay: string;
  publicKey: string;
  name: string;
  organisation?: string | null;
  firstSeen: string;
  lastSeen: string;
  packCount: number;
  lastPackName: string;
}

function getPublisherProfile(): Promise<PublisherProfileView> {
  return invoke<PublisherProfileView>("get_publisher_profile");
}

function setPublisherProfile(profile: PublisherProfile): Promise<PublisherProfileView> {
  return invoke<PublisherProfileView>("set_publisher_profile", { profile });
}

function rotatePublisherKey(): Promise<PublisherKey> {
  return invoke<PublisherKey>("rotate_publisher_key");
}

function listKnownPublishers(): Promise<KnownPublisherRow[]> {
  return invoke<KnownPublisherRow[]>("list_known_publishers");
}

function forgetPublisher(keyId: string): Promise<void> {
  return invoke<void>("forget_publisher", { keyId });
}

function shortDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString();
}

function setStringError(set: (message: string) => void) {
  return (e: unknown) => set(String(e));
}

export function PublisherPane() {
  const [view, setView] = useState<PublisherProfileView | null>(null);
  const [known, setKnown] = useState<KnownPublisherRow[]>([]);
  const [name, setName] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const apply = useCallback((next: PublisherProfileView) => {
    setView(next);
    setName(next.profile?.name ?? "");
    setOrganisation(next.profile?.organisation ?? "");
    setWebsite(next.profile?.website ?? "");
  }, []);

  useEffect(() => {
    getPublisherProfile().then(apply).catch(setStringError(setError));
    listKnownPublishers()
      .then(setKnown)
      .catch(() => setKnown([]));
  }, [apply]);

  // Auto-disarm after 3s, the house two-step pattern.
  useEffect(() => {
    if (!confirmRotate) return;
    const timer = window.setTimeout(() => setConfirmRotate(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRotate]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const save = useCallback(() => {
    if (!view) return;
    const next: PublisherProfile = { name, organisation, website };
    const current = view.profile;
    if (
      current &&
      current.name === name.trim() &&
      (current.organisation ?? "") === organisation.trim() &&
      (current.website ?? "") === website.trim()
    ) {
      return;
    }
    if (!current && !name.trim() && !organisation.trim() && !website.trim()) return;
    setError(null);
    setPublisherProfile(next).then(apply).catch(setStringError(setError));
  }, [apply, name, organisation, view, website]);

  const rotate = useCallback(() => {
    setConfirmRotate(false);
    setError(null);
    rotatePublisherKey()
      .then((key) => setView((prev) => (prev ? { ...prev, key } : prev)))
      .catch(setStringError(setError));
  }, []);

  const forget = useCallback((keyId: string) => {
    forgetPublisher(keyId)
      .then(() => setKnown((rows) => rows.filter((row) => row.keyId !== keyId)))
      .catch(setStringError(setError));
  }, []);

  return (
    <>
      <section className="settings-section">
        <h2>Publisher</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Name</span>
            <span className="muted settings-row-detail">
              Shown on every pack you export. People see it, they never verify it.
            </span>
          </div>
          <input
            className="modal-input"
            type="text"
            size={18}
            aria-label="Publisher name"
            placeholder={view?.effectiveName ?? ""}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Organisation</span>
            <span className="muted settings-row-detail">Optional.</span>
          </div>
          <input
            className="modal-input"
            type="text"
            size={18}
            aria-label="Organisation"
            value={organisation}
            onChange={(e) => setOrganisation(e.target.value)}
            onBlur={save}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Website</span>
            <span className="muted settings-row-detail">Optional, http:// or https://</span>
          </div>
          <input
            className="modal-input"
            type="text"
            size={18}
            aria-label="Website"
            placeholder="https://"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            onBlur={save}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Device</span>
            <span className="muted settings-row-detail">
              {`${view?.device ?? "…"} · read from macOS, travels with your packs`}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">Signing key</span>
            <span className="muted settings-row-detail settings-path">
              {view?.key
                ? view.key.keyIdDisplay
                : "Created the first time you export a pack, and never leaves this Mac."}
            </span>
          </div>
          {view?.key && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const id = view.key?.keyIdDisplay;
                  if (!id) return;
                  void navigator.clipboard?.writeText(id);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => (confirmRotate ? rotate() : setConfirmRotate(true))}
                title="Packs you export after rotating will look like they came from a new publisher"
              >
                {confirmRotate ? "Rotate key?" : "Rotate"}
              </button>
            </>
          )}
        </div>
        {confirmRotate && (
          <p className="muted settings-row-detail">
            Packs you export after rotating will look like they came from a new publisher. People
            who trusted your old key will be asked again.
          </p>
        )}
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>Publishers you have imported from</h2>
        {known.length === 0 && (
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="muted settings-row-detail">
                You have not imported any packs yet.
              </span>
            </div>
          </div>
        )}
        {known.map((row) => (
          <div className="settings-row" key={row.keyId}>
            <div className="settings-row-text">
              <span className="settings-row-title">{row.organisation || row.name}</span>
              <span className="muted settings-row-detail settings-path">
                {`${row.keyIdDisplay} · first seen ${shortDate(row.firstSeen)} · ${row.packCount} pack${
                  row.packCount === 1 ? "" : "s"
                }`}
              </span>
            </div>
            <button type="button" className="btn" onClick={() => forget(row.keyId)}>
              Forget
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
