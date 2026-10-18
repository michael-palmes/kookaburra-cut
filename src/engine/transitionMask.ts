/** The image-mask transition's assets: each mask's SDF texture is decoded and built once per URL and cached at module level, because the compositor reads it SYNCHRONOUSLY at the render seam. The export preamble and the project-open settle await `preloadTransitionMasks`, so no frame renders before the field exists; a missing or unreadable mask rejects there (the export fails loudly) and a render-time miss throws during export, never a silent wrong frame. In preview a miss renders the procedural iris for a frame while the load runs, then repaints. */

import {
  ClampToEdgeWrapping,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  RedFormat,
  type ShaderMaterial,
  Vector2,
  type WebGLRenderer,
} from "three";
import { canvasHandle } from "./exportBridge";
import { isExporting } from "./exportState";
import { parseWarn } from "./parseWarnings";
import {
  isTransitionMaskSource,
  type ResolvedTransition,
  resolveTransitionParams,
  type SceneSlot,
  type TransitionMaskRef,
} from "./sceneTimeline";
import {
  buildTransitionMaskField,
  maskReveal,
  type TransitionMaskField,
} from "./transitionMaskSdf";

export interface TransitionMask {
  field: TransitionMaskField;
  texture: DataTexture;
}

const masks = new Map<string, TransitionMask>();
const loading = new Map<string, Promise<TransitionMask>>();
const warned = new Set<string>();

/** Attaches each slot's image mask: `src` resolved through `resolveUrl` (the project's asset resolver, which throws on a missing file). A bad spec or a missing file warns through parseWarn and leaves `url` null, so the export preamble refuses it. */
export function resolveSlotTransitionMasks(
  slots: SceneSlot[],
  resolveUrl: (src: string) => string,
): SceneSlot[] {
  return slots.map((slot) => {
    const spec = slot.transitionIn;
    if (spec?.shape !== "image") return slot;
    const at = `the transition into scene ${slot.index + 1}`;
    if (spec.type !== "luma") {
      parseWarn(`[transition] ${at}: shape "image" only applies to luma, so it is ignored`);
      return slot;
    }
    if (!isTransitionMaskSource(spec.src)) {
      parseWarn(
        `[transition] ${at}: shape "image" needs src, a png, jpg or webp under assets/; rendering the iris instead`,
      );
      return slot;
    }
    let url: string | null = null;
    try {
      url = resolveUrl(spec.src);
    } catch (e) {
      parseWarn(
        `[transition] ${at}: image mask "${spec.src}" not found (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return { ...slot, transitionMask: { src: spec.src, url } };
  });
}

/** The masks a timeline needs: one ref per image-mask boundary, in slot order. */
export function transitionMaskRefs(slots: readonly SceneSlot[]): TransitionMaskRef[] {
  const refs: TransitionMaskRef[] = [];
  for (const slot of slots) {
    if (!slot.transitionIn || resolveTransitionParams(slot.transitionIn).shape !== "image")
      continue;
    refs.push(slot.transitionMask ?? { src: slot.transitionIn.src ?? "", url: null });
  }
  return refs;
}

/** Decodes the image to straight RGBA bytes through a same-origin blob (an asset-protocol image would taint the canvas), with no colour conversion. */
async function decodeMaskImage(
  url: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas context");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function maskTexture(field: TransitionMaskField): DataTexture {
  const texture = new DataTexture(field.data, field.width, field.height, RedFormat, HalfFloatType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Loads, builds and caches one mask; rejects with the path and the reason. A failed URL is not retried (a re-imported asset gets a new versioned URL). */
export function loadTransitionMask(url: string, src = url): Promise<TransitionMask> {
  const pending = loading.get(url);
  if (pending) return pending;
  const load = decodeMaskImage(url)
    .then(({ data, width, height }) => {
      const field = buildTransitionMaskField(data, width, height);
      const mask = { field, texture: maskTexture(field) };
      masks.set(url, mask);
      if (!isExporting()) canvasHandle.current?.advance(performance.now());
      return mask;
    })
    .catch((e) => {
      throw new Error(
        `Transition image mask "${src}" could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  loading.set(url, load);
  return load;
}

/** The cached mask for a URL, or null while it loads (preview only starts the load). */
export function peekTransitionMask(url: string | null | undefined): TransitionMask | null {
  if (!url) return null;
  const ready = masks.get(url);
  if (ready) return ready;
  if (!isExporting()) {
    loadTransitionMask(url).catch((e) => {
      if (!warned.has(url)) {
        warned.add(url);
        console.warn(`[transition] ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }
  return null;
}

/** Export-preamble and settle barrier: every image mask the timeline uses is built (and uploaded, given `gl`) before frame 0; rejects on a missing or unreadable mask. */
export async function preloadTransitionMasks(
  slots: readonly SceneSlot[],
  gl?: WebGLRenderer,
): Promise<void> {
  const refs = transitionMaskRefs(slots);
  if (refs.length === 0) return;
  const loaded = await Promise.all(
    refs.map((ref) => {
      if (!ref.url) {
        return Promise.reject(
          new Error(
            `Transition image mask "${ref.src}" not found. Put it under the project's assets/ folder and reference it relatively.`,
          ),
        );
      }
      return loadTransitionMask(ref.url, ref.src);
    }),
  );
  if (gl) for (const mask of loaded) gl.initTexture(mask.texture);
}

/** The frame's mask for the compositor: null in preview while loading (the caller renders the iris); during export a miss throws, since the preamble guaranteed it. */
export function transitionMaskForFrame(tr: ResolvedTransition): TransitionMask | null {
  const mask = peekTransitionMask(tr.mask?.url);
  if (!mask && isExporting()) {
    throw new Error(
      `Transition image mask "${tr.mask?.src ?? ""}" is not loaded, so the frame cannot render.`,
    );
  }
  return mask;
}

/** Adds the mask uniforms to a composite material built with the shared set. */
export function withMaskUniforms(material: ShaderMaterial): ShaderMaterial {
  Object.assign(material.uniforms, {
    maskTex: { value: null },
    maskHalf: { value: new Vector2(0.5, 0.5) },
    maskInset: { value: 0 },
    maskScale: { value: 1 },
    maskDilate: { value: 0 },
    maskPixel: { value: 0.001 },
  });
  return material;
}

/** Sets one frame's mask uniforms (after the shared composite uniforms). */
export function setMaskUniforms(
  u: ShaderMaterial["uniforms"],
  tr: Pick<ResolvedTransition, "progress" | "params">,
  mask: TransitionMask,
  width: number,
  height: number,
): void {
  const reveal = maskReveal(
    tr.progress,
    width / height,
    tr.params.center,
    height,
    mask.field.inset,
  );
  u.maskTex.value = mask.texture;
  (u.maskHalf.value as Vector2).set(mask.field.half[0], mask.field.half[1]);
  u.maskInset.value = mask.field.inset;
  u.maskScale.value = reveal.scale;
  u.maskDilate.value = reveal.dilate;
  u.maskPixel.value = reveal.pixel;
}
