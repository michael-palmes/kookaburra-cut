import type { ReactNode } from "react";
import { cx } from "./cx";

export interface ToastProps {
  /** Colours the left edge: success (default) or danger. Never a full-panel wash. */
  kind?: "success" | "error";
  /** The message (single line, ellipsised). */
  children: ReactNode;
  /** Optional action button label (e.g. "Reveal in Finder"). */
  actionLabel?: string;
  onAction?: () => void;
  /** Renders the × dismiss control. */
  onClose?: () => void;
  className?: string;
}

/**
 * Corner toast (`toast`): elevated surface with a 3px semantic left edge. Anchors to the
 * top-right of its nearest positioned ancestor. Auto-dismiss in app code; the close
 * control is always present for manual dismissal.
 */
export function Toast({
  kind = "success",
  children,
  actionLabel,
  onAction,
  onClose,
  className,
}: ToastProps) {
  return (
    <div className={cx("toast", kind === "error" && "toast-error", className)} role="status">
      <span className="toast-msg">{children}</span>
      {actionLabel ? (
        <button type="button" className="toast-action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {onClose ? (
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={onClose}>
          ×
        </button>
      ) : null}
    </div>
  );
}
