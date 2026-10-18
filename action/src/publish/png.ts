/**
 * Is this image from someone else's report a PNG a browser can show?
 *
 * Only the header is read (PNG spec 5.2, 11.2.2): the 8-byte signature and
 * the IHDR chunk that must come first, for the width and height. Anything
 * else (HTML, SVG, a script renamed .png) is refused, and so is a file
 * claiming dimensions that would make a viewer's browser decode gigabytes of
 * pixels: a PNG of one colour compresses to almost nothing at any size.
 */

export const PNG_LIMITS = {
  /** Longest side, in pixels: a 20 000 px tall page at device scale factor 2 is 40 000. */
  maxSide: 100_000,
  /** Width × height: 250 megapixels is about 1 GB to decode. */
  maxPixels: 250_000_000,
} as const;

export type PngCheck = { ok: true; width: number; height: number } | { ok: false; reason: string };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

export function checkPng(bytes: Uint8Array): PngCheck {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return { ok: false, reason: 'not a PNG' };
  }
  // Chunk: length (4), type (4), data, CRC (4). IHDR data is 13 bytes.
  if (bytes.length < 8 + 8 + 13) return { ok: false, reason: 'not a PNG (no IHDR header)' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || IHDR.some((b, i) => bytes[12 + i] !== b)) {
    return { ok: false, reason: 'not a PNG (no IHDR header)' };
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const size = `a PNG of ${width}×${height} pixels`;
  if (width === 0 || height === 0) return { ok: false, reason: size };
  if (width > PNG_LIMITS.maxSide || height > PNG_LIMITS.maxSide) {
    return { ok: false, reason: `${size}, over the ${PNG_LIMITS.maxSide}-pixel limit for a side` };
  }
  if (width * height > PNG_LIMITS.maxPixels) {
    return { ok: false, reason: `${size}, over the ${PNG_LIMITS.maxPixels / 1_000_000}-megapixel limit` };
  }
  return { ok: true, width, height };
}
