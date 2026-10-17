import { invoke } from "@tauri-apps/api/core";
import { useTrustStore } from "../store/trustStore";

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
      `Project "${slug}" changed since it was last opened in Kookaburra Cut; open it once in the app to allow its code, then rerun.`,
    );
    this.name = "NeedsTrustError";
  }
}

/** Slugs consented this app session (session-sticky trust): their disk edits reload silently and re-stamp the stored grant, so your own work never re-asks. */
const sessionTrusted = new Set<string>();

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

/** The F-001 consent gate: no workspace scene code compiles until the user has allowed the project. Autorun launches auto-trust (the run itself is the user's consent, and a modal would hang the AFK Verify) unless `KOOKABURRA_TRUST=stored-only` (kb's headless export, which must not launder consent), which needs a matching stored grant; a stored grant whose fingerprint still matches passes silently; otherwise the TrustGateModal asks, and a decline throws `TrustDeniedError`. */
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
  if (sessionTrusted.has(slug)) {
    // Re-stamp so in-session edits (the Claude terminal, external editors) stay trusted across restarts; a failure only means a re-ask next boot.
    await invoke("trust_project", { slug }).catch((e) =>
      console.warn("[trust] re-stamp failed:", e),
    );
    return;
  }
  const launch = await autoRunTrust();
  if (launch.autoRun) {
    if (launch.storedOnly) {
      if (!(await invoke<boolean>("is_project_trusted", { slug }))) throw new NeedsTrustError(slug);
      return;
    }
    await invoke("trust_project", { slug });
    sessionTrusted.add(slug);
    return;
  }
  if (await invoke<boolean>("is_project_trusted", { slug })) {
    sessionTrusted.add(slug);
    return;
  }
  const allowed = await useTrustStore.getState().request(slug, name);
  if (!allowed) throw new TrustDeniedError(slug, name);
  await invoke("trust_project", { slug });
  sessionTrusted.add(slug);
}

const RESTAMP_DELAY_MS = 2000;
const restampTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The app's own write in a project trusted this session: re-stamp the stored grant once the writes settle, so a restart doesn't ask about edits made in the app. */
export function scheduleTrustRestamp(slug: string): void {
  if (!sessionTrusted.has(slug)) return;
  clearTimeout(restampTimers.get(slug));
  restampTimers.set(
    slug,
    setTimeout(() => {
      restampTimers.delete(slug);
      invoke("trust_project", { slug }).catch((e) => console.warn("[trust] re-stamp failed:", e));
    }, RESTAMP_DELAY_MS),
  );
}
