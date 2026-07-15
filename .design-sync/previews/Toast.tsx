import { Toast } from "@kookaburra/chrome";

export const Success = () => (
  <div style={{ position: "relative", height: 90, width: 520 }}>
    <Toast actionLabel="Show in Finder" onAction={() => {}} onClose={() => {}}>
      Your cut is ready: identical, frame for frame.
    </Toast>
  </div>
);

// biome-ignore lint/suspicious/noShadowRestrictedNames: the export name IS the preview card's variant title
export const Error = () => (
  <div style={{ position: "relative", height: 90, width: 520 }}>
    <Toast kind="error" onClose={() => {}}>
      ffmpeg exited 1 — see the export log
    </Toast>
  </div>
);
