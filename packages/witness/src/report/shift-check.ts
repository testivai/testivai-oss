/**
 * Shift confirmation: is a claimed shift the same content, moved?
 *
 * Element maps pair baseline and candidate elements by path, and call a pair
 * with the same size and styles at another position a pure move. Content
 * inserted above an element renumbers its `:nth-of-type` path, so the path
 * can pair it with a look-alike neighbour: two order cards of the same size
 * and styles, with different text. That pair read as a shift by a wrong
 * distance (−16 px while the content moved +64 px, measured on a
 * react-native-web page), and a wrong page shift.
 *
 * The pixels tell them apart. The same content, moved, matches at its new
 * position: in real Chrome, true shifts differed on 0.00% of their pixels,
 * fractional moves included, and look-alike neighbours on 4.8–6.7%.
 * A shift is confirmed when at most SHIFT_PIXEL_TOLERANCE of the element's
 * pixels differ, at the best of the pair's offset ±1 px (the rects are
 * rounded independently of where the browser drew the content).
 */

import type { RgbaImage } from './thumbnail';

export interface ShiftBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Share of an element's compared pixels that may differ for its move to count as a shift. */
export const SHIFT_PIXEL_TOLERANCE = 0.01;

/** Pixels compared per element at most; larger elements are sampled on a grid. */
const MAX_SAMPLES = 40_000;

const OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * A checker over one compared pair of images: `check(baselineRect,
 * candidateRect)` is true when the candidate rect shows the baseline rect's
 * content. Pixels under a mask, or outside either image, are not compared;
 * with nothing comparable there is no evidence against the map, and the
 * claim stands. Answers are cached per pair of rects.
 *
 * @param threshold per-pixel colour threshold, the same YIQ metric and value
 *   as the pixel diff (0–1)
 * @param masks areas excluded from the diff, in image coordinates
 */
export function makeShiftCheck(
  baseline: RgbaImage,
  current: RgbaImage,
  threshold: number,
  masks: readonly ShiftBox[] = [],
): (baselineRect: ShiftBox, candidateRect: ShiftBox) => boolean {
  const deltaThreshold = threshold * threshold * 35215;
  const cache = new Map<string, boolean>();
  const masked = (x: number, y: number) =>
    masks.some((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);

  const differs = (bi: number, ci: number): boolean => {
    const b = baseline.data;
    const c = current.data;
    const dr = c[ci] - b[bi];
    const dg = c[ci + 1] - b[bi + 1];
    const db = c[ci + 2] - b[bi + 2];
    if (dr === 0 && dg === 0 && db === 0) return false;
    const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
    const i = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
    const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
    return y * y * 0.5053 + i * i * 0.299 + q * q * 0.1957 > deltaThreshold;
  };

  return (b, c) => {
    const key = `${b.x},${b.y},${b.width},${b.height}|${c.x},${c.y},${c.width},${c.height}`;
    const known = cache.get(key);
    if (known !== undefined) return known;

    const width = Math.min(b.width, c.width);
    const height = Math.min(b.height, c.height);
    const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
    let comparedAny = false;
    let confirmed = false;

    for (const [ox, oy] of OFFSETS) {
      let compared = 0;
      let different = 0;
      for (let y = 0; y < height; y += step) {
        const by = b.y + y;
        const cy = c.y + y + oy;
        if (by < 0 || by >= baseline.height || cy < 0 || cy >= current.height) continue;
        for (let x = 0; x < width; x += step) {
          const bx = b.x + x;
          const cx = c.x + x + ox;
          if (bx < 0 || bx >= baseline.width || cx < 0 || cx >= current.width) continue;
          if (masks.length > 0 && (masked(bx, by) || masked(cx, cy))) continue;
          compared++;
          if (differs((by * baseline.width + bx) * 4, (cy * current.width + cx) * 4)) different++;
        }
      }
      if (compared === 0) continue;
      comparedAny = true;
      if (different / compared <= SHIFT_PIXEL_TOLERANCE) {
        confirmed = true;
        break;
      }
    }

    const answer = confirmed || !comparedAny;
    cache.set(key, answer);
    return answer;
  };
}
