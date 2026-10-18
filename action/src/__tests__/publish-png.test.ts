/**
 * Checking that an image from someone else's report is a PNG a browser can
 * show, before it goes on the site.
 *
 * Only the header is read: the 8-byte PNG signature and the IHDR chunk that
 * must follow it, whose width and height must be sane. A file that is
 * anything else (HTML, SVG, a script renamed .png) is refused, and so is a
 * small file claiming huge dimensions, which would make a viewer's browser
 * try to decode gigabytes of pixels.
 */

import { checkPng, PNG_LIMITS } from '../publish/png';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG header: signature, then an IHDR chunk with these dimensions. */
function png(width: number, height: number, over: { type?: string; length?: number; tail?: number[] } = {}): Uint8Array {
  const bytes = [...SIGNATURE];
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  bytes.push(...u32(over.length ?? 13));
  bytes.push(...[...(over.type ?? 'IHDR')].map((c) => c.charCodeAt(0)));
  bytes.push(...u32(width), ...u32(height), 8, 6, 0, 0, 0); // bit depth 8, RGBA
  bytes.push(0, 0, 0, 0); // CRC (not checked)
  bytes.push(...(over.tail ?? []));
  return new Uint8Array(bytes);
}

describe('checkPng', () => {
  it('accepts a PNG and reads its size', () => {
    expect(checkPng(png(1280, 2400))).toEqual({ ok: true, width: 1280, height: 2400 });
  });

  it('accepts a tall full-page capture at device scale factor 2', () => {
    expect(checkPng(png(2880, 40_000)).ok).toBe(true);
  });

  it.each([
    ['HTML', new TextEncoder().encode('<html><script>alert(1)</script></html>')],
    ['SVG', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['empty', new Uint8Array(0)],
    ['a signature alone', new Uint8Array(SIGNATURE)],
    ['a JPEG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])],
  ])('refuses %s', (_, bytes) => {
    const result = checkPng(bytes);
    expect(result.ok).toBe(false);
  });

  it('refuses a file with one byte of the signature wrong', () => {
    const bytes = png(10, 10);
    bytes[1] = 0x51;
    expect(checkPng(bytes)).toEqual({ ok: false, reason: 'not a PNG' });
  });

  it('refuses a PNG whose first chunk is not IHDR', () => {
    expect(checkPng(png(10, 10, { type: 'IDAT' }))).toEqual({ ok: false, reason: 'not a PNG (no IHDR header)' });
  });

  it('refuses an IHDR chunk of the wrong length', () => {
    expect(checkPng(png(10, 10, { length: 12 })).ok).toBe(false);
  });

  it('refuses a zero width or height', () => {
    expect(checkPng(png(0, 10))).toEqual({ ok: false, reason: 'a PNG of 0×10 pixels' });
    expect(checkPng(png(10, 0)).ok).toBe(false);
  });

  it('refuses a side longer than the limit', () => {
    expect(checkPng(png(10, PNG_LIMITS.maxSide)).ok).toBe(true);
    expect(checkPng(png(10, PNG_LIMITS.maxSide + 1))).toEqual({
      ok: false,
      reason: `a PNG of 10×${PNG_LIMITS.maxSide + 1} pixels, over the ${PNG_LIMITS.maxSide}-pixel limit for a side`,
    });
  });

  it('refuses a small file that claims more pixels than the limit', () => {
    // 20 000 × 20 000 is 400 megapixels: about 1.6 GB to decode.
    const result = checkPng(png(20_000, 20_000));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^a PNG of 20000×20000 pixels, over the \d+-megapixel limit$/) });
  });

  it('reads a width with the top bit set as a large number, not a negative one', () => {
    expect(checkPng(png(0x80000000, 10)).ok).toBe(false);
  });
});
