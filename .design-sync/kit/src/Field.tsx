import type { ReactNode } from "react";
import { cx } from "./cx";

export interface FieldProps {
  /** Secondary-toned label rendered above the control. */
  label: string;
  /** The control this field labels (TextInput, Select, a chip row…). */
  children: ReactNode;
  /** Optional tertiary hint line under the control (`modal-hint`). */
  hint?: string;
  className?: string;
}

/**
 * Labelled form field (`wizard-field`): a column of label + control (+ optional hint),
 * the standard dialog/wizard row. A div, not a label — controls sit adjacent to their
 * visible caption (chip rows and pickers may not be wrapped by a label).
 */
export function Field({ label, children, hint, className }: FieldProps) {
  return (
    <div className={cx("wizard-field", className)}>
      <span className="wizard-label">{label}</span>
      {children}
      {hint ? <span className="modal-hint">{hint}</span> : null}
    </div>
  );
}
