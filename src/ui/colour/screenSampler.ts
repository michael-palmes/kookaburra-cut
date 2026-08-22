import { invoke } from "@tauri-apps/api/core";
import { normaliseHex } from "./colourUtils";

/** The native eyedropper (AppKit's NSColorSampler); null means the user cancelled or the call failed. Never throws at the caller, so the button can always leave its sampling state. */
export async function sampleScreenColour(
  onError?: (message: string) => void,
): Promise<string | null> {
  try {
    const sampled = await invoke<string | null>("sample_screen_colour");
    return typeof sampled === "string" ? normaliseHex(sampled) : null;
  } catch (error) {
    onError?.(String(error));
    return null;
  }
}
