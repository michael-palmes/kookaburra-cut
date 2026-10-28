import { invoke } from "@tauri-apps/api/core";

/** Thrown when the user declines the trust gate; App routes it back to the welcome screen rather than the stage-error panel. */
export class TrustDeniedError extends Error {
  /** The manifest display name, for the Welcome screen's explanation. */
  readonly projectName: string;
  constructor(slug: string, name?: string) {
    super(`Project "${slug}" was not opened.`);
    this.name = "TrustDeniedError";
    this.projectName = name || slug;
  }
}

/** An autorun under `KOOKABURRA_TRUST=stored-only` met a project whose sources changed since the user allowed it (or never allowed); the run reports `needsTrust` rather than prompting or auto-trusting. */
export class NeedsTrustError extends Error {
  constructor(slug: string) {
    super(
      `Project "${slug}" has code Kookaburra Cut has not allowed yet (it is new to this app, or changed since it was last opened); open it once in the app to allow it, then rerun.`,
    );
    this.name = "NeedsTrustError";
  }
}

/** Cached headless-launch check (KOOKABURRA_ACTION set, and whether KOOKABURRA_TRUST pins it to stored grants); read directly rather than via autorun.ts to keep engine imports acyclic. The env cannot change mid-process. */
let autoRunLaunch: Promise<{ autoRun: boolean; storedOnly: boolean }> | null = null;
function autoRunTrust(): Promise<{ autoRun: boolean; storedOnly: boolean }> {
  autoRunLaunch ??= invoke<{ action: string | null; trust?: string | null }>("get_autorun_config")
    .then((env) => ({
      autoRun: Boolean(env.action?.trim()),
      storedOnly: env.trust?.trim() === "stored-only",
    }))
    .catch(() => ({ autoRun: false, storedOnly: false }));
  return autoRunLaunch;
}

/** One consent request in flight per slug: the reload poll can re-enter `loadProject` while the sheet is up, and both loads must share the one answer. */
const inflight = new Map<string, Promise<void>>();

/** Ask natively. Rust shows the consent sheet (Return declines) and, on Allow, mints a single-use nonce that `trust_project` redeems; a null nonce is the decline. An autorun launch gets its nonce without a sheet (the run is the user's consent), and Rust refuses under stored-only. */
function requestTrust(slug: string, name: string): Promise<void> {
  const existing = inflight.get(slug);
  if (existing) return existing;
  const request = (async () => {
    const nonce = await invoke<string | null>("request_project_trust", { slug });
    if (!nonce) throw new TrustDeniedError(slug, name);
    await invoke("trust_project", { slug, nonce });
  })().finally(() => inflight.delete(slug));
  inflight.set(slug, request);
  return request;
}

/** The F-001 consent gate: no workspace scene code compiles until the person has allowed the project's current content. A stored grant whose content fingerprint still matches passes silently; anything else asks through the native sheet, and a decline throws `TrustDeniedError`. The app's own writes re-stamp the grant natively, so only a change made outside the app re-asks. Autorun launches auto-trust (the run itself is the user's consent) unless `KOOKABURRA_TRUST=stored-only` (kb's headless export, which must not launder consent), which needs a matching stored grant. */
export async function ensureProjectTrusted(
  slug: string,
  name: string,
  mode?: "stored-only",
): Promise<void> {
  if (mode === "stored-only") {
    if (!(await invoke<boolean>("is_project_trusted", { slug })))
      throw new TrustDeniedError(slug, name);
    return;
  }
  const launch = await autoRunTrust();
  if (launch.autoRun && launch.storedOnly) {
    if (!(await invoke<boolean>("is_project_trusted", { slug }))) throw new NeedsTrustError(slug);
    return;
  }
  if (await invoke<boolean>("is_project_trusted", { slug })) return;
  await requestTrust(slug, name);
}
