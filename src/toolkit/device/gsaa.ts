/** Geometric specular AA (Kaplanyan/Tokuyoshi-Kaplanyan): widens roughness by the perturbed-normal's screen-space variance to kill normal-map specular shimmer (three's own geometryRoughness derives from the non-perturbed normal and misses it); the σ²/κ constants are export contract, applied only to Device's private material clones, never the shared drei glTF cache that DeviceMockup/HeroObject also read. */
export const GSAA_FRAGMENT = /* glsl */ `#include <lights_physical_fragment>
{
	vec3 gsaaDx = dFdx( normal );
	vec3 gsaaDy = dFdy( normal );
	float gsaaVariance = 0.25 * ( dot( gsaaDx, gsaaDx ) + dot( gsaaDy, gsaaDy ) );
	float gsaaKernel = min( gsaaVariance, 0.18 );
	material.roughness = min( sqrt( material.roughness * material.roughness + gsaaKernel ), 1.0 );
}`;
