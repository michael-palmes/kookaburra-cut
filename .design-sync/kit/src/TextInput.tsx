import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "./cx";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Single-line text input (`modal-input`): a recessed trough (`--surface-recessed`) with a
 * 1px border that strengthens on focus. The standard text field in dialogs and wizards.
 */
export function TextInput({ className, ...rest }: TextInputProps) {
  return <input className={cx("modal-input", className)} {...rest} />;
}

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multi-line variant of the recessed text trough (`modal-input wizard-textarea`). */
export function TextArea({ className, ...rest }: TextAreaProps) {
  return <textarea className={cx("modal-input", "wizard-textarea", className)} {...rest} />;
}
