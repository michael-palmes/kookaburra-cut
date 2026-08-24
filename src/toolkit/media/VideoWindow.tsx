import { SceneWindowMedia } from "./SceneMedia";

export interface VideoWindowProps {
  /** Reserved: the primitive is sidecar-driven; props may later override the doc. */
  _reserved?: never;
}

/** The scene document's windowed media: a screen recording (or a still) presented as a floating rounded window with a drop shadow, over whatever the scene stages behind it; sits in world space so the per-scene camera moves around it with real parallax. Registers the scene as the window family's consumer so the host-side fallback stands down. */
export function VideoWindow(_props: VideoWindowProps = {}) {
  return <SceneWindowMedia />;
}
