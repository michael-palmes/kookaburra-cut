/** The two decisions behind the switch-to-Free warning, kept free of React so both are testable on their own. */

export type FreeCameraAnswer = "confirm" | "cancel";

/** Whether a switch-to-Free intent waits for the warning, or runs straight away. */
export function needsFreeCameraWarning(dismissed: boolean): boolean {
  return !dismissed;
}

/** What closing the warning does: only a confirm runs the held intent, and only a confirmed tick stops the warning coming back, so a hesitant user still gets the explanation next time. */
export function resolveFreeCameraWarning(
  answer: FreeCameraAnswer,
  dontShowAgain: boolean,
): { runIntent: boolean; persistDismissal: boolean } {
  const confirmed = answer === "confirm";
  return { runIntent: confirmed, persistDismissal: confirmed && dontShowAgain };
}
