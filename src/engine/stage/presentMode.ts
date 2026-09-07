/** Realm-local present-mode flag: set once by a present window at boot, permanently false in the editor and export realms, so shared primitives can adapt ambient motion to open-ended slideshow holds without touching exported pixels. */

let slideshow = false;

export function setPresentSlideshowActive(active: boolean): void {
  slideshow = active;
}

export function presentSlideshowActive(): boolean {
  return slideshow;
}
