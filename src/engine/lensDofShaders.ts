/** GLSL for LensDofEffect (dof mode "lens"). Five passes: a half-res prefilter (colour + signed CoC from depth), a tile max and dilation of the near CoC, a scatter-as-gather on a Vogel disc whose taps read the mip matching their share of the disc, a CoC-aware tent, then a full-res composite that keeps in-focus pixels exactly as rendered and blurs small discs at full resolution. Signed CoC is in pixels: negative in front of focus, positive behind, so it doubles as a depth order. LENS_DISPLAY marks display-referred input (the dof-only lane): decoded to linear and highlight-expanded before the blur, compressed and re-encoded after. Every input is a pure function of the frame (no time, no history). See docs/camera.md. */

export const lensVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const displayDecode = /* glsl */ `
  vec3 lensExpand(vec3 c) {
  #ifdef LENS_DISPLAY
    c = mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
    return c / (1.0 - min(max(c.r, max(c.g, c.b)), 0.96));
  #else
    return c;
  #endif
  }
`;

export const lensPrefilterShader = /* glsl */ `
  #include <packing>
  uniform highp sampler2D inputBuffer;
  uniform highp sampler2D depthBuffer;
  uniform vec2 fullTexel;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float focus;
  uniform float cocInf;
  uniform float cocMax;
  varying vec2 vUv;
  ${displayDecode}

  float readDepth(const in vec2 uv) {
  #if DEPTH_PACKING == 3201
    return unpackRGBAToDepth(texture2D(depthBuffer, uv));
  #else
    return texture2D(depthBuffer, uv).r;
  #endif
  }

  float cocAt(const in vec2 uv) {
    float d = max(-perspectiveDepthToViewZ(readDepth(uv), cameraNear, cameraFar), 1e-4);
    return clamp(cocInf * (1.0 - focus / d), -cocMax, cocMax);
  }

  vec3 colourAt(const in vec2 uv) {
    vec3 c = lensExpand(max(texture2D(inputBuffer, uv).rgb, vec3(0.0)));
    // Half-float ceiling; a NaN never survives min().
    return min(c, vec3(60000.0));
  }

  void main() {
    vec2 o = 0.5 * fullTexel;
    vec2 a = vUv + vec2(-o.x, -o.y);
    vec2 b = vUv + vec2(o.x, -o.y);
    vec2 c = vUv + vec2(-o.x, o.y);
    vec2 d = vUv + vec2(o.x, o.y);
    vec3 colour = 0.25 * (colourAt(a) + colourAt(b) + colourAt(c) + colourAt(d));
    // The nearest of the four: silhouettes keep their own CoC rather than averaging into the background.
    float coc = min(min(cocAt(a), cocAt(b)), min(cocAt(c), cocAt(d)));
    gl_FragColor = vec4(colour, coc);
  }
`;

export const lensTileShader = /* glsl */ `
  uniform highp sampler2D cocBuffer;
  uniform vec2 halfSize;
  uniform float tileSize;
  void main() {
    ivec2 limit = ivec2(halfSize) - 1;
    int t = int(tileSize);
    ivec2 base = ivec2(gl_FragCoord.xy) * t;
    float nearMax = 0.0;
    for (int y = 0; y < t; y++) {
      for (int x = 0; x < t; x++) {
        nearMax = max(nearMax, -texelFetch(cocBuffer, min(base + ivec2(x, y), limit), 0).a);
      }
    }
    gl_FragColor = vec4(nearMax, 0.0, 0.0, 1.0);
  }
`;

export const lensDilateShader = /* glsl */ `
  uniform highp sampler2D tileBuffer;
  uniform vec2 tileCount;
  void main() {
    ivec2 limit = ivec2(tileCount) - 1;
    ivec2 p = ivec2(gl_FragCoord.xy);
    float nearMax = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        nearMax = max(nearMax, texelFetch(tileBuffer, clamp(p + ivec2(x, y), ivec2(0), limit), 0).r);
      }
    }
    gl_FragColor = vec4(nearMax, 0.0, 0.0, 1.0);
  }
`;

/** A tap's weight at distance r from the centre: the gather's reach rule, shared with the composite's full-res blur. `gap` is one half-res pixel of CoC in the caller's units. */
const lensCoverage = /* glsl */ `
  float lensCover(const in float s, const in float c, const in float gap, const in float r, const in float ramp) {
    float reach = s < c - gap ? abs(s) : min(abs(s), 2.0 * abs(c));
    return clamp((reach - r) / ramp + 0.5, 0.0, 1.0);
  }
`;

/** Each tap reaches the centre when its own CoC covers the distance. Taps behind the centre may reach no further than twice the centre's CoC, so a blurred background never smears over a sharp subject; taps in front blend over it by their disc coverage, so a blurred foreground does. */
export const lensGatherShader = /* glsl */ `
  uniform highp sampler2D cocBuffer;
  uniform highp sampler2D tileBuffer;
  uniform vec2 halfSize;
  uniform float tileSize;
  uniform float cocMax;
  uniform float squeezeX;
  uniform float sampleSeed;
  ${lensCoverage}

  // A footprint whose mean CoC strays from its own texel's straddles a depth edge: keep the exact texel there, so an in-focus edge never glows into the blur behind it.
  vec3 lensMipColour(const in vec4 texel, const in vec2 uv, const in float lod) {
    vec4 mip = textureLod(cocBuffer, uv, lod);
    return mix(mip.rgb, texel.rgb, smoothstep(0.25, 1.0, abs(mip.a - texel.a)));
  }

  void main() {
    ivec2 limit = ivec2(halfSize) - 1;
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec4 centre = texelFetch(cocBuffer, ip, 0);
    float cs = centre.a;
    float cSize = abs(cs);
    float nearMax = texelFetch(tileBuffer, ip / int(tileSize), 0).r;
    float radius = min(max(cSize, nearMax), cocMax);
    if (radius < 0.5) {
      gl_FragColor = vec4(centre.rgb, 0.0);
      return;
    }
    int n = int(clamp(ceil(0.785 * radius * radius), 12.0, float(LENS_TAPS)));
    float fn = float(n);
    float ramp = radius * inversesqrt(fn);
    float area = radius * radius / fn;
    // Each tap reads the mip as wide as its share of the disc, so a one-texel mote lands in every tap that covers it instead of flickering between hit and miss.
    float lod = max(0.0, 0.5 * log2(area));
    vec2 halfTexel = 1.0 / halfSize;
    // Interleaved gradient noise, offset per supersample draw: a per-pixel rotation that never ghosts, which the tent and the supersample average smooth.
    float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * sampleSeed, vec2(0.06711056, 0.00583715))));
    vec3 bg = lensMipColour(centre, gl_FragCoord.xy * halfTexel, lod);
    float bgW = 1.0;
    vec3 fg = vec3(0.0);
    float fgW = 0.0;
    float fgA = 0.0;
    for (int i = 0; i < LENS_TAPS; i++) {
      if (i >= n) break;
      float fi = float(i);
      float r = radius * sqrt((fi + 0.5) / fn);
      float th = fi * 2.39996323 + rot;
      vec2 off = vec2(cos(th) * squeezeX, sin(th)) * r;
      vec4 s = texelFetch(cocBuffer, clamp(ivec2(floor(gl_FragCoord.xy + off)), ivec2(0), limit), 0);
      s.rgb = lensMipColour(s, (gl_FragCoord.xy + off) * halfTexel, lod);
      float sSize = abs(s.a);
      bool front = s.a < cs - 1.0;
      float m = lensCover(s.a, cs, 1.0, r, ramp);
      if (front) {
        fg += s.rgb * m;
        fgW += m;
        fgA += m * area / max(sSize * sSize, area);
      } else {
        bg += s.rgb * m;
        bgW += m;
      }
    }
    float alpha = fgW > 0.0 ? clamp(fgA, 0.0, 1.0) : 0.0;
    gl_FragColor = vec4(mix(bg / bgW, fg / max(fgW, 1e-4), alpha), alpha);
  }
`;

export const lensTentShader = /* glsl */ `
  uniform highp sampler2D gatherBuffer;
  uniform highp sampler2D cocBuffer;
  uniform vec2 halfSize;
  void main() {
    ivec2 limit = ivec2(halfSize) - 1;
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec4 centre = texelFetch(gatherBuffer, ip, 0);
    float cc = texelFetch(cocBuffer, ip, 0).a;
    if (centre.a <= 0.0 && abs(cc) < 0.5) {
      gl_FragColor = centre;
      return;
    }
    vec4 sum = vec4(0.0);
    float wSum = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ivec2 p = clamp(ip + ivec2(x, y), ivec2(0), limit);
        float w = (2.0 - abs(float(x))) * (2.0 - abs(float(y))) / (1.0 + abs(texelFetch(cocBuffer, p, 0).a - cc));
        sum += texelFetch(gatherBuffer, p, 0) * w;
        wSum += w;
      }
    }
    gl_FragColor = sum / wSum;
  }
`;

/** The composite (the effect's own mainImage): pixels whose full-res CoC is under half a pixel, with no foreground over them, stay exactly as rendered. Discs under LENS_NEAR_COC come from a full-res blur whose taps follow the gather's reach rule, so a small highlight never turns into half-res blocks and a sharp silhouette never bleeds into the blur behind it. */
export const lensCompositeShader = /* glsl */ `
  uniform highp sampler2D lensBlurBuffer;
  uniform highp sampler2D lensCocBuffer;
  uniform vec2 lensHalfSize;
  uniform float lensFocus;
  uniform float lensCocInf;
  uniform float lensCocMax;
  uniform float lensHalfScale;
  uniform float lensSqueezeX;
  uniform bool lensActive;
  ${displayDecode}
  ${lensCoverage}

  vec3 lensCompress(vec3 c) {
  #ifdef LENS_DISPLAY
    c = c / (1.0 + max(c.r, max(c.g, c.b)));
    return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  #else
    return c;
  #endif
  }

  float lensCoc(const in float depth) {
    float d = max(-getViewZ(depth), 1e-4);
    return clamp(lensCocInf * (1.0 - lensFocus / d), -lensCocMax, lensCocMax);
  }

  vec3 lensLinear(const in vec3 c) {
    return min(lensExpand(max(c, vec3(0.0))), vec3(60000.0));
  }

  vec3 lensNearBlur(const in vec3 centre, const in vec2 uv, const in float coc) {
    float ac = abs(coc);
    float fn = float(LENS_NEAR_TAPS);
    float ramp = ac * inversesqrt(fn);
    float gap = 1.0 / lensHalfScale;
    vec3 sum = lensLinear(centre);
    float wSum = 1.0;
    for (int i = 0; i < LENS_NEAR_TAPS; i++) {
      float fi = float(i);
      float r = ac * sqrt((fi + 0.5) / fn);
      float th = fi * 2.39996323;
      vec2 tuv = uv + vec2(cos(th) * lensSqueezeX, sin(th)) * r * texelSize;
      float m = lensCover(lensCoc(readDepth(tuv)), coc, gap, r, ramp);
      sum += lensLinear(textureLod(inputBuffer, tuv, 0.0).rgb) * m;
      wSum += m;
    }
    return sum / wSum;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    if (!lensActive) {
      outputColor = inputColor;
      return;
    }
    float coc = lensCoc(depth);
    ivec2 limit = ivec2(lensHalfSize) - 1;
    vec2 hp = uv * lensHalfSize - 0.5;
    vec2 f = fract(hp);
    ivec2 i0 = ivec2(floor(hp));
    vec4 acc = vec4(0.0);
    float wSum = 0.0;
    for (int j = 0; j < 4; j++) {
      ivec2 o = ivec2(j - 2 * (j / 2), j / 2);
      ivec2 p = clamp(i0 + o, ivec2(0), limit);
      vec2 bw = mix(1.0 - f, f, vec2(o));
      float halfCoc = texelFetch(lensCocBuffer, p, 0).a / lensHalfScale;
      // Bilateral: a half-res texel across a silhouette from this pixel barely counts.
      float w = bw.x * bw.y / (1.0 + abs(halfCoc - coc)) + 1e-5;
      acc += texelFetch(lensBlurBuffer, p, 0) * w;
      wSum += w;
    }
    vec4 blurred = acc / wSum;
    float ac = abs(coc);
    // A foreground over the pixel always takes the gather.
    float far = max(smoothstep(LENS_NEAR_FADE, LENS_NEAR_COC, ac), blurred.a);
    vec3 near = inputColor.rgb;
    if (ac >= 0.5 && far < 1.0) {
      near = mix(near, lensCompress(lensNearBlur(inputColor.rgb, uv, coc)), smoothstep(0.5, 1.5, ac));
    }
    outputColor = vec4(mix(near, lensCompress(blurred.rgb), far), inputColor.a);
  }
`;
