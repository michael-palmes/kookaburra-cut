import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isExporting } from "./exportState";
import { managedPolicy } from "./managed";
import { getSettings } from "./workspace";

/** Frontend face of the opt-in update lane (src-tauri/src/updater.rs). All network and consent bookkeeping happens Rust-side; this module holds the pure auto-check policy and the per-window hook that drives the dialogs, the Settings rows and the manual-check surfaces. */

export type UpdateConsent = "loading" | "undecided" | "on" | "off";

export interface AvailableUpdate {
  version: string;
  pubDate: string | null;
}

export type UpdateCheckResult =
  | { kind: "devBuild" }
  | { kind: "upToDate" }
  | ({ kind: "available" } & AvailableUpdate);

export function checkForUpdate(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_update");
}

export function setUpdateConsent(consent: boolean): Promise<void> {
  return invoke<void>("set_update_consent", { consent });
}

export function installUpdateAndRelaunch(): Promise<void> {
  return invoke<void>("install_update_and_relaunch");
}

// ── Auto-check policy (pure, vitest-covered) ───────────────────────────────

/** SturtBar's cadence: automatic checks at most once per 20h; manual checks never throttle. */
export const AUTO_CHECK_THROTTLE_MS = 20 * 60 * 60 * 1000;

/** How often an open main window asks whether the throttle has lapsed; wall-clock based, so a Mac that slept catches up. */
export const AUTO_CHECK_POLL_MS = 60 * 60 * 1000;

/** A profile that turns update checks off pins consent off; the stored tri-state still says whether the welcome's ask is owed. */
export function consentFromSettings(
  raw: boolean | null | undefined,
  managedOff = false,
): UpdateConsent {
  if (managedOff) return "off";
  if (raw === true) return "on";
  if (raw === false) return "off";
  return "undecided";
}

export function shouldAutoCheck(lastCheckedMs: number | null, nowMs: number): boolean {
  return lastCheckedMs === null || nowMs - lastCheckedMs >= AUTO_CHECK_THROTTLE_MS;
}

export interface AutoCheckInput {
  storedConsent: boolean | null | undefined;
  managedOff: boolean;
  lastCheckedMs: number | null | undefined;
  /** This window's last automatic attempt, so a failing check (which stores no timestamp) still waits out the throttle. */
  lastAttemptMs: number | null;
  exporting: boolean;
  nowMs: number;
}

/** Fed fresh settings on every tick, so a switch turned off in Settings stops the next check here too. Later only hides the offer: it returns at the next check that is due. */
export function autoCheckDue(s: AutoCheckInput): boolean {
  return (
    !s.exporting &&
    consentFromSettings(s.storedConsent, s.managedOff) === "on" &&
    shouldAutoCheck(Math.max(s.lastCheckedMs ?? 0, s.lastAttemptMs ?? 0) || null, s.nowMs)
  );
}

export interface UpdateStatusInput {
  phase: "idle" | "checking" | "installing";
  devBuild: boolean;
  error: string | null;
  availableVersion: string | null;
  lastCheckedMs: number | null;
  nowMs: number;
}

/** The Settings status line, one state at a time (mirrors SturtBar's). */
export function formatUpdateStatus(s: UpdateStatusInput): string {
  if (s.phase === "checking") return "Checking…";
  if (s.phase === "installing") return "Installing…";
  if (s.devBuild) return "Not available in a dev build.";
  if (s.error) return `Couldn't check for updates: ${s.error}`;
  if (s.availableVersion) return `Update ${s.availableVersion} is available.`;
  if (s.lastCheckedMs !== null) return `${formatCheckedAgo(s.lastCheckedMs, s.nowMs)}.`;
  return "Not checked yet.";
}

/** Relative "Last checked …" wording, same buckets as Welcome's formatLastOpened. */
export function formatCheckedAgo(ms: number, nowMs: number): string {
  const minutes = Math.round((nowMs - ms) / 60_000);
  if (minutes < 1) return "Last checked just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return `Last checked ${rtf.format(-minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last checked ${rtf.format(-hours, "hour")}`;
  return `Last checked ${rtf.format(-Math.round(hours / 24), "day")}`;
}

// ── Per-window hook ────────────────────────────────────────────────────────

export interface UpdateCheckApi {
  consent: UpdateConsent;
  /** Update checks are turned off by a configuration profile: no switch, no manual check. */
  managed: boolean;
  /** The first-run welcome is still owed (no answer stored yet, managed or not). */
  welcomeOwed: boolean;
  phase: "idle" | "checking" | "installing";
  devBuild: boolean;
  error: string | null;
  installError: string | null;
  available: AvailableUpdate | null;
  /** The offer modal's visibility; `available` alone also feeds the Settings status line. */
  offerVisible: boolean;
  lastCheckedMs: number | null;
  runCheck: () => Promise<void>;
  answerConsent: (on: boolean) => Promise<void>;
  toggleConsent: (on: boolean) => Promise<void>;
  dismissOffer: () => void;
  install: () => Promise<void>;
}

export interface UseUpdateCheckOptions {
  /** Check at mount and whenever due while mounted (main window only; Settings passes false, autorun suppresses it). */
  autoCheck: boolean;
  /** Feedback for manual checks that end without an offer (mapped to a toast in the main window). */
  onManualResult?: (kind: "upToDate" | "devBuild" | "error", message: string) => void;
}

export function useUpdateCheck({
  autoCheck,
  onManualResult,
}: UseUpdateCheckOptions): UpdateCheckApi {
  const [consent, setConsent] = useState<UpdateConsent>("loading");
  const [managed, setManaged] = useState(false);
  const [welcomeOwed, setWelcomeOwed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">("idle");
  const [devBuild, setDevBuild] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [offerVisible, setOfferVisible] = useState(false);
  const [lastCheckedMs, setLastCheckedMs] = useState<number | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const lastAttemptRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSettings(), managedPolicy()])
      .then(([s, policy]) => {
        if (cancelled) return;
        setManaged(policy.disableUpdateCheck);
        setWelcomeOwed(consentFromSettings(s.updateCheckConsent) === "undecided");
        setConsent(consentFromSettings(s.updateCheckConsent, policy.disableUpdateCheck));
        setLastCheckedMs(s.lastUpdateCheckMs ?? null);
      })
      .catch(() => {
        if (!cancelled) setConsent("undecided");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const doCheck = useCallback(
    async (mode: "auto" | "manual") => {
      if (phaseRef.current !== "idle") return;
      setPhase("checking");
      setError(null);
      try {
        const result = await checkForUpdate();
        if (result.kind === "devBuild") {
          setDevBuild(true);
          if (mode === "manual")
            onManualResult?.("devBuild", "Update checks aren't available in a dev build.");
        } else if (result.kind === "upToDate") {
          setAvailable(null);
          setOfferVisible(false);
          if (mode === "manual") onManualResult?.("upToDate", "Kookaburra Cut is up to date.");
        } else {
          setAvailable(result);
          setOfferVisible(true);
        }
        if (consentRef.current === "on") setLastCheckedMs(Date.now());
      } catch (e) {
        const message = String(e);
        setError(message);
        if (mode === "manual") onManualResult?.("error", `Couldn't check for updates: ${message}`);
      } finally {
        setPhase("idle");
      }
    },
    [onManualResult],
  );

  const runCheck = useCallback(() => doCheck("manual"), [doCheck]);

  useEffect(() => {
    if (!autoCheck) return;
    let cancelled = false;
    const tick = () => {
      if (phaseRef.current !== "idle") return;
      Promise.all([getSettings(), managedPolicy()])
        .then(([s, policy]) => {
          const due = autoCheckDue({
            storedConsent: s.updateCheckConsent,
            managedOff: policy.disableUpdateCheck,
            lastCheckedMs: s.lastUpdateCheckMs,
            lastAttemptMs: lastAttemptRef.current,
            exporting: isExporting(),
            nowMs: Date.now(),
          });
          if (cancelled || !due) return;
          lastAttemptRef.current = Date.now();
          void doCheck("auto");
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, AUTO_CHECK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [autoCheck, doCheck]);

  const answerConsent = useCallback(
    async (on: boolean) => {
      setWelcomeOwed(false);
      consentRef.current = on ? "on" : "off";
      setConsent(consentRef.current);
      try {
        await setUpdateConsent(on);
      } catch {
        // Best effort: an unwritable settings file re-offers the ask next launch.
      }
      if (on) void doCheck("auto");
    },
    [doCheck],
  );

  const toggleConsent = useCallback(
    async (on: boolean) => {
      consentRef.current = on ? "on" : "off";
      setConsent(consentRef.current);
      if (!on) {
        setLastCheckedMs(null);
        setAvailable(null);
        setOfferVisible(false);
      }
      try {
        await setUpdateConsent(on);
      } catch {
        // Same best-effort stance as answerConsent.
      }
      if (on) void doCheck("auto");
    },
    [doCheck],
  );

  const dismissOffer = useCallback(() => {
    setOfferVisible(false);
    setInstallError(null);
  }, []);

  const install = useCallback(async () => {
    if (phaseRef.current === "installing") return;
    setPhase("installing");
    setInstallError(null);
    try {
      // On success the process restarts, so this never settles cleanly.
      await installUpdateAndRelaunch();
    } catch (e) {
      setInstallError(String(e));
      setPhase("idle");
    }
  }, []);

  return {
    consent,
    managed,
    welcomeOwed,
    phase,
    devBuild,
    error,
    installError,
    available,
    offerVisible,
    lastCheckedMs,
    runCheck,
    answerConsent,
    toggleConsent,
    dismissOffer,
    install,
  };
}
