import {
  type BufferAttribute,
  type Material,
  Matrix4,
  type Mesh,
  type MeshBasicMaterial,
  type Object3D,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import {
  FOLD_BLUR_LEAD,
  FOLD_BLUR_TAPS,
  FOLD_STATIC_GUARD,
  type FoldScreenState,
} from "../../engine/foldTransition";
import type { UvRect } from "../../engine/screenFit";

/** The handover on a foldable's display. Two things happen in one pass, both in the display's own space so the bend and perspective come free from rasterisation:
 *
 * 1. FLAT PROJECTION. The fragment's position in the device's root frame is cast from a fixed eye in front of the device onto the display's HOME plane (open flat for the inside display, closed for the outside one), and the media is sampled where that ray lands. From the front the content stays level while the panel swings, a horizon runs straight across the hinge, and the panel is black where the projected content runs out. A fixed eye, not the scene camera: it is what the hardware can know, and the content never swims as a shot orbits.
 * 2. PROGRESSIVE BLUR AND DIMMING up one smooth ramp along the moving panel (measured off Apple's footage; the static half is left alone), a fixed-tap Vogel disc with a per-pixel hashed rotation (the `SmearEffect` recipe). Taps that land off the display read black, so the projected content's edge is soft rather than a hard line.
 *
 * No render target (the frame stays on the direct path) and no mipmaps (clip frames carry none, and adding them would change the sharp path's sampling). Only foldable screen materials ever take this patch. The sweep maths mirrors `foldSampleAt`. */

interface FoldScreenUniforms {
  uFoldCrop: { value: Vector4 };
  uFoldAxis: { value: Vector2 };
  uFoldFront: { value: number };
  uFoldSoftFront: { value: number };
  uFoldRamp: { value: number };
  uFoldBlur: { value: number };
  uFoldDarken: { value: number };
  uFoldFlat: { value: number };
  uFoldAspect: { value: number };
  uFoldHomeRect: { value: Vector4 };
  uFoldHomeZ: { value: number };
  uFoldEye: { value: Vector3 };
  uFoldRootInv: { value: Matrix4 };
}

/** A display's home pose in the device's root frame: the rect its panel UVs span (origin at uv 0,0; a negative size flips an axis) and the plane it lies in. */
export interface FoldHome {
  rect: Vector4;
  z: number;
}

const glsl = (n: number): string => n.toFixed(4);

const VERTEX_PARS = /* glsl */ `#include <common>
uniform mat4 uFoldRootInv;
varying vec3 vFoldRootPos;`;

// After skinning, so a bent display projects from where its surface really is.
const VERTEX = /* glsl */ `#include <project_vertex>
vFoldRootPos = ( uFoldRootInv * modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;

const PARS = /* glsl */ `#include <map_pars_fragment>
uniform vec4 uFoldCrop;
uniform vec2 uFoldAxis;
uniform float uFoldFront;
uniform float uFoldSoftFront;
uniform float uFoldRamp;
uniform float uFoldBlur;
uniform float uFoldDarken;
uniform float uFoldFlat;
uniform float uFoldAspect;
uniform vec4 uFoldHomeRect;
uniform float uFoldHomeZ;
uniform vec3 uFoldEye;
varying vec3 vFoldRootPos;

// PCG-style integer hash: a pure function of the pixel, never a sine hash, whose bits drift between GPUs.
float foldHash( uvec2 p ) {
	uint h = p.x * 374761393u ^ p.y * 668265263u;
	h ^= h >> 13; h *= 1274126177u; h ^= h >> 16;
	return float( h & 0x00FFFFFFu ) / 16777216.0;
}

// The media at a panel coordinate, or black off the display: what makes the projected edge soft under blur.
vec4 foldTap( vec2 panel, vec2 dx, vec2 dy ) {
	vec2 inside = step( vec2( 0.0 ), panel ) * step( panel, vec2( 1.0 ) );
	vec2 uv = uFoldCrop.xy + clamp( panel, 0.0, 1.0 ) * ( uFoldCrop.zw - uFoldCrop.xy );
	return textureGrad( map, uv, dx, dy ) * ( inside.x * inside.y );
}`;

const FRAGMENT = /* glsl */ `#ifdef USE_MAP
	vec4 sampledDiffuseColor;
	if ( uFoldBlur <= 0.0 && uFoldDarken <= 0.0 && uFoldFlat <= 0.0 ) {
		sampledDiffuseColor = texture2D( map, vMapUv );
	} else {
		// The baked cover crop is affine, so the panel coordinate comes straight back out of the media UV.
		vec2 foldSpan = uFoldCrop.zw - uFoldCrop.xy;
		vec2 foldOwn = ( vMapUv - uFoldCrop.xy ) / foldSpan;
		// Cast from the fixed front eye through this fragment onto the display's home plane.
		float foldT = ( uFoldHomeZ - uFoldEye.z ) / min( vFoldRootPos.z - uFoldEye.z, -1e-6 );
		vec2 foldHit = uFoldEye.xy + ( vFoldRootPos.xy - uFoldEye.xy ) * foldT;
		vec2 foldPanel = mix( foldOwn, ( foldHit - uFoldHomeRect.xy ) / uFoldHomeRect.zw, uFoldFlat );
		// The ramp rides the PANEL (0 at the hinge, 1 at its free edge, which darkens first); the picture rides the projection. It fades out within a short guard on a static half.
		float foldCoord = uFoldAxis.x + uFoldAxis.y * foldOwn.x;
		float foldGuard = 1.0 - smoothstep( 0.0, ${glsl(FOLD_STATIC_GUARD)}, - foldCoord );
		float foldRamp = smoothstep( 0.0, uFoldRamp, foldCoord - uFoldFront ) * foldGuard;
		// The picture softens ahead of the dimming.
		float foldSoft = smoothstep( 0.0, uFoldRamp, foldCoord - uFoldSoftFront ) * foldGuard;
		float foldRadius = uFoldBlur * min( 1.0, foldSoft * ${glsl(FOLD_BLUR_LEAD)} );
		// Explicit gradients: the taps sit in per-fragment control flow, where implicit ones are undefined.
		vec2 foldDx = dFdx( vMapUv );
		vec2 foldDy = dFdy( vMapUv );
		if ( foldRadius > 0.0 ) {
			float foldTurn = 6.28318531 * foldHash( uvec2( gl_FragCoord.xy ) );
			vec4 foldSum = vec4( 0.0 );
			for ( int i = 0; i < ${FOLD_BLUR_TAPS}; i ++ ) {
				float fi = float( i );
				float foldR = sqrt( ( fi + 0.5 ) / ${glsl(FOLD_BLUR_TAPS)} ) * foldRadius;
				float foldA = fi * 2.39996323 + foldTurn;
				// A disc in display widths, squared up by the display's aspect.
				foldSum += foldTap( foldPanel + vec2( cos( foldA ), sin( foldA ) * uFoldAspect ) * foldR, foldDx, foldDy );
			}
			sampledDiffuseColor = foldSum / ${glsl(FOLD_BLUR_TAPS)};
		} else {
			sampledDiffuseColor = foldTap( foldPanel, foldDx, foldDy );
		}
		sampledDiffuseColor.rgb *= 1.0 - foldRamp * uFoldDarken;
		sampledDiffuseColor.a = 1.0;
	}
	diffuseColor *= sampledDiffuseColor;
#endif`;

/** The patched chunks, exported so a test can pin the early-out and the contract constants. */
export const FOLD_SCREEN_GLSL = {
  vertexPars: VERTEX_PARS,
  vertex: VERTEX,
  pars: PARS,
  fragment: FRAGMENT,
};

const uniformsOf = (material: Material): FoldScreenUniforms | undefined =>
  material.userData.foldScreen as FoldScreenUniforms | undefined;

/** Patches one foldable display's material. `aspect` is the display's width over height. */
export function applyFoldScreenShader(material: MeshBasicMaterial, aspect: number): void {
  const uniforms: FoldScreenUniforms = {
    uFoldCrop: { value: new Vector4(0, 0, 1, 1) },
    uFoldAxis: { value: new Vector2(0, 0) },
    uFoldFront: { value: 0 },
    uFoldSoftFront: { value: 0 },
    uFoldRamp: { value: 1 },
    uFoldBlur: { value: 0 },
    uFoldDarken: { value: 0 },
    uFoldFlat: { value: 0 },
    uFoldAspect: { value: aspect },
    uFoldHomeRect: { value: new Vector4(0, 0, 1, 1) },
    uFoldHomeZ: { value: 0 },
    uFoldEye: { value: new Vector3(0, 0, 1) },
    uFoldRootInv: { value: new Matrix4() },
  };
  material.userData.foldScreen = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", VERTEX_PARS)
      .replace("#include <project_vertex>", VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <map_pars_fragment>", PARS)
      .replace("#include <map_fragment>", FRAGMENT);
  };
  material.customProgramCacheKey = () => "kookaburra-fold-screen-v1";
}

/** The media's cover crop, so the shader can turn a media UV back into a panel coordinate. Inert on any other material. */
export function setFoldScreenCrop(material: Material, rect: UvRect): void {
  uniformsOf(material)?.uFoldCrop.value.set(rect.u0, rect.v0, rect.u1, rect.v1);
}

/** This frame's handover state and eye; CPU-written per frame, never derived from time in GLSL. */
export function setFoldScreenState(material: Material, state: FoldScreenState, eye: Vector3): void {
  const uniforms = uniformsOf(material);
  if (!uniforms) return;
  uniforms.uFoldAxis.value.set(state.offset, state.scale);
  uniforms.uFoldFront.value = state.front;
  uniforms.uFoldSoftFront.value = state.softFront;
  uniforms.uFoldRamp.value = state.ramp;
  uniforms.uFoldBlur.value = state.blur;
  uniforms.uFoldDarken.value = state.darken;
  uniforms.uFoldFlat.value = state.flat;
  uniforms.uFoldEye.value.copy(eye);
}

/** Where a display's panel UVs sit in the device's root frame, read off the rig while it is posed at that display's home angle. The UV map is affine and axis aligned, so a least-squares line per axis recovers the rect exactly. */
export function measureFoldHome(root: Object3D, meshes: Mesh[]): FoldHome {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const at = new Vector3();
  const rows: Array<[number, number, number, number, number]> = [];
  for (const mesh of meshes) {
    const base = mesh.userData.screenBaseUv as Float32Array | undefined;
    const uv = mesh.geometry.getAttribute("uv") as BufferAttribute | undefined;
    if (!uv) continue;
    for (let i = 0; i < uv.count; i++) {
      // Skinning included: a bent display is measured where its surface really is.
      mesh.getVertexPosition(i, at).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRoot);
      rows.push([
        at.x,
        at.y,
        at.z,
        base ? base[i * 2] : uv.getX(i),
        base ? base[i * 2 + 1] : uv.getY(i),
      ]);
    }
  }
  const line = (pos: 0 | 1, tex: 3 | 4): [number, number] => {
    const n = rows.length;
    const mp = rows.reduce((sum, r) => sum + r[pos], 0) / n;
    const mt = rows.reduce((sum, r) => sum + r[tex], 0) / n;
    const slope =
      rows.reduce((sum, r) => sum + (r[pos] - mp) * (r[tex] - mt), 0) /
      rows.reduce((sum, r) => sum + (r[pos] - mp) ** 2, 0);
    // uv = slope * position + (mt - slope * mp), so uv 0 sits at mp - mt / slope and the span is 1 / slope.
    return [mp - mt / slope, 1 / slope];
  };
  const [x0, width] = line(0, 3);
  const [y0, height] = line(1, 4);
  return {
    rect: new Vector4(x0, y0, width, height),
    z: rows.reduce((sum, r) => sum + r[2], 0) / rows.length,
  };
}

/** Stores a display's home, and keeps the material's root-frame matrix current at draw time (world matrices are only final then). */
export function bindFoldScreenHome(
  root: Object3D,
  meshes: Mesh[],
  material: Material,
  home: FoldHome,
): void {
  const uniforms = uniformsOf(material);
  if (!uniforms) return;
  uniforms.uFoldHomeRect.value.copy(home.rect);
  uniforms.uFoldHomeZ.value = home.z;
  for (const mesh of meshes) {
    mesh.onBeforeRender = () => {
      uniforms.uFoldRootInv.value.copy(root.matrixWorld).invert();
    };
  }
}
