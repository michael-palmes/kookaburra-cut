/** The stage landmark's name: what is on screen and where, in whole seconds so the name settles while playing (WCAG 1.1.1). */
export function stageRegionLabel(
  scene: { title: string; index: number; count: number } | null,
  currentMs: number,
): string {
  if (!scene) return "Preview";
  const total = Math.max(0, Math.floor(currentMs / 1000));
  const time = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  return `Preview: ${scene.title}, scene ${scene.index + 1} of ${scene.count}, at ${time}`;
}
