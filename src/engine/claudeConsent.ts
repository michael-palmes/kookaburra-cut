import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

/** Frontend face of agent_gate.rs: whether Claude is turned on. Rust keeps the kit, the bridge and the handoff shut until it is; this is what shows or hides every Claude entry point and feeds the switch. */

export type ClaudeConsent = "loading" | "undecided" | "on" | "off";

export interface ClaudeStatus {
  /** The stored answer; null until a person gives one. */
  consent: boolean | null;
  /** The gate is open: the kit, the bridge and the handoff may run. */
  allowed: boolean;
  /** Why not, when it is closed. */
  reason: string | null;
}

/** Rust emits this to every window when the answer changes, Clear all app data included. */
export const CLAUDE_CONSENT_CHANGED = "kookaburra://claude-consent-changed";

/** What a window shows before the first read lands, and when the read fails: off. */
export const CLAUDE_OFF: ClaudeStatus = { consent: null, allowed: false, reason: null };

let known: ClaudeStatus | null = null;

/** Read the gate and remember it for this window's next first paint; a failed read reads as off. */
export function claudeStatus(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("claude_status")
    .catch(() => CLAUDE_OFF)
    .then((status) => {
      known = status;
      return status;
    });
}

/** Store the answer and bring the app in line at once; resolves to what was stored (false when a profile pins it off). Every window follows through `CLAUDE_CONSENT_CHANGED`. */
export function setClaudeConsent(on: boolean): Promise<boolean> {
  return invoke<boolean>("set_claude_consent", { consent: on });
}

/** The stored tri-state; an unanswered question is "undecided", which the gate treats as off. */
export function claudeConsentFrom(stored: boolean | null | undefined): ClaudeConsent {
  if (stored === true) return "on";
  if (stored === false) return "off";
  return "undecided";
}

export interface ClaudeConsentApi {
  /** The stored answer, for the switch and the first-launch ask. */
  consent: ClaudeConsent;
  /** The gate is open; false until the first read lands, so nothing flashes open. */
  allowed: boolean;
  /** Why the gate is shut, when it is. */
  reason: string | null;
  /** No answer is stored yet: the first-launch ask is still owed. */
  askOwed: boolean;
  /** Store the answer; resolves to what was stored. */
  set: (on: boolean) => Promise<boolean>;
}

export function useClaudeConsent(): ClaudeConsentApi {
  const [status, setStatus] = useState<ClaudeStatus | null>(known);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void claudeStatus().then((next) => {
        if (!cancelled) setStatus(next);
      });
    };
    read();
    const unlisten = listen(CLAUDE_CONSENT_CHANGED, read);
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
      void unlisten.then((fn) => fn());
    };
  }, []);

  const set = useCallback(async (on: boolean) => {
    const stored = await setClaudeConsent(on);
    setStatus(await claudeStatus());
    return stored;
  }, []);

  return {
    consent: status === null ? "loading" : claudeConsentFrom(status.consent),
    allowed: status?.allowed ?? false,
    reason: status?.reason ?? null,
    askOwed: status !== null && status.consent === null,
    set,
  };
}
