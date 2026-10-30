import { MANAGED_BY_ORGANISATION } from "../engine/managed";

/** The line icon every locked control carries (design.md section 10). */
export function LockGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** Stands in for a control a configuration profile has taken over: the lock and the one-line reason, nothing to press. */
export function ManagedLock({ detail }: { detail?: string }) {
  return (
    <span className="managed-lock" title={detail}>
      <LockGlyph />
      {MANAGED_BY_ORGANISATION}
    </span>
  );
}
