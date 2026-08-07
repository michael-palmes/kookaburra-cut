import { useEffect } from "react";
import { startHeartbeat } from "./heartbeat";

/** Shell for the hidden render window: today only the liveness heartbeat (the R1 throttling spike and the job loop's future watchdog). The engine canvas and the job protocol arrive with the capture migration. */
export function RenderApp() {
  useEffect(() => startHeartbeat(), []);
  return null;
}
