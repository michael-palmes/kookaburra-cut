/** Stable screen names used by Scene-inspector back bars. */
const SCENE_INSPECTOR_SCREEN_TITLES: Record<string, string> = {
  text: "Text",
  frame: "Overlay",
  camera: "Camera",
  lighting: "Lighting",
  "lighting.environment": "Environment",
  "lighting.sun": "Sun & ambient",
  "lighting.fixtures": "Lights & fixtures",
  "lighting.shadows": "Shadows",
  "lighting.animation": "Animation",
  motion: "Timing",
  "text.edit": "Edit text",
  "style.background": "Background",
  "frame.panel": "Panel",
  "frame.decorations": "Decorations",
  "videoWindow.edit": "Video window",
  "compare.edit": "Comparison",
  "chart.edit": "Chart",
  "chart.position": "Position",
  "image.edit": "Image",
  "legacyImage.edit": "Image",
  "device.change": "Change device",
  "device.position": "Arrange devices",
};

export function sceneInspectorScreenTitle(
  route: string,
  options: { deviceCount?: number } = {},
): string | undefined {
  if (route === "device") return (options.deviceCount ?? 0) > 1 ? "Devices" : "Device";
  return SCENE_INSPECTOR_SCREEN_TITLES[route];
}

export function namedInspectorTitle(name: string | undefined, fallback: string): string {
  return name?.trim() ? name : fallback;
}
