/** Slideshow ambience: the project soundtrack looping as background music, deliberately decoupled from the deck (slideshow pacing is unpredictable, so there is nothing to sync to). Video mode uses previewAudio's clock-synced lane instead. */

import { fsUrl } from "../engine/media";
import type { LoadedProject } from "../engine/project";

let el: HTMLAudioElement | null = null;

export function startPresentAmbience(project: LoadedProject): void {
  stopPresentAmbience();
  const audio = project.audio;
  if (!audio) return;
  const a = new Audio(fsUrl(audio.abs));
  a.loop = true;
  a.volume = Math.min(1, 10 ** ((audio.gainDb ?? 0) / 20));
  el = a;
  void a.play().catch(() => {
    // WKWebView may refuse autoplay before a gesture; start on the first interaction instead.
    const retry = () => {
      void el?.play().catch(() => {});
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
    };
    window.addEventListener("pointerdown", retry);
    window.addEventListener("keydown", retry);
  });
}

export function stopPresentAmbience(): void {
  el?.pause();
  el = null;
}
