/**
 * TestivAI Report — the thumbnail of a changed snapshot (thumb.png)
 *
 * A full-page diff is too tall to show inline where space is short (a pull
 * request comment scales it to the column's width, and the change becomes a
 * thin band). The thumbnail crops the changed area instead and puts the
 * baseline, the current capture and the diff of it side by side:
 *
 *   baseline | current | diff     (2 px apart, at most 800×400 px)
 *
 * The area is on the diff canvas, which is the larger of the two sizes when
 * they differ (witness pads both, anchored at the top left), so it is the
 * same place in all three images; rows or columns a capture does not have
 * are drawn as padding. Each panel is the area downscaled by area average,
 * never upscaled. Plain RGBA arithmetic: no dependency beyond pngjs, which
 * the caller encodes with.
 */

/** The bounds of a thumbnail. docs/extension-api.md quotes them. */
export const THUMBNAIL_LIMITS = {
  /** The widest strip, the three panels and both separators together. */
  maxWidth: 800,
  /** The tallest strip. */
  maxHeight: 400,
  /** Pixels of context around the changed regions, on every side. */
  padding: 24,
  /** How many of the largest regions (by area) the area covers. */
  regions: 3,
  /** Rows in the band shown when the diff has no regions. */
  bandHeight: 400,
  /** Pixels between two panels. */
  separator: 2,
} as const;

/** What a panel shows where its capture has no pixel (the padded part of the canvas). */
export const THUMBNAIL_PADDING_RGBA: readonly [number, number, number, number] = [175, 184, 193, 255];

/** The line between two panels. */
const SEPARATOR_RGBA: readonly [number, number, number, number] = [87, 96, 106, 255];

export interface ThumbnailBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Decoded RGBA pixels, 4 bytes a pixel, row by row. */
export interface RgbaImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * The area of the diff canvas the thumbnail shows: the union of the up to
 * three largest regions by area, padded and kept inside the canvas. Without
 * a region (none detected, or none inside the canvas), a full-width band of
 * 400 rows from the first row with a differing pixel, moved up when the
 * canvas ends sooner so it keeps its height. Null when no pixel of the diff
 * differs.
 *
 * @param regions The snapshot's `regions`, on the diff canvas.
 * @param diff    The diff image (the canvas): differing pixels are heat
 *                (yellow to red); the rest is a grey wash of the baseline,
 *                and masked areas are grey hatching.
 */
export function thumbnailArea(regions: readonly ThumbnailBox[] | undefined, diff: RgbaImage): ThumbnailBox | null {
  const canvas = { x: 0, y: 0, width: diff.width, height: diff.height };
  const inside = (regions ?? [])
    .map((r) => intersect(r, canvas))
    .filter((r): r is ThumbnailBox => r !== null)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, THUMBNAIL_LIMITS.regions);
  if (inside.length > 0) {
    const p = THUMBNAIL_LIMITS.padding;
    const box = inside.reduce(union);
    return intersect({ x: box.x - p, y: box.y - p, width: box.width + 2 * p, height: box.height + 2 * p }, canvas);
  }
  const first = firstDifferingRow(diff);
  if (first === null) return null;
  const height = Math.min(THUMBNAIL_LIMITS.bandHeight, diff.height);
  return { x: 0, y: Math.min(first, diff.height - height), width: diff.width, height };
}

/**
 * The strip for `area`: baseline | current | diff, each panel the area
 * downscaled by area average to fit the strip in 800×400 px (never
 * upscaled), 2 px apart. `baseline` and `current` keep their own sizes:
 * where the canvas is larger than a capture, its panel shows padding.
 */
export function renderThumbnail(
  images: { baseline: RgbaImage; current: RgbaImage; diff: RgbaImage },
  area: ThumbnailBox,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { maxWidth, maxHeight, separator } = THUMBNAIL_LIMITS;
  const scale = Math.min(1, (maxWidth - 2 * separator) / (3 * area.width), maxHeight / area.height);
  const panelWidth = Math.max(1, Math.round(area.width * scale));
  const panelHeight = Math.max(1, Math.round(area.height * scale));
  const width = 3 * panelWidth + 2 * separator;
  const out = new Uint8ClampedArray(width * panelHeight * 4);

  // Output column (row) i averages source columns (rows) [start(i), start(i + 1)):
  // a partition of the area, since a panel is never larger than the area.
  const starts = (size: number, n: number) => Int32Array.from({ length: n + 1 }, (_, i) => Math.floor((i * size) / n));
  const colStart = starts(area.width, panelWidth);
  const rowStart = starts(area.height, panelHeight);
  const columnOf = new Int32Array(area.width);
  for (let c = 0; c < panelWidth; c++) columnOf.fill(c, colStart[c], colStart[c + 1]);
  const sums = new Float64Array(panelWidth * 4);
  const pad = THUMBNAIL_PADDING_RGBA;

  [images.baseline, images.current, images.diff].forEach((image, panel) => {
    const left = panel * (panelWidth + separator);
    // Columns of the area this capture has; the rest is padding.
    const inWidth = Math.max(0, Math.min(area.width, image.width - area.x));
    for (let oy = 0; oy < panelHeight; oy++) {
      sums.fill(0);
      // One pass over the source rows, adding each pixel to its output column.
      for (let y = area.y + rowStart[oy]; y < area.y + rowStart[oy + 1]; y++) {
        const hasRow = y < image.height;
        const rowOffset = (y * image.width + area.x) * 4;
        for (let xi = 0; xi < area.width; xi++) {
          const s = columnOf[xi] * 4;
          if (hasRow && xi < inWidth) {
            const i = rowOffset + xi * 4;
            sums[s] += image.data[i];
            sums[s + 1] += image.data[i + 1];
            sums[s + 2] += image.data[i + 2];
            sums[s + 3] += image.data[i + 3];
          } else {
            sums[s] += pad[0];
            sums[s + 1] += pad[1];
            sums[s + 2] += pad[2];
            sums[s + 3] += pad[3];
          }
        }
      }
      const rowsHere = rowStart[oy + 1] - rowStart[oy];
      for (let ox = 0; ox < panelWidth; ox++) {
        const n = rowsHere * (colStart[ox + 1] - colStart[ox]);
        const o = (oy * width + left + ox) * 4;
        for (let ch = 0; ch < 4; ch++) out[o + ch] = Math.round(sums[ox * 4 + ch] / n);
      }
    }
  });

  for (const left of [panelWidth, 2 * panelWidth + separator]) {
    for (let y = 0; y < panelHeight; y++) {
      for (let x = left; x < left + separator; x++) out.set(SEPARATOR_RGBA, (y * width + x) * 4);
    }
  }
  return { data: out, width, height: panelHeight };
}

/** The first row with a heat pixel: the diff paints unchanged pixels grey (r = g = b), changed ones yellow to red. */
function firstDifferingRow(diff: RgbaImage): number | null {
  const { data, width, height } = diff;
  for (let y = 0; y < height; y++) {
    for (let i = y * width * 4, end = i + width * 4; i < end; i += 4) {
      if (data[i + 3] !== 0 && (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2])) return y;
    }
  }
  return null;
}

/** The overlap of two boxes in whole pixels (a fractional edge takes the pixel it touches), or null when they share none. */
function intersect(a: ThumbnailBox, b: ThumbnailBox): ThumbnailBox | null {
  if (![a.x, a.y, a.width, a.height].every(Number.isFinite)) return null;
  const x = Math.max(Math.floor(a.x), b.x);
  const y = Math.max(Math.floor(a.y), b.y);
  const right = Math.min(Math.ceil(a.x + a.width), b.x + b.width);
  const bottom = Math.min(Math.ceil(a.y + a.height), b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function union(a: ThumbnailBox, b: ThumbnailBox): ThumbnailBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
