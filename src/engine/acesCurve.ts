/** ACES forward/inverse pair (self-inverting) for the compositor's HDR transition blend: mixes in the perceptual display domain then inverts back to linear HDR so transition endpoints match the composer's own tone-mapped output; clamp encoded values to <= 0.999 before inverting since the fit saturates at the top end. */

/** GLSL: acesForward(vec3 linear HDR) → saturated display-linear, exposure 1. */
export const ACES_FORWARD_GLSL = /* glsl */ `
  vec3 acesRRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 acesForward(vec3 color) {
    const mat3 ACESInputMat = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777)
    );
    const mat3 ACESOutputMat = mat3(
      vec3(1.60475, -0.10208, -0.00327),
      vec3(-0.53108, 1.10813, -0.07276),
      vec3(-0.07367, -0.00605, 1.07602)
    );
    color /= 0.6;
    color = ACESOutputMat * acesRRTAndODTFit(ACESInputMat * color);
    return clamp(color, 0.0, 1.0);
  }
`;

/** GLSL: acesInverse(vec3 display-linear in [0, 1)) → linear HDR. */
export const ACES_INVERSE_GLSL = /* glsl */ `
  vec3 acesRRTAndODTFitInv(vec3 y) {
    vec3 a = 0.983729 * y - 1.0;
    vec3 b = 0.4329510 * y - 0.0245786;
    vec3 c = 0.238081 * y + 0.000090537;
    return (-b - sqrt(b * b - 4.0 * a * c)) / (2.0 * a);
  }
  vec3 acesInverse(vec3 color) {
    const mat3 ACESInputMatInv = mat3(
      vec3(1.764740972, -0.147027852, -0.036336830),
      vec3(-0.675777678, 1.160251512, -0.162436437),
      vec3(-0.088963294, -0.013223660, 1.198773267)
    );
    const mat3 ACESOutputMatInv = mat3(
      vec3(0.643038249, 0.059268690, 0.005961901),
      vec3(0.311186752, 0.931436487, 0.063929016),
      vec3(0.045775457, 0.009294916, 0.930118384)
    );
    return (ACESInputMatInv * acesRRTAndODTFitInv(ACESOutputMatInv * color)) * 0.6;
  }
`;

type Vec3 = [number, number, number];

const M_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const M_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];
const M_IN_INV = [
  [1.764740972, -0.675777678, -0.088963294],
  [-0.147027852, 1.160251512, -0.01322366],
  [-0.03633683, -0.162436437, 1.198773267],
];
const M_OUT_INV = [
  [0.643038249, 0.311186752, 0.045775457],
  [0.05926869, 0.931436487, 0.009294916],
  [0.005961901, 0.063929016, 0.930118384],
];

function mul(m: number[][], v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** CPU mirror of acesForward (tests only). */
export function acesForwardCpu(v: Vec3): Vec3 {
  const scaled = mul(M_IN, [v[0] / 0.6, v[1] / 0.6, v[2] / 0.6]);
  const fit = scaled.map(
    (x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081),
  ) as Vec3;
  return mul(M_OUT, fit).map((x) => Math.min(1, Math.max(0, x))) as Vec3;
}

/** CPU mirror of acesInverse (tests only). */
export function acesInverseCpu(v: Vec3): Vec3 {
  const fitInv = mul(M_OUT_INV, v).map((y) => {
    const a = 0.983729 * y - 1.0;
    const b = 0.432951 * y - 0.0245786;
    const c = 0.238081 * y + 0.000090537;
    return (-b - Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }) as Vec3;
  return mul(M_IN_INV, fitInv).map((x) => x * 0.6) as Vec3;
}
