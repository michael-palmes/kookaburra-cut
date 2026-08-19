/** Scene-length text: the one `m:ss.cs` display and the one parser behind every typed scene length (the inspector Duration row, the scene manager, the animation lane readout, the playback bar). Typing takes either form, `1:45` and `105` both mean 105 seconds. Every other duration surface (transitions, keyframes, media, project totals) keeps its own formatting. */

/** The floor every scene-length field shares: shorter than this is dropped silently. */
export const MIN_SCENE_LENGTH_MS = 100;

const MMSS = /^(\d*):(\d{1,2})(\.\d+)?$/;
const PLAIN = /^(?:\d+\.?\d*|\.\d+)$/;

/** Seconds as `m:ss.cs`, always two-digit seconds and centiseconds: 8.5 -> "0:08.50", 105 -> "1:45.00". Rounds to the nearest centisecond (the precision the fields already had) and carries: 59.999 -> "1:00.00". Negatives and non-finite values render as "0:00.00". */
export function formatSceneLength(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const cs = Math.round(total * 100);
  const mm = Math.floor(cs / 6000);
  const ss = String(Math.floor((cs % 6000) / 100)).padStart(2, "0");
  return `${mm}:${ss}.${String(cs % 100).padStart(2, "0")}`;
}

/** `formatSceneLength(ms / 1000)`, the form the callers actually hold. */
export function formatSceneLengthMs(ms: number): string {
  return formatSceneLength(ms / 1000);
}

/** A typed scene length in seconds, or null when the text is not one. Accepts `m:ss`, `m:ss.f…`, `:ss` and a plain seconds number; in `m:ss` form the seconds field is a clock field, so 60 and over is a typo, not 1:15. Applies no floor: use `parseSceneLengthMs` for that. */
export function parseSceneLength(text: string): number | null {
  const raw = text.trim();
  const mmss = MMSS.exec(raw);
  if (mmss) {
    const seconds = Number(mmss[2]) + (mmss[3] ? Number(mmss[3]) : 0);
    if (seconds >= 60) return null;
    return Number(mmss[1] || "0") * 60 + seconds;
  }
  if (!PLAIN.test(raw)) return null;
  return Number(raw);
}

/** A typed scene length as whole milliseconds, or null when the text is junk or under `MIN_SCENE_LENGTH_MS`. The single commit-side check every scene-length field uses. */
export function parseSceneLengthMs(text: string): number | null {
  const seconds = parseSceneLength(text);
  if (seconds === null) return null;
  const ms = Math.round(seconds * 1000);
  return ms >= MIN_SCENE_LENGTH_MS ? ms : null;
}
