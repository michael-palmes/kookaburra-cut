import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SAFE_INSET = 0.06;
const ASPECTS = [
  { name: "16:9", ratio: 16 / 9 },
  { name: "9:16", ratio: 9 / 16 },
  { name: "1:1", ratio: 1 },
  { name: "4:5", ratio: 4 / 5 },
];
const STATIC_BACKGROUNDS = [
  {
    themePath: "src/theme/builtin/kookaburra-linen-intelligence.json",
    assetPath: "src/assets/backdrops/linen-intelligence.png",
  },
  {
    themePath: "src/theme/builtin/kookaburra-velvet-physics.json",
    assetPath: "src/assets/backdrops/velvet-physics.png",
  },
];

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(path) {
  const bytes = readFileSync(path);
  assert.deepEqual(
    bytes.subarray(0, PNG_SIGNATURE.length),
    PNG_SIGNATURE,
    `${path}: invalid PNG signature`,
  );

  let offset = PNG_SIGNATURE.length;
  let header;
  const dataChunks = [];
  let ended = false;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, `${path}: truncated PNG chunk header`);
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= bytes.length, `${path}: truncated ${type} chunk`);
    const chunk = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      assert.equal(length, 13, `${path}: IHDR must be 13 bytes`);
      assert.equal(header, undefined, `${path}: duplicate IHDR chunk`);
      header = {
        width: chunk.readUInt32BE(0),
        height: chunk.readUInt32BE(4),
        bitDepth: chunk[8],
        colourType: chunk[9],
        compression: chunk[10],
        filter: chunk[11],
        interlace: chunk[12],
      };
    } else if (type === "IDAT") {
      dataChunks.push(chunk);
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = dataEnd + 4;
  }

  assert.ok(header, `${path}: missing IHDR chunk`);
  assert.ok(ended, `${path}: missing IEND chunk`);
  assert.ok(dataChunks.length > 0, `${path}: missing IDAT data`);
  assert.equal(
    header.bitDepth,
    8,
    `${path}: unsupported PNG bit depth ${header.bitDepth}, expected 8`,
  );
  assert.ok(
    header.colourType === 2 || header.colourType === 6,
    `${path}: unsupported PNG colour type ${header.colourType}, expected RGB (2) or RGBA (6)`,
  );
  assert.equal(
    header.compression,
    0,
    `${path}: unsupported PNG compression method ${header.compression}`,
  );
  assert.equal(header.filter, 0, `${path}: unsupported PNG filter method ${header.filter}`);
  assert.equal(header.interlace, 0, `${path}: unsupported interlaced PNG`);

  const channels = header.colourType === 2 ? 3 : 4;
  const stride = header.width * channels;
  const inflated = inflateSync(Buffer.concat(dataChunks));
  const expectedLength = header.height * (stride + 1);
  assert.equal(
    inflated.length,
    expectedLength,
    `${path}: decoded data is ${inflated.length} bytes, expected ${expectedLength}`,
  );

  const pixels = Buffer.allocUnsafe(header.height * stride);
  for (let y = 0; y < header.height; y++) {
    const sourceRow = y * (stride + 1);
    const targetRow = y * stride;
    const filterType = inflated[sourceRow];
    assert.ok(filterType <= 4, `${path}: unsupported PNG row filter ${filterType} at row ${y}`);
    for (let x = 0; x < stride; x++) {
      const encoded = inflated[sourceRow + 1 + x];
      const left = x >= channels ? pixels[targetRow + x - channels] : 0;
      const above = y > 0 ? pixels[targetRow + x - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[targetRow + x - stride - channels] : 0;
      let value = encoded;
      if (filterType === 1) value += left;
      if (filterType === 2) value += above;
      if (filterType === 3) value += Math.floor((left + above) / 2);
      if (filterType === 4) value += paeth(left, above, upperLeft);
      pixels[targetRow + x] = value & 255;
    }
  }

  return { ...header, channels, pixels };
}

function hexLuminance(hex, label) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${label}: expected a six-digit hex colour`);
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * SRGB_TO_LINEAR[(value >> 16) & 255] +
    0.7152 * SRGB_TO_LINEAR[(value >> 8) & 255] +
    0.0722 * SRGB_TO_LINEAR[value & 255]
  );
}

function pixelLuminance(image, offset, underlay) {
  const luminance =
    0.2126 * SRGB_TO_LINEAR[image.pixels[offset]] +
    0.7152 * SRGB_TO_LINEAR[image.pixels[offset + 1]] +
    0.0722 * SRGB_TO_LINEAR[image.pixels[offset + 2]];
  if (image.channels === 3) return luminance;
  const alpha = image.pixels[offset + 3] / 255;
  return alpha * luminance + (1 - alpha) * underlay;
}

function contrast(first, second) {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function safeCoverRegion(image, aspect) {
  const imageAspect = image.width / image.height;
  let width = image.width;
  let height = image.height;
  let x = 0;
  let y = 0;
  if (imageAspect > aspect) {
    width = Math.round(image.height * aspect);
    x = Math.floor((image.width - width) / 2);
  } else if (imageAspect < aspect) {
    height = Math.round(image.width / aspect);
    y = Math.floor((image.height - height) / 2);
  }
  const inset = Math.floor(SAFE_INSET * Math.min(width, height));
  return {
    x: x + inset,
    y: y + inset,
    width: width - inset * 2,
    height: height - inset * 2,
  };
}

function assertThemeContrast(theme, image, assetPath) {
  assert.ok(Array.isArray(theme.chartColors), `${theme.id}: chartColors must be an array`);
  assert.equal(theme.chartColors.length, 6, `${theme.id}: expected six chart swatches`);
  const roles = [
    { name: "primary text", colour: theme.colors.text, threshold: 4.5 },
    { name: "muted text", colour: theme.colors.muted, threshold: 4.5 },
    ...theme.chartColors.map((colour, index) => ({
      name: `chart swatch ${index + 1}`,
      colour,
      threshold: 3,
    })),
  ].map((role) => ({ ...role, luminance: hexLuminance(role.colour, `${theme.id} ${role.name}`) }));
  const underlay = hexLuminance(theme.colors.background, `${theme.id} background`);

  for (const aspect of ASPECTS) {
    const region = safeCoverRegion(image, aspect.ratio);
    assert.ok(
      region.width > 0 && region.height > 0,
      `${assetPath}: empty ${aspect.name} safe region`,
    );
    const minima = roles.map(() => ({ ratio: Number.POSITIVE_INFINITY, x: -1, y: -1 }));
    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) {
        const offset = (y * image.width + x) * image.channels;
        const background = pixelLuminance(image, offset, underlay);
        for (let index = 0; index < roles.length; index++) {
          const ratio = contrast(roles[index].luminance, background);
          if (ratio < minima[index].ratio) minima[index] = { ratio, x, y };
        }
      }
    }
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index];
      const minimum = minima[index];
      assert.ok(
        minimum.ratio >= role.threshold,
        `${theme.id} ${aspect.name} ${role.name} ${role.colour}: ${minimum.ratio.toFixed(3)} at source pixel (${minimum.x}, ${minimum.y}), expected at least ${role.threshold.toFixed(1)}`,
      );
    }
  }
}

for (const { themePath, assetPath } of STATIC_BACKGROUNDS) {
  test(`${assetPath} is an exact 2048px square PNG`, () => {
    const image = decodePng(assetPath);
    assert.equal(image.width, 2048);
    assert.equal(image.height, 2048);
  });

  test(`${themePath} preserves text and chart contrast on its static backdrop`, () => {
    const theme = JSON.parse(readFileSync(themePath, "utf8"));
    assert.equal(theme.background?.type, "image", `${themePath}: expected an image background`);
    assert.equal(
      theme.background.src,
      `kookaburra:${assetPath.slice(assetPath.lastIndexOf("/") + 1, -4)}`,
      `${themePath}: background source does not match its pinned asset`,
    );
    assertThemeContrast(theme, decodePng(assetPath), assetPath);
  });
}
