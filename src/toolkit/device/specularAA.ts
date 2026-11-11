import { GSAA_FRAGMENT } from "./gsaa";

/** `render.specularAA`: Tokuyoshi and Kaplanyan's filter in GGX alpha space (α'² = α² + min(2σ²|∇n|², κ)), where the legacy GSAA widens perceptual roughness and so filters smooth metal least. σ² = 1/2π and κ = 0.18 are export contract. */
export const SPECULAR_AA_FRAGMENT = /* glsl */ `#include <lights_physical_fragment>
{
	vec3 saaDx = dFdx( normal );
	vec3 saaDy = dFdy( normal );
	float saaKernel = min( 0.3183099 * ( dot( saaDx, saaDx ) + dot( saaDy, saaDy ) ), 0.18 );
	float saaAlpha = material.roughness * material.roughness;
	material.roughness = min( sqrt( sqrt( saaAlpha * saaAlpha + saaKernel ) ), 1.0 );
	#ifdef USE_ANISOTROPY
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	#endif
}`;

/** Per-octave fade of the finish's hairline grain: each octave is gone before its cells reach two pixels, so no octave ever aliases. */
export const SPECULAR_AA_GRAIN = /* glsl */ `
	vec2 kbFw = vec2( fwidth( kbC.x ), fwidth( kbC.y ) );
	float kbF1 = 1.0 - smoothstep( 0.25, 0.5, max( kbFw.x, kbFw.y ) );
	float kbF2 = 1.0 - smoothstep( 0.25, 0.5, max( kbFw.x * 3.1, kbFw.y * 1.3 ) );
	kbG = ( ( kbNoise( kbC ) - 0.5 ) * 0.6 * kbF1 + ( kbNoise( kbC * vec2( 3.1, 1.3 ) + vec2( 17.0, 3.0 ) ) - 0.5 ) * 0.4 * kbF2 ) * ( 1.0 - kbChamfer ) * kbGrain;
`;

/** The roughness filter and its program-key suffix: the legacy GSAA, or `render.specularAA`'s. */
export function gsaaChunk(specularAA: boolean): { fragment: string; key: string } {
  return specularAA
    ? { fragment: SPECULAR_AA_FRAGMENT, key: "-saa" }
    : { fragment: GSAA_FRAGMENT, key: "" };
}
