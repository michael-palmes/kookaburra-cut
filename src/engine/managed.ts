import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** Frontend face of managed.rs: the policy a configuration profile forces on this Mac. Rust refuses every governed command on its own; this is what hides or locks the entry points so a managed user sees a reason, not a failure. Unmanaged Macs read every field as off, and nothing changes for them. */

export interface ManagedPolicy {
  /** True when any key is forced. */
  managed: boolean;
  disableClaude: boolean;
  disableLiveWebsites: boolean;
  /** Approved pack publisher key ids; null when unmanaged, an empty list means no pack imports. */
  allowedPublisherKeyIds: string[] | null;
  disableUpdateCheck: boolean;
  /** The fixed workspace root, when the profile's value was usable. */
  workspaceRoot: string | null;
  /** True whenever WorkspaceRoot is forced, usable or not: relocation is refused either way. */
  workspaceRootLocked: boolean;
  forcedKeys: string[];
}

export const UNMANAGED: ManagedPolicy = {
  managed: false,
  disableClaude: false,
  disableLiveWebsites: false,
  allowedPublisherKeyIds: null,
  disableUpdateCheck: false,
  workspaceRoot: null,
  workspaceRootLocked: false,
  forcedKeys: [],
};

/** What an unreadable policy becomes: every governed feature off, since Rust refuses them regardless. */
export const LOCKED_DOWN: ManagedPolicy = {
  managed: true,
  disableClaude: true,
  disableLiveWebsites: true,
  allowedPublisherKeyIds: [],
  disableUpdateCheck: true,
  workspaceRoot: null,
  workspaceRootLocked: true,
  forcedKeys: [],
};

/** Every refusal a managed key causes starts with this (managed.rs `REASON_PREFIX`). */
export const MANAGED_REASON_PREFIX = "managed:";

/** The one line a locked control shows in place of itself. */
export const MANAGED_BY_ORGANISATION = "Managed by your organisation";

/** Tauri rejects with the command's own string; an Error wrapper is unwrapped the same way. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isManagedRefusal(error: unknown): boolean {
  return errorText(error).startsWith(MANAGED_REASON_PREFIX);
}

/** An error's text for the user: a managed refusal without its marker, anything else as it came. */
export function plainError(error: unknown): string {
  const text = errorText(error);
  return isManagedRefusal(error) ? text.slice(MANAGED_REASON_PREFIX.length).trim() : text;
}

let pending: Promise<ManagedPolicy> | null = null;
let known: ManagedPolicy | null = null;

/** Read once per window and cached; a failed read fails closed. */
export function managedPolicy(): Promise<ManagedPolicy> {
  if (!pending) {
    pending = invoke<ManagedPolicy>("managed_policy")
      .catch((e) => {
        console.warn("[managed] policy unavailable, locking governed features:", e);
        return LOCKED_DOWN;
      })
      .then((policy) => {
        known = policy;
        return policy;
      });
  }
  return pending;
}

/** The cached policy, null until the first read lands. */
export function managedPolicyNow(): ManagedPolicy | null {
  return known;
}

/** Test-only: forget the cached policy so the next read asks again. */
export function resetManagedPolicyForTests(): void {
  pending = null;
  known = null;
}

/** Null until known; callers hide what the policy governs until then, so nothing managed ever flashes open. */
export function useManagedPolicy(): ManagedPolicy | null {
  const [policy, setPolicy] = useState<ManagedPolicy | null>(known);
  useEffect(() => {
    let cancelled = false;
    managedPolicy().then((loaded) => {
      if (!cancelled) setPolicy(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return policy;
}
