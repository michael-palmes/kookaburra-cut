import { invoke } from "@tauri-apps/api/core";
import { useTrustStore } from "../store/trustStore";

/** Thrown when the user declines the trust gate; App routes it back to the welcome screen rather than the stage-error panel. */
export class TrustDeniedError extends Error {
  constructor(slug: string) {
    super(`Project "${slug}" was not opened.`);
    this.name = "TrustDeniedError";
  }
}

/** Slugs consented this app session (session-sticky trust): their disk edits reload silently and re-stamp the stored grant, so your own work never re-asks. */
const sessionTrusted = new Set<string>();

/** Cached headless-launch check (KOOKABURRA_ACTION set); read directly rather than via autorun.ts to keep engine imports acyclic. The env cannot change mid-process. */
let autoRunLaunch: Promise<boolean> | null = null;
function isAutoRunLaunch(): Promise<boolean> {
  autoRunLaunch ??= invoke<{ action: string | null }>("get_autorun_config")
    .then((env) => Boolean(env.action?.trim()))
    .catch(() => false);
  return autoRunLaunch;
}

/** The F-001 consent gate: no workspace scene code compiles until the user has allowed the project. Autorun launches auto-trust (the run itself is the user's consent, and a modal would hang the AFK Verify); a stored grant whose fingerprint still matches passes silently; otherwise the TrustGateModal asks, and a decline throws `TrustDeniedError`. */
export async function ensureProjectTrusted(slug: string, name: string): Promise<void> {
  if (sessionTrusted.has(slug)) {
    // Re-stamp so in-session edits (the Claude terminal, external editors) stay trusted across restarts; a failure only means a re-ask next boot.
    await invoke("trust_project", { slug }).catch((e) =>
      console.warn("[trust] re-stamp failed:", e),
    );
    return;
  }
  if (await isAutoRunLaunch()) {
    await invoke("trust_project", { slug });
    sessionTrusted.add(slug);
    return;
  }
  if (await invoke<boolean>("is_project_trusted", { slug })) {
    sessionTrusted.add(slug);
    return;
  }
  const allowed = await useTrustStore.getState().request(slug, name);
  if (!allowed) throw new TrustDeniedError(slug);
  await invoke("trust_project", { slug });
  sessionTrusted.add(slug);
}
