import type { ReactNode } from "react";
import { cx } from "./cx";

export interface ModalProps {
  /** Dialog title (16px semibold), rendered in a `modal-title-row` beside the close control. */
  title?: string;
  /** Renders the drawn-cross close control (`modal-close`) and wires its click. */
  onClose?: () => void;
  /** Wide layout (`wizard-wide`, 46rem) for dialogs hosting pickers or grids. */
  wide?: boolean;
  /** Footer actions (`modal-actions`), right-aligned — put the one primary Button last. */
  actions?: ReactNode;
  /** Dialog body content. */
  children?: ReactNode;
  className?: string;
}

/**
 * Modal dialog on the scrim (`modal-overlay` > `modal`): elevated surface, 12px radius,
 * the app's one dialog shadow. Compose body content from Field/TextInput/Select;
 * `modal-error` / `modal-hint` classes are available for inline validation lines.
 */
export function Modal({ title, onClose, wide, actions, children, className }: ModalProps) {
  return (
    <div className="modal-overlay">
      <div
        className={cx("modal", wide && "wizard-wide", className)}
        role="dialog"
        aria-modal="true"
      >
        {title || onClose ? (
          <div className="modal-title-row">
            {title ? <h2>{title}</h2> : null}
            {onClose ? (
              <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
