import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** Mirror of the `kookaburra://bridge-activity` payload (src-tauri/src/capture_service.rs): sent when the render window claims a request and when it is answered. */
export interface BridgeActivity {
  active: boolean;
  id: string;
  kind: string;
  client: string;
  frames: number;
  queued: number;
}

/** How long the pill lingers after the last answer: briefly when nothing waits, longer while requests are still queued (the next claim refreshes it). */
const LINGER_MS = 1500;
const QUEUED_LINGER_MS = 15_000;

export function activityLabel(activity: Pick<BridgeActivity, "kind" | "queued">): string {
  const verb = activity.kind === "check" ? "Claude checking" : "Claude capturing";
  return activity.queued > 0 ? `${verb} · ${activity.queued} queued` : verb;
}

/** The playback bar's "Claude capturing" pill while an agent's request renders in the hidden window; the preview itself is never throttled or paused. */
export function BridgeActivityPill() {
  const [activity, setActivity] = useState<BridgeActivity | null>(null);

  useEffect(() => {
    let hide = 0;
    const unlisten = listen<BridgeActivity>("kookaburra://bridge-activity", (event) => {
      window.clearTimeout(hide);
      setActivity(event.payload);
      if (!event.payload.active) {
        hide = window.setTimeout(
          () => setActivity(null),
          event.payload.queued > 0 ? QUEUED_LINGER_MS : LINGER_MS,
        );
      }
    });
    return () => {
      window.clearTimeout(hide);
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  if (!activity) return null;
  const frames = activity.frames > 1 ? `, ${activity.frames} frames` : "";
  return (
    <span
      className="pb-activity"
      role="status"
      title={`${activity.client} asked for a ${activity.kind}${frames}; the preview keeps running`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11z" />
        <circle cx="8" cy="9" r="2" />
      </svg>
      {activityLabel(activity)}
    </span>
  );
}
