import { clipCacheCensus } from "./clips";
import { canvasHandle } from "./exportBridge";
import { setSceneReleaseEnabled } from "./sceneRelease";

/** What the memory probe counts in the realm that holds the textures: three's GPU residency and the clip frame cache. */
export interface MemoryCensus {
  glTextures: number;
  glGeometries: number;
  glPrograms: number;
  clipTextures: number;
  clipBytes: number;
}

export function memoryCensus(): MemoryCensus {
  const info = canvasHandle.current?.gl.info;
  const clips = clipCacheCensus();
  return {
    glTextures: info?.memory.textures ?? 0,
    glGeometries: info?.memory.geometries ?? 0,
    glPrograms: info?.programs?.length ?? 0,
    clipTextures: clips.textures,
    clipBytes: clips.bytes,
  };
}

/** The levers that change something in the stage realm (engine/memoryProbe.ts). */
export function applyStageMemoryLever(lever: string): void {
  if (lever === "scene-release=off") setSceneReleaseEnabled(false);
}
