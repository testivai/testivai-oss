/**
 * TestivAI Report — the shape of a pixel diff
 *
 * When the DOM is identical and the computed styles match, the shape of the
 * pixel diff is the remaining evidence for render noise. Render noise
 * (anti-aliasing, font hinting at glyph edges) is small and scattered: a few
 * isolated pixels below the region noise floor, or edge pixels spread over
 * the text of the whole page. A diff whose regions all sit in one area is
 * something else: a bad capture (a torn or partly blank render, a shifted
 * band, a bad baseline) or a real change the style check does not cover. The
 * style digest covers a fixed list of properties (STYLE_PROPS in
 * capture/element-map.ts), so a change to size, overflow, transform, an
 * image and so on leaves the DOM identical and the styles matching.
 *
 * Computed from fields results.json already has (diffPercent, totalPixels,
 * regions), so results written by older versions read the same way. Shared
 * by noiseAutoPass, the HTML report, @testivai/mcp and the GitHub Action.
 */

/**
 * Render noise stays within this percentage of the page's pixels: the
 * noiseMaxDiffPercent default.
 */
export const NOISE_MAX_DIFF_PERCENT = 1;

/**
 * Regions whose combined bounding box covers at most this share of the page
 * are concentrated in one area. On the real runs in
 * __tests__/fixtures/render-noise-shapes.results.json, local bugs, bad
 * captures and a class-wide change on a one-screen page cover 0.8–18.8% of
 * the page; text-rendering noise covers 37.8% or more.
 */
export const CONCENTRATED_MAX_PAGE_SHARE = 1 / 3;

/** What the style digest leaves out, for verdicts that name it. */
export const STYLE_CHECK_DOES_NOT_COVER =
  'size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets';

export interface DiffShapeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The fields of a snapshot result the shape is read from. */
export interface DiffShapeInput {
  /** Percentage of pixels that differ (0-100). */
  diffPercent?: number;
  /** Pixels compared: the page area. */
  totalPixels?: number;
  /** Changed-pixel clusters. */
  regions?: ReadonlyArray<DiffShapeBox>;
}

export interface DiffShape {
  /**
   * - 'scattered': at most NOISE_MAX_DIFF_PERCENT of pixels, and no regions or
   *   regions spread over more than CONCENTRATED_MAX_PAGE_SHARE of the page.
   *   The only shape render noise takes.
   * - 'concentrated': every region fits in a box covering at most
   *   CONCENTRATED_MAX_PAGE_SHARE of the page (or the page size is unknown,
   *   so they cannot be shown to spread out), whatever the diff size.
   * - 'large': spread out, but more than NOISE_MAX_DIFF_PERCENT of pixels.
   */
  kind: 'scattered' | 'concentrated' | 'large';
  regionCount: number;
  /** Bounding box of every region; null without regions. */
  box: DiffShapeBox | null;
  /** The box's area as a percentage (0-100) of the page; null without a box or a page size. */
  pagePercent: number | null;
}

/** Read the shape of a pixel diff from a snapshot result. */
export function diffShape(input: DiffShapeInput): DiffShape {
  const regions = input.regions ?? [];
  let box: DiffShapeBox | null = null;
  if (regions.length > 0) {
    const x0 = Math.min(...regions.map((r) => r.x));
    const y0 = Math.min(...regions.map((r) => r.y));
    const x1 = Math.max(...regions.map((r) => r.x + r.width));
    const y1 = Math.max(...regions.map((r) => r.y + r.height));
    box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const page = input.totalPixels !== undefined && input.totalPixels > 0 ? input.totalPixels : null;
  // Compared as a ratio so a box of exactly a third of the page is exactly at the bound.
  const pageShare = box && page ? (box.width * box.height) / page : null;
  const pagePercent = pageShare === null ? null : pageShare * 100;

  const concentrated = box !== null && (pageShare === null || pageShare <= CONCENTRATED_MAX_PAGE_SHARE);
  const small = input.diffPercent !== undefined && input.diffPercent <= NOISE_MAX_DIFF_PERCENT;
  const kind = concentrated ? 'concentrated' : small ? 'scattered' : 'large';
  return { kind, regionCount: regions.length, box, pagePercent };
}

/** "3 regions within 155×52 px, 0.8% of the page", for verdict text. */
export function describeRegions(shape: DiffShape): string {
  if (!shape.box) return 'no regions';
  const n = shape.regionCount;
  const share = shape.pagePercent === null ? '' : `, ${shape.pagePercent.toFixed(1)}% of the page`;
  return `${n} region${n === 1 ? '' : 's'} within ${shape.box.width}×${shape.box.height} px${share}`;
}
