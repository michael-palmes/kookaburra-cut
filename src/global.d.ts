/** Absolute path to the file-based project tree, injected by Vite's `define` at build time (see vite.config.ts); used by `engine/project.ts`'s `resolveAssetPath` to hand the native side absolute asset paths for ffmpeg pre-extraction. DEV-only; bundled-app resolution is a later phase. */
declare const __PROJECTS_DIR__: string;

/** Absolute path to the DEV-only fixture tree (`fixtures/`: gate spikes and preview labs), injected the same way. Never bundled: a packaged build resolves no fixture project, so this is only ever read in dev. */
declare const __FIXTURES_DIR__: string;
