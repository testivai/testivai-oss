/**
 * thumb.png: the changed area of a changed snapshot, small enough to sit in a
 * pull request comment.
 *
 * A full-page diff shown inline is scaled to the comment's width, so a change
 * is a thin band down a tall image. The thumbnail crops the changed area
 * instead (the union of the up to three largest regions, padded 24 px; with
 * no regions, a 400 px band from the first differing row) and puts baseline,
 * current and diff of it side by side, at most 800×400 px, downscaled by area
 * average and never upscaled. Only a `changed` snapshot gets one.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { compareAll } from '../report/compare';
import { renderThumbnail, THUMBNAIL_LIMITS, THUMBNAIL_PADDING_RGBA, thumbnailArea } from '../report/thumbnail';
import { BLUE, encodePng, makePng, paintRect, RED, solidRgba, WHITE } from './helpers/synth';

/** A white page with a blue card every 300 px, so the panels have something to show. */
function page(width: number, height: number, extra: Array<{ rect: { x: number; y: number; width: number; height: number }; color: [number, number, number, number] }> = []): Buffer {
  const cards = Array.from({ length: Math.floor(height / 300) }, (_, i) => ({
    rect: { x: 40, y: 40 + i * 300, width: Math.min(400, width - 80), height: 120 },
    color: BLUE,
  }));
  return makePng(width, height, WHITE, [...cards, ...extra]);
}

/** The three panels of a strip: baseline | current | diff, 2 px apart. */
function panels(strip: PNG) {
  const sep = THUMBNAIL_LIMITS.separator;
  const width = (strip.width - 2 * sep) / 3;
  const panel = (index: number) => {
    const x0 = index * (width + sep);
    const pixels: number[][] = [];
    for (let y = 0; y < strip.height; y++) {
      for (let x = x0; x < x0 + width; x++) {
        const i = (y * strip.width + x) * 4;
        pixels.push([strip.data[i], strip.data[i + 1], strip.data[i + 2], strip.data[i + 3]]);
      }
    }
    return pixels;
  };
  return { width, baseline: panel(0), current: panel(1), diff: panel(2) };
}

/** A heat pixel in the diff: the background wash is grey, heat is yellow to red. */
const isHeat = ([r, g, b]: number[]) => r !== g || g !== b;

describe('thumb.png for a changed snapshot', () => {
  let root: string;
  let reportDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-thumb-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSnapshot(name: string, baseline: Buffer, candidate: Buffer | null): void {
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(tDir, { recursive: true });
    if (candidate) fs.writeFileSync(path.join(tDir, 'screenshot.png'), candidate);
    if (baseline.length > 0) {
      const bDir = path.join(root, '.testivai', 'baselines', name);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'screenshot.png'), baseline);
    }
  }

  const thumbFile = (name: string) => path.join(reportDir, 'images', name, 'thumb.png');
  const readThumb = (name: string) => PNG.sync.read(fs.readFileSync(thumbFile(name)));

  it('crops the changed area of a tall page: baseline | current | diff, at most 800×400', () => {
    // 1200×3000; the only change is a 300×100 block at y=2000.
    writeSnapshot('tall', page(1200, 3000), page(1200, 3000, [{ rect: { x: 450, y: 2000, width: 300, height: 100 }, color: RED }]));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('changed');
    expect(result.thumbPath).toBe('images/tall/thumb.png');
    const strip = readThumb('tall');
    expect(strip.width).toBeLessThanOrEqual(THUMBNAIL_LIMITS.maxWidth);
    expect(strip.height).toBeLessThanOrEqual(THUMBNAIL_LIMITS.maxHeight);
    // The block padded 24 px is 348×148: three panels and two separators are
    // 1048 px wide, so the strip is scaled to fit 800 (265 px panels).
    expect(strip.width).toBe(3 * 265 + 4);
    expect(strip.height).toBe(Math.round(148 * (796 / (3 * 348))));

    const { baseline, current, diff } = panels(strip);
    expect(diff.some(isHeat)).toBe(true);
    const differs = baseline.some((px, i) => px.some((v, c) => v !== current[i][c]));
    expect(differs).toBe(true);
    // The crop is the block, not the top of the page: red in the current
    // panel only.
    const red = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
    expect(current.some(red)).toBe(true);
    expect(baseline.some(red)).toBe(false);
  });

  it('writes no thumbnail when nothing changed', () => {
    const same = page(400, 600);
    writeSnapshot('same', same, Buffer.from(same));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('passed');
    expect(result.thumbPath).toBeUndefined();
    expect(fs.existsSync(thumbFile('same'))).toBe(false);
  });

  it('falls back to a 400 px band from the first differing row when the diff has no regions', () => {
    // A 2×2 change is under the region noise floor (diffRegions.minSize 10):
    // the snapshot is changed, with no regions.
    writeSnapshot('speck', page(1200, 3000), page(1200, 3000, [{ rect: { x: 600, y: 1500, width: 2, height: 2 }, color: RED }]));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('changed');
    expect(result.regions ?? []).toHaveLength(0);
    expect(result.thumbPath).toBe('images/speck/thumb.png');
    const strip = readThumb('speck');
    // A full-width band (1200) of 400 rows, scaled to fit 800.
    expect(strip.width).toBe(3 * 265 + 4);
    expect(strip.height).toBe(Math.round(400 * (796 / 3600)));
    // The band starts at the first differing row: the change is in its top rows.
    const { diff, width } = panels(strip);
    const firstHeatRow = Math.floor(diff.findIndex(isHeat) / width);
    expect(firstHeatRow).toBeGreaterThanOrEqual(0);
    expect(firstHeatRow).toBeLessThanOrEqual(1);
  });

  it('crops the padded canvas when the sizes differ', () => {
    // The candidate is 60 px taller: the diff is on 300×260, and the padded
    // band at the bottom is the region.
    writeSnapshot('grown', page(300, 200), page(300, 260));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('changed');
    expect(result.sizeMismatch).toBeDefined();
    expect(result.thumbPath).toBe('images/grown/thumb.png');
    const strip = readThumb('grown');
    expect(strip.width).toBeLessThanOrEqual(THUMBNAIL_LIMITS.maxWidth);
    expect(strip.height).toBeLessThanOrEqual(THUMBNAIL_LIMITS.maxHeight);
    // Rows the baseline does not have are drawn as padding in its panel.
    const { baseline, current } = panels(strip);
    expect(baseline[baseline.length - 1]).toEqual([...THUMBNAIL_PADDING_RGBA]);
    expect(current[current.length - 1]).not.toEqual([...THUMBNAIL_PADDING_RGBA]);
  });

  it('never upscales a small capture: a 200×100 change is a 3×200+4 strip', () => {
    writeSnapshot('small', makePng(200, 100), makePng(200, 100, WHITE, [{ rect: { x: 20, y: 20, width: 160, height: 60 }, color: RED }]));

    compareAll({ projectRoot: root, reportDir });

    const strip = readThumb('small');
    expect(strip.width).toBe(3 * 200 + 4);
    expect(strip.height).toBe(100);
  });

  it('keeps the 800 px cap for a 400×200 capture: scaled down to 3×265+4, never past its size', () => {
    writeSnapshot('wide', makePng(400, 200), makePng(400, 200, WHITE, [{ rect: { x: 20, y: 20, width: 360, height: 160 }, color: RED }]));

    compareAll({ projectRoot: root, reportDir });

    const strip = readThumb('wide');
    expect(strip.width).toBe(3 * 265 + 4);
    expect(strip.height).toBe(Math.round(200 * (796 / 1200)));
  });

  it('sets thumbPath exactly for changed snapshots: never passed, auto-passed or new ones', () => {
    const block = (x: number, y: number, w: number, h: number) => [{ rect: { x, y, width: w, height: h }, color: RED }];
    writeSnapshot('changed', page(400, 600), page(400, 600, block(100, 300, 120, 80)));
    writeSnapshot('within-tolerance', page(400, 600), page(400, 600, block(100, 300, 4, 4)));
    const same = page(400, 600);
    writeSnapshot('identical', same, Buffer.from(same));
    writeSnapshot('brand-new', Buffer.alloc(0), page(400, 600));

    const results = compareAll({ projectRoot: root, reportDir, passCriteria: { maxDiffPixels: 50 } });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    expect(byName.changed.status).toBe('changed');
    expect(byName['within-tolerance']).toMatchObject({ status: 'passed', autoPassed: 'threshold' });
    expect(byName.identical.status).toBe('passed');
    expect(byName['brand-new'].status).toBe('new');
    for (const r of results) {
      const expected = r.status === 'changed';
      expect({ name: r.name, thumbPath: r.thumbPath }).toEqual({ name: r.name, thumbPath: expected ? `images/${r.name}/thumb.png` : undefined });
      expect({ name: r.name, file: fs.existsSync(thumbFile(r.name)) }).toEqual({ name: r.name, file: expected });
    }
  });
});

describe('thumbnailArea', () => {
  /** A washed (grey) diff canvas with heat pixels at the given points. */
  function diffWithHeat(width: number, height: number, points: Array<[number, number]>) {
    const data = solidRgba(width, height, [240, 240, 240, 255]);
    for (const [x, y] of points) paintRect(data, width, height, { x, y, width: 1, height: 1 }, [255, 152, 0, 255]);
    return { data, width, height };
  }

  it('is the union of the three largest regions, padded 24 px and kept inside the canvas', () => {
    const diff = diffWithHeat(1000, 2000, []);
    const regions = [
      { x: 10, y: 10, width: 20, height: 20 }, // smallest: left out
      { x: 100, y: 500, width: 200, height: 100 },
      { x: 900, y: 600, width: 90, height: 90 },
      { x: 400, y: 1000, width: 300, height: 50 },
    ];

    expect(thumbnailArea(regions, diff)).toEqual({ x: 76, y: 476, width: 1000 - 76, height: 1074 - 476 });
  });

  it('is a 400 px band from the first differing row, full width, without regions', () => {
    const diff = diffWithHeat(1280, 3000, [[700, 1234], [10, 2000]]);

    expect(thumbnailArea(undefined, diff)).toEqual({ x: 0, y: 1234, width: 1280, height: 400 });
    expect(thumbnailArea([], diff)).toEqual({ x: 0, y: 1234, width: 1280, height: 400 });
  });

  it('keeps the band 400 px tall near the bottom, still including the first differing row', () => {
    const diff = diffWithHeat(1280, 3000, [[5, 2900]]);

    const area = thumbnailArea(undefined, diff);

    expect(area).toEqual({ x: 0, y: 2600, width: 1280, height: 400 });
  });

  it('is null when no pixel differs (mask hatching is grey, not heat)', () => {
    const diff = diffWithHeat(200, 200, []);
    paintRect(diff.data, 200, 200, { x: 0, y: 0, width: 50, height: 50 }, [128, 128, 128, 140]);

    expect(thumbnailArea(undefined, diff)).toBeNull();
  });
});

describe('renderThumbnail', () => {
  it('averages the area down (never upscales) and separates the panels with 2 px', () => {
    // 6×2 black and white columns: averaged down to grey at 1/3 scale.
    const stripes = solidRgba(12, 6, WHITE);
    for (let x = 0; x < 12; x += 2) paintRect(stripes, 12, 6, { x, y: 0, width: 1, height: 6 }, [0, 0, 0, 255]);
    const image = { data: stripes, width: 12, height: 6 };

    const small = renderThumbnail({ baseline: image, current: image, diff: image }, { x: 0, y: 0, width: 12, height: 6 });

    expect(small.width).toBe(3 * 12 + 4);
    expect(small.height).toBe(6);
    expect([...small.data.subarray(0, 8)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);

    const wide = { data: solidRgba(1200, 4, WHITE), width: 1200, height: 4 };
    for (let x = 0; x < 1200; x += 2) paintRect(wide.data, 1200, 4, { x, y: 0, width: 1, height: 4 }, [0, 0, 0, 255]);
    const scaled = renderThumbnail({ baseline: wide, current: wide, diff: wide }, { x: 0, y: 0, width: 1200, height: 4 });
    expect(scaled.width).toBeLessThanOrEqual(800);
    // Each output pixel averages black and white columns: mid grey, not a sampled black or white.
    const [r] = scaled.data;
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(160);
  });

  it('can be encoded as a PNG', () => {
    const image = { data: solidRgba(10, 10, WHITE), width: 10, height: 10 };
    const strip = renderThumbnail({ baseline: image, current: image, diff: image }, { x: 0, y: 0, width: 10, height: 10 });

    const png = PNG.sync.read(encodePng(new Uint8ClampedArray(strip.data), strip.width, strip.height));

    expect([png.width, png.height]).toEqual([34, 10]);
  });
});
