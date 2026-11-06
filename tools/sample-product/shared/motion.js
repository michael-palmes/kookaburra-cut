// Pure functions of the frame time in ms: pages never read the wall clock.

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, p) => a + (b - a) * p;

export const seg = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur));

export const ease = {
  linear: (p) => p,
  out: (p) => 1 - (1 - p) ** 3,
  outQuint: (p) => 1 - (1 - p) ** 5,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  outBack: (p) => {
    const c = 1.4;
    return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
  },
  spring: (p) => 1 - Math.exp(-6.5 * p) * Math.cos(7.2 * p),
};

export const tween = (t, start, dur, from, to, fn = ease.out) =>
  lerp(from, to, fn(seg(t, start, dur)));

export function typed(text, t, start, cps = 16) {
  if (t < start) return "";
  return text.slice(0, Math.min(text.length, Math.floor(((t - start) / 1000) * cps) + 1));
}

export const typedEnd = (text, start, cps = 16) => start + ((text.length - 1) / cps) * 1000;

export const caretOn = (t, idleFrom = 0) =>
  t < idleFrom || Math.floor((t - idleFrom) / 530) % 2 === 0;

function hex(c) {
  const n = Number.parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a, b, p) {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const q = clamp(p);
  return `rgb(${Math.round(lerp(r1, r2, q))}, ${Math.round(lerp(g1, g2, q))}, ${Math.round(lerp(b1, b2, q))})`;
}

export function rise(el, t, start, { dur = 520, dy = 18, scale = 1 } = {}) {
  const p = ease.outQuint(seg(t, start, dur));
  el.style.opacity = String(clamp(p * 1.4));
  el.style.transform = `translateY(${(1 - p) * dy}px) scale(${lerp(scale, 1, p)})`;
}

export function path(t, start, dur, points, fn = ease.inOut) {
  const p = fn(seg(t, start, dur));
  const [a, b, c] = points;
  const u = 1 - p;
  return [
    u * u * a[0] + 2 * u * p * b[0] + p * p * c[0],
    u * u * a[1] + 2 * u * p * b[1] + p * p * c[1],
  ];
}

export function press(t, at, dur = 220) {
  const p = seg(t, at, dur);
  return p <= 0 || p >= 1 ? 1 : 1 - 0.06 * Math.sin(p * Math.PI);
}

export function ripple(el, t, at, { size = 64, colour = "rgba(240,108,91,0.45)" } = {}) {
  const p = seg(t, at, 560);
  const on = t >= at && p < 1;
  el.style.display = on ? "block" : "none";
  if (!on) return;
  const s = lerp(0.3, 1, ease.out(p));
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.marginLeft = `${-size / 2}px`;
  el.style.marginTop = `${-size / 2}px`;
  el.style.transform = `scale(${s})`;
  el.style.background = colour;
  el.style.opacity = String(1 - ease.out(p));
}

export function params() {
  return Object.fromEntries(new URLSearchParams(location.search));
}

export function ready() {
  const images = [...document.images].map((img) => img.decode().catch(() => {}));
  const faces = [...document.fonts].map((f) => f.load().catch(() => {}));
  return Promise.all([...faces, ...images])
    .then(() => document.fonts.ready)
    .then(() => true);
}
