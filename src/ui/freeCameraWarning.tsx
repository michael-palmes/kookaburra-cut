import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LoadedProject } from "../engine/project";
import { useUiStore } from "../store/uiStore";
import { FreeCameraWarningModal } from "./dialogs";
import {
  type FreeCameraAnswer,
  needsFreeCameraWarning,
  resolveFreeCameraWarning,
} from "./freeCameraGate";
import { modalHost } from "./modalHost";

/** Gates a switch-to-Free intent behind the warning: once dismissed the intent runs on the spot, otherwise it waits for the modal's answer and Cancel drops it untouched. The pending intent is per call site, so the camera pill and the inspector each open their own dialog. */
export function useFreeCameraWarning(
  project: LoadedProject,
  sceneIndex: number,
): {
  requestFreeMode: (intent: () => void) => void;
  freeCameraWarning: ReactNode;
} {
  const dismissed = useUiStore((s) => s.freeCameraWarningDismissed);
  const setDismissed = useUiStore((s) => s.setFreeCameraWarningDismissed);
  const [pending, setPending] = useState<{ run: () => void } | null>(null);

  // A held intent belongs to the scene it was raised on, so playback crossing into the next scene (or a reload swapping the project) retires it rather than switching a scene the user has moved off.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loaded project and scene ARE the binding
  useEffect(() => setPending(null), [project, sceneIndex]);

  const requestFreeMode = useCallback(
    (intent: () => void) => {
      if (needsFreeCameraWarning(dismissed)) setPending({ run: intent });
      else intent();
    },
    [dismissed],
  );

  const answer = (given: FreeCameraAnswer, dontShowAgain: boolean) => {
    const { runIntent, persistDismissal } = resolveFreeCameraWarning(given, dontShowAgain);
    setPending(null);
    if (persistDismissal) setDismissed(true);
    if (runIntent) pending?.run();
  };

  return {
    requestFreeMode,
    freeCameraWarning: pending
      ? createPortal(
          <FreeCameraWarningModal
            onConfirm={(dontShowAgain) => answer("confirm", dontShowAgain)}
            onCancel={() => answer("cancel", false)}
          />,
          modalHost(),
        )
      : null,
  };
}
