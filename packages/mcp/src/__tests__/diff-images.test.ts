import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { CROP_LIMITS, cropPng, cropWindow, planCrops, snapshotDiffContent } from '../diff-images';
import { resolvePaths, verdictFor, type RegionInfo, type SnapshotResult } from '../lib';
import { encode, page, pixels, type Box } from './png-helpers';

type Content = { type: string; text?: string; data?: string; mimeType?: string };
const texts = (c: Content[]) => c.filter((x) => x.type === 'text').map((x) => x.text as string);
const images = (c: Content[]) => c.filter((x) => x.type === 'image');
const decode = (item: Content) => PNG.sync.read(Buffer.from(item.data as string, 'base64'));
/** The image that follows the text item matching `label`. */
const imageAfter = (c: Content[], label: RegExp): PNG => {
  const at = c.findIndex((x) => x.type === 'text' && label.test(x.text as string));
  if (at === -1) throw new Error(`no text matching ${label} in:\n${texts(c).join('\n')}`);
  expect(c[at + 1]?.type).toBe('image');
  return decode(c[at + 1]);
};

const region = (x: number, y: number, width: number, height: number, extra: Partial<RegionInfo> = {}): RegionInfo => ({
  x,
  y,
  width,
  height,
  ...extra,
});

describe('CROP_LIMITS', () => {
  // The README, docs/mcp.md and the get_diff description quote these numbers.
  it('are the documented caps', () => {
    expect(CROP_LIMITS).toEqual({ maxCrops: 3, padding: 32, maxWidth: 1280, maxHeight: 1024, maxTotalPixels: 2_000_000 });
  });
});

describe('cropWindow', () => {
  it('shows an area within the limits whole, at native scale', () => {
    expect(cropWindow({ x: 8, y: 5968, width: 364, height: 124 })).toEqual({
      area: { x: 8, y: 5968, width: 364, height: 124 },
      shown: { x: 8, y: 5968, width: 364, height: 124 },
      scale: 1,
    });
  });

  it('shows the top 1024 rows of a taller area, still at native scale', () => {
    expect(cropWindow({ x: 0, y: 700, width: 390, height: 9000 })).toEqual({
      area: { x: 0, y: 700, width: 390, height: 9000 },
      shown: { x: 0, y: 700, width: 390, height: 1024 },
      scale: 1,
    });
  });

  it('samples an area wider than 1280 px at the smallest whole step that fits, rows counted at that scale', () => {
    expect(cropWindow({ x: 0, y: 0, width: 2560, height: 300 })).toMatchObject({ scale: 2, shown: { width: 2560, height: 300 } });
    expect(cropWindow({ x: 0, y: 0, width: 2561, height: 5000 })).toMatchObject({ scale: 3, shown: { width: 2561, height: 3072 } });
    expect(cropWindow({ x: 0, y: 0, width: 1280, height: 10 }).scale).toBe(1);
  });
});

describe('planCrops', () => {
  const canvas = { width: 390, height: 12000 };

  // Whole lines, so wrapping and clipping can be judged: a crop that stops at
  // the region's own columns cuts a changed heading mid-word.
  it('pads each region by 32 px, inside the canvas, and widens it to the page up to 1280 px', () => {
    const plan = planCrops([region(40, 6000, 300, 60), region(0, 0, 20, 20), region(370, 11990, 20, 10)], canvas);
    expect(plan.crops.map((c) => [c.regions, c.area])).toEqual([
      [[0], { x: 0, y: 5968, width: 390, height: 124 }],
      [[1], { x: 0, y: 0, width: 390, height: 52 }],
      [[2], { x: 0, y: 11958, width: 390, height: 42 }],
    ]);
    expect(plan.notShown).toEqual([]);
  });

  it('on a page wider than 1280 px, centres a 1280 px window on the region, inside the canvas', () => {
    const wide = { width: 1920, height: 3000 };
    const areas = (r: RegionInfo) => planCrops([r], wide).crops.map((c) => [c.area, c.scale]);
    expect(areas(region(900, 1000, 120, 20))).toEqual([[{ x: 320, y: 968, width: 1280, height: 84 }, 1]]);
    expect(areas(region(100, 500, 100, 20))).toEqual([[{ x: 0, y: 468, width: 1280, height: 84 }, 1]]);
    expect(areas(region(1700, 100, 100, 20))).toEqual([[{ x: 640, y: 68, width: 1280, height: 84 }, 1]]);
    // A region wider than that keeps its own width, sampled to fit.
    expect(areas(region(10, 100, 1800, 20))).toEqual([[{ x: 0, y: 68, width: 1842, height: 84 }, 2]]);
  });

  it('two regions in the same rows of a wide page share the window that shows both', () => {
    const plan = planCrops([region(100, 100, 50, 20), region(400, 100, 50, 20)], { width: 1920, height: 3000 });
    expect(plan.crops.map((c) => [c.regions, c.area])).toEqual([[[0, 1], { x: 0, y: 68, width: 1280, height: 84 }]]);
  });

  it('merges regions whose padded areas meet, while the merged crop fits 1280×1024', () => {
    // 50 px apart: the padded areas overlap.
    expect(planCrops([region(10, 100, 100, 20), region(10, 170, 100, 20)], canvas).crops.map((c) => [c.regions, c.area])).toEqual([
      [[0, 1], { x: 0, y: 68, width: 390, height: 154 }],
    ]);
    // 65 px apart: 64 px of padding between them leaves a gap.
    expect(planCrops([region(10, 100, 100, 20), region(10, 185, 100, 20)], canvas).crops.map((c) => c.regions)).toEqual([[0], [1]]);
    // Touching, but merged they would be taller than 1024 rows: kept apart.
    expect(planCrops([region(10, 100, 100, 600), region(10, 720, 100, 600)], canvas).crops.map((c) => c.regions)).toEqual([[0], [1]]);
  });

  // From a real 390 px capture: a heading that wraps one word later leaves a
  // speck at the end of its line and shifts everything below. The speck lies
  // inside the rows the big region's crop shows, so a crop of its own would
  // spend one of the three on pixels already shown.
  it("a region inside another crop's shown rows joins that crop instead of taking one of its own", () => {
    const plan = planCrops([region(268, 102, 5, 10), region(24, 131, 338, 8401)], { width: 390, height: 12406 });
    expect(plan.crops.map((c) => [c.regions, c.shown])).toEqual([[[0, 1], { x: 0, y: 99, width: 390, height: 1024 }]]);
    expect(plan.notShown).toEqual([]);
    // Below the rows shown, a region keeps its own crop.
    expect(planCrops([region(24, 131, 338, 8401), region(268, 2000, 5, 10)], { width: 390, height: 12406 }).crops.map((c) => c.regions)).toEqual([[0], [1]]);
  });

  it('merges a chain of nearby regions into one crop', () => {
    const chain = [region(10, 100, 50, 10), region(10, 160, 50, 10), region(10, 220, 50, 10), region(10, 280, 50, 10)];
    expect(planCrops(chain, canvas).crops.map((c) => c.regions)).toEqual([[0, 1, 2, 3]]);
  });

  it('crops changes before shifts, then in results order', () => {
    const regions = [
      region(0, 100, 390, 900, { classification: 'shift', shift: { dx: 0, dy: 40 } }),
      region(10, 2000, 100, 20, { classification: 'change' }),
      region(10, 3000, 100, 20),
    ];
    expect(planCrops(regions, canvas).crops.map((c) => c.regions)).toEqual([[1], [2], [0]]);
  });

  it('makes at most 3 crops and lists the regions it left out', () => {
    const regions = [0, 1, 2, 3, 4].map((i) => region(10, 1000 * i + 100, 100, 20));
    const plan = planCrops(regions, canvas);
    expect(plan.crops.map((c) => c.regions)).toEqual([[0], [1], [2]]);
    expect(plan.notShown).toEqual([3, 4]);
  });

  it('keeps the crops of one response within 2,000,000 px together, skipping a crop that would pass it', () => {
    const wide = { width: 1280, height: 12000 };
    const regions = [region(0, 100, 1280, 900), region(0, 2000, 1280, 900), region(0, 4000, 100, 20)];
    const plan = planCrops(regions, wide);
    // 1280×964 = 1,233,920 px; a second such crop would make 2,467,840.
    expect(plan.crops.map((c) => c.regions)).toEqual([[0], [2]]);
    expect(plan.notShown).toEqual([1]);
    const total = plan.crops.reduce((sum, c) => sum + Math.ceil(c.shown.width / c.scale) * Math.ceil(c.shown.height / c.scale), 0);
    expect(total).toBeLessThanOrEqual(CROP_LIMITS.maxTotalPixels);
  });

  it('leaves out regions with no area inside the canvas', () => {
    const plan = planCrops([region(10, 20000, 50, 50), region(10, 10, 0, 10), region(10, 10, 50, 50)], canvas);
    expect(plan.crops.map((c) => c.regions)).toEqual([[2]]);
    expect(plan.notShown).toEqual([0, 1]);
  });
});

describe('cropPng', () => {
  const src = page(390, 2000, { x: 40, y: 600, width: 300, height: 60 });

  it('copies the box pixel for pixel at native scale', () => {
    const box = { x: 8, y: 568, width: 364, height: 124 };
    const crop = cropPng(src, box, 1);
    expect(crop?.box).toEqual(box);
    expect([crop?.png.width, crop?.png.height]).toEqual([364, 124]);
    expect(pixels(crop!.png, { x: 0, y: 0, width: 364, height: 124 }).equals(pixels(src, box))).toBe(true);
  });

  it("cuts the box to the image's own bounds, and returns null for a box outside it", () => {
    const crop = cropPng(src, { x: 300, y: 1900, width: 200, height: 300 }, 1);
    expect(crop?.box).toEqual({ x: 300, y: 1900, width: 90, height: 100 });
    expect(pixels(crop!.png, { x: 0, y: 0, width: 90, height: 100 }).equals(pixels(src, crop!.box))).toBe(true);
    expect(cropPng(src, { x: 0, y: 2000, width: 390, height: 40 }, 1)).toBeNull();
  });

  it('samples every nth pixel at scale n', () => {
    const crop = cropPng(src, { x: 10, y: 20, width: 7, height: 5 }, 2)!;
    expect([crop.png.width, crop.png.height]).toEqual([4, 3]);
    const at = (png: PNG, x: number, y: number) => Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
    expect(at(crop.png, 3, 2)).toEqual(at(src, 16, 24));
  });
});

describe('snapshotDiffContent (what get_diff returns for a snapshot)', () => {
  let root: string;
  let report: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-crops-'));
    report = path.join(root, 'visual-report');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Write the snapshot's images under images/<name>/ and return its result entry. */
  function snapshot(name: string, imgs: { baseline?: PNG; current?: PNG; diff?: PNG | Buffer }, extra: Partial<SnapshotResult> = {}): SnapshotResult {
    const dir = path.join(report, 'images', name);
    fs.mkdirSync(dir, { recursive: true });
    const result: SnapshotResult = {
      name,
      status: 'changed',
      diffPercent: 0.4,
      dom: { changed: true, noiseHint: false, summary: { added: 0, removed: 0, attributeChanges: 0, textChanges: 1 } },
      ...extra,
    };
    for (const [key, img] of Object.entries(imgs)) {
      if (!img) continue;
      fs.writeFileSync(path.join(dir, `${key}.png`), Buffer.isBuffer(img) ? img : encode(img));
      (result as unknown as Record<string, string>)[`${key}Path`] = `images/${name}/${key}.png`;
    }
    return result;
  }

  /** Baseline, current and diff of one size; `ink` marks the change in the current capture and the diff. */
  const capture = (width: number, height: number, ink?: Box) => ({
    baseline: page(width, height),
    current: page(width, height, ink),
    diff: page(width, height, ink),
  });

  // The case from the field: a 390 px wide full-page capture 12,000 px tall.
  // Downscaled to 1024 px it is about 33×1000, too small to read.
  it('a tall 390×12000 capture: the full page downscaled, then the changed region at native scale, pixel for pixel', () => {
    const imgs = capture(390, 12000, { x: 40, y: 6000, width: 300, height: 60 });
    const hero = region(40, 6000, 300, 60, { classification: 'change', elements: [{ selector: '.hero > h1', role: 'changed' }] });
    const s = snapshot('home-mobile', imgs, { regions: [hero] });
    const content = snapshotDiffContent(resolvePaths(root), s) as Content[];

    expect(content[0]).toEqual({ type: 'text', text: `home-mobile: ${verdictFor(s)}` });
    // The overview is unchanged: three downscaled full-page images.
    for (const label of ['baseline', 'current', 'diff']) {
      const overview = imageAfter(content, new RegExp(`^${label} \\(downscaled from 390x12000\\):$`));
      expect([overview.width, overview.height]).toEqual([33, 1000]);
    }
    // Then the crop: the region plus 32 px, at native scale.
    expect(texts(content)).toContain('Crop 1 of 1: region #0 `.hero > h1` — x=0 y=5968 390×124 (the region plus 32 px, full width) at native scale:');
    const box = { x: 0, y: 5968, width: 390, height: 124 };
    for (const [label, source] of [['baseline', imgs.baseline], ['current', imgs.current], ['diff', imgs.diff]] as const) {
      const crop = imageAfter(content, new RegExp(`^${label}, crop 1:$`));
      expect([crop.width, crop.height]).toEqual([390, 124]);
      expect(pixels(crop, { x: 0, y: 0, width: 390, height: 124 }).equals(pixels(source, box))).toBe(true);
    }
    expect(images(content)).toHaveLength(6);
    expect(content.every((x) => x.type !== 'image' || x.mimeType === 'image/png')).toBe(true);
  }, 30_000);

  it('labels each crop with its box and selectors, and lists every region with the crop that shows it', () => {
    const regions = [
      region(4, 1000, 30, 30, { classification: 'change', elements: [{ selector: '.hero > h1', role: 'changed' }] }),
      region(4, 1070, 30, 10, { classification: 'change', elements: [{ selector: '.hero p', role: 'changed' }] }),
      region(0, 1500, 40, 1400, { classification: 'shift', shift: { dx: 0, dy: 24 }, elements: [{ selector: 'main', role: 'shifted' }] }),
    ];
    const content = snapshotDiffContent(resolvePaths(root), snapshot('home-mobile', capture(40, 3000), { regions })) as Content[];
    const t = texts(content);
    expect(t).toContain(
      [
        'Regions (3) on the 40×3000 diff canvas, in results.json order (get_diff with region: <n> crops one):',
        '- #0 x=4 y=1000 30×30, change, `.hero > h1`: crop 1',
        '- #1 x=4 y=1070 30×10, change, `.hero p`: crop 1',
        '- #2 x=0 y=1500 40×1400, shift, `main`: crop 2 (its top rows)',
        'The crops below are at native scale (one image pixel per page pixel) unless they say otherwise: read text, wrapping and clipping there, not in the downscaled full-page images above. get_diff with y and height crops any other band of the page.',
      ].join('\n'),
    );
    expect(t).toContain('Crop 1 of 2: regions #0 `.hero > h1`, #1 `.hero p` — x=0 y=968 40×144 (the regions plus 32 px, full width) at native scale:');
    expect(t).toContain(
      'Crop 2 of 2: region #2 `main` — x=0 y=1468 40×1024 (the region plus 32 px, full width) at native scale, the top 1024 of its 1464 rows (get_diff with y: 2492 shows the rows below):',
    );
    expect([imageAfter(content, /^current, crop 2:$/).width, imageAfter(content, /^current, crop 2:$/).height]).toEqual([40, 1024]);
  });

  it('lists at most 20 regions, and says how many more there are', () => {
    const regions = Array.from({ length: 25 }, (_, i) => region(10, 400 * i + 50, 50, 10));
    const t = texts(snapshotDiffContent(resolvePaths(root), snapshot('noisy', capture(100, 10000), { regions })) as Content[]).join('\n');
    expect(t).toMatch(/^- #2 x=10 y=850 50×10: crop 3$/m);
    expect(t).toMatch(/^- #19 x=10 y=7650 50×10: not cropped$/m);
    expect(t).not.toMatch(/^- #20 /m);
    expect(t).toMatch(/^- … and 5 more \(#20–#24\): get_report lists them, and region: <n> crops any of them$/m);
  });

  it('an area wider than 1280 px is sampled at 1/2 scale, and says so', () => {
    const content = snapshotDiffContent(resolvePaths(root), snapshot('desktop-2x', capture(2560, 60), { regions: [region(0, 20, 2560, 10)] })) as Content[];
    expect(texts(content)).toContain('Crop 1 of 1: region #0 — x=0 y=0 2560×60 (the region plus 32 px, full width) at 1/2 scale (every 2nd pixel, as it is wider than 1280 px):');
    const crop = imageAfter(content, /^current, crop 1:$/);
    expect([crop.width, crop.height]).toEqual([1280, 30]);
  });

  // witness pads both captures to max width × max height (top-left anchored),
  // so the regions are on that canvas and the band below the shorter capture
  // has no pixels of its own.
  describe('size mismatch', () => {
    it('crops each image within its own bounds and says so; an area outside the baseline has no baseline pixels', () => {
      const imgs = { baseline: page(40, 1100), current: page(40, 1130, { x: 0, y: 1100, width: 40, height: 30 }), diff: page(40, 1130) };
      const sizeMismatch = { baseline: { width: 40, height: 1100 }, candidate: { width: 40, height: 1130 } };
      const s = snapshot('home-mobile', imgs, { regions: [region(0, 1090, 40, 40)], sizeMismatch });
      const content = snapshotDiffContent(resolvePaths(root), s) as Content[];
      // The area is y=1058–1130 (72 rows): the baseline ends at 1100.
      expect(texts(content)).toContain('Crop 1 of 1: region #0 — x=0 y=1058 40×72 (the region plus 32 px, full width) at native scale:');
      const base = imageAfter(content, /^baseline, crop 1 \(cut to the baseline's 40×1100: x=0 y=1058 40×42\):$/);
      expect(pixels(base, { x: 0, y: 0, width: 40, height: 42 }).equals(pixels(imgs.baseline, { x: 0, y: 1058, width: 40, height: 42 }))).toBe(true);
      const cur = imageAfter(content, /^current, crop 1:$/);
      expect(pixels(cur, { x: 0, y: 0, width: 40, height: 72 }).equals(pixels(imgs.current, { x: 0, y: 1058, width: 40, height: 72 }))).toBe(true);

      const below = snapshotDiffContent(resolvePaths(root), s, { y: 1105, height: 20 }) as Content[];
      expect(texts(below)).toContain("baseline, band: none — this area is outside the baseline's 40×1100.");
      expect(images(below)).toHaveLength(2);
    });

    it('a current capture that shrank is cut to its own bounds the same way', () => {
      const imgs = { baseline: page(40, 1130), current: page(40, 1100), diff: page(40, 1130) };
      const sizeMismatch = { baseline: { width: 40, height: 1130 }, candidate: { width: 40, height: 1100 } };
      const content = snapshotDiffContent(resolvePaths(root), snapshot('home-mobile', imgs, { regions: [region(0, 1090, 40, 40)], sizeMismatch })) as Content[];
      const cur = imageAfter(content, /^current, crop 1 \(cut to the current capture's 40×1100: x=0 y=1058 40×42\):$/);
      expect([cur.width, cur.height]).toEqual([40, 42]);
      expect(texts(content)).toContain('baseline, crop 1:');
    });
  });

  describe('region: <n>', () => {
    const regions = [
      region(4, 2000, 30, 30, { classification: 'change', elements: [{ selector: '.hero > h1', role: 'changed' }] }),
      region(0, 2500, 40, 1400, { classification: 'shift', elements: [{ selector: 'main', role: 'shifted' }] }),
    ];

    it("returns only that region's crop, with no full-page images", () => {
      const imgs = capture(40, 4000, { x: 4, y: 2000, width: 30, height: 30 });
      const s = snapshot('home-mobile', imgs, { regions });
      const content = snapshotDiffContent(resolvePaths(root), s, { region: 0 }) as Content[];
      expect(texts(content)).toEqual([
        `home-mobile: ${verdictFor(s)}`,
        'Region #0 of 2: x=4 y=2000 30×30, change, `.hero > h1` — x=0 y=1968 40×94 (the region plus 32 px, full width) at native scale:',
        'baseline:',
        'current:',
        'diff:',
      ]);
      expect(images(content)).toHaveLength(3);
      const box = { x: 0, y: 1968, width: 40, height: 94 };
      expect(pixels(imageAfter(content, /^current:$/), { ...box, y: 0 }).equals(pixels(imgs.current, box))).toBe(true);
    });

    it('a region taller than 1024 rows shows its top rows and where to continue', () => {
      const content = snapshotDiffContent(resolvePaths(root), snapshot('home-mobile', capture(40, 4000), { regions }), { region: 1 }) as Content[];
      expect(texts(content)[1]).toBe(
        'Region #1 of 2: x=0 y=2500 40×1400, shift, `main` — x=0 y=2468 40×1024 (the region plus 32 px, full width) at native scale, the top 1024 of its 1464 rows (get_diff with y: 3492 shows the rows below):',
      );
    });

    it('is refused with a message when there is no such region, the snapshot has none, or y is passed too', () => {
      const s = snapshot('home-mobile', capture(40, 100), { regions });
      const only = (request: Parameters<typeof snapshotDiffContent>[2]) => texts(snapshotDiffContent(resolvePaths(root), s, request) as Content[]).slice(1);
      expect(only({ region: 2 })).toEqual(['home-mobile has 2 regions (#0–#1): there is no region #2.']);
      expect(only({ region: 0, y: 10 })).toEqual(['Pass region, or y and height, not both.']);
      expect(only({ region: 0, height: 10 })).toEqual(['Pass region, or y and height, not both.']);
      const one = snapshot('card', capture(40, 100), { regions: regions.slice(0, 1) });
      expect(texts(snapshotDiffContent(resolvePaths(root), one, { region: 3 }) as Content[]).slice(1)).toEqual(['card has 1 region (#0): there is no region #3.']);
      const none = snapshot('plain', capture(40, 100));
      expect(texts(snapshotDiffContent(resolvePaths(root), none, { region: 0 }) as Content[]).slice(1)).toEqual([
        'plain has no regions in the latest results: get_diff with y and height crops a band of the page instead.',
      ]);
    });
  });

  describe('y and height', () => {
    it('return a full-width band at native scale, pixel for pixel', () => {
      const imgs = capture(40, 12000);
      const content = snapshotDiffContent(resolvePaths(root), snapshot('home-mobile', imgs, { regions: [region(0, 10, 5, 5)] }), { y: 3000, height: 200 }) as Content[];
      expect(texts(content).slice(1)).toEqual(['Band y=3000–3200 of the 40×12000 canvas, full width, at native scale:', 'baseline, band:', 'current, band:', 'diff, band:']);
      for (const [label, source] of [['baseline', imgs.baseline], ['current', imgs.current], ['diff', imgs.diff]] as const) {
        const band = imageAfter(content, new RegExp(`^${label}, band:$`));
        expect(pixels(band, { x: 0, y: 0, width: 40, height: 200 }).equals(pixels(source, { x: 0, y: 3000, width: 40, height: 200 }))).toBe(true);
      }
    });

    it('a band taller than 1024 rows shows its top rows; one past the bottom is cut there; one below the page is refused', () => {
      // Only the headers are checked here: a narrow page keeps the crops cheap.
      const s = snapshot('home-mobile', capture(8, 12000));
      const header = (request: { y?: number; height?: number }) => texts(snapshotDiffContent(resolvePaths(root), s, request) as Content[])[1];
      expect(header({ y: 100, height: 3000 })).toBe(
        'Band y=100–1124 of the 8×12000 canvas, full width, at native scale, the top 1024 of the 3000 rows asked for (get_diff with y: 1124 shows the rows below):',
      );
      expect(header({ y: 11900, height: 500 })).toBe('Band y=11900–12000 of the 8×12000 canvas, full width, at native scale (the canvas ends at y=12000):');
      // y alone: 1024 rows; height alone: from the top.
      expect(header({ y: 500 })).toBe('Band y=500–1524 of the 8×12000 canvas, full width, at native scale:');
      expect(header({ height: 50 })).toBe('Band y=0–50 of the 8×12000 canvas, full width, at native scale:');
      expect(header({ y: 12000 })).toBe("y=12000 is below the bottom of home-mobile's 8×12000 canvas.");
    });

    it('work on a new snapshot, which has only its current capture', () => {
      const current = page(40, 5000);
      const s = snapshot('signup', { current }, { status: 'new', diffPercent: 0, dom: undefined });
      const content = snapshotDiffContent(resolvePaths(root), s, { y: 4000, height: 100 }) as Content[];
      expect(texts(content).slice(1)).toEqual(['Band y=4000–4100 of the 40×5000 canvas, full width, at native scale:', 'current, band:']);
      expect(pixels(imageAfter(content, /^current, band:$/), { x: 0, y: 0, width: 40, height: 100 }).equals(pixels(current, { x: 0, y: 4000, width: 40, height: 100 }))).toBe(true);
    });
  });

  it('a snapshot with no regions gets the full-page images only, as before', () => {
    const s = snapshot('card', { baseline: page(20, 20), current: page(3000, 10) });
    const content = snapshotDiffContent(resolvePaths(root), s) as Content[];
    expect(content.map((x) => x.type)).toEqual(['text', 'text', 'image', 'text', 'image']);
    expect(texts(content).slice(1)).toEqual(['baseline:', 'current (downscaled from 3000x10):']);
    // An image that fits is sent as its own bytes.
    expect(Buffer.from(content[2].data as string, 'base64')).toEqual(fs.readFileSync(path.join(report, 'images', 'card', 'baseline.png')));
  });

  // Crops add detail only where the full page was downscaled: a page that
  // fits is already sent at native scale, so crops would repeat its pixels.
  it('a page that fits without downscaling gets no crops: its full-page images are already at native scale', () => {
    const s = snapshot('card', capture(200, 300), { regions: [region(10, 10, 50, 20)] });
    const content = snapshotDiffContent(resolvePaths(root), s) as Content[];
    expect(texts(content).slice(1)).toEqual(['baseline:', 'current:', 'diff:']);
    expect(images(content)).toHaveLength(3);
    // On request it still crops.
    expect(texts(snapshotDiffContent(resolvePaths(root), s, { region: 0 }) as Content[])[1]).toMatch(/^Region #0 of 1: /);
  });

  it('crops when any of the images was downscaled, such as a current capture that grew past 1024 px', () => {
    const imgs = { baseline: page(40, 1000), current: page(40, 1100), diff: page(40, 1100) };
    const sizeMismatch = { baseline: { width: 40, height: 1000 }, candidate: { width: 40, height: 1100 } };
    const content = snapshotDiffContent(resolvePaths(root), snapshot('grew', imgs, { regions: [region(0, 1000, 40, 100)], sizeMismatch })) as Content[];
    expect(texts(content)).toContain('baseline:');
    expect(texts(content)).toContain('current (downscaled from 40x1100):');
    expect(texts(content)).toContain("baseline, crop 1 (cut to the baseline's 40×1000: x=0 y=968 40×32):");
  });

  it('an image that is not a PNG is said, not thrown', () => {
    const s = snapshot('broken', { baseline: page(20, 1100), current: page(20, 1100), diff: Buffer.from('not a png') }, { regions: [region(2, 2, 5, 5)] });
    const content = snapshotDiffContent(resolvePaths(root), s) as Content[];
    expect(texts(content)).toContainEqual(expect.stringMatching(/^diff: images\/broken\/diff\.png could not be read as a PNG \(.+\)\.$/));
    expect(texts(content)).toContain('baseline, crop 1:');
    expect(texts(content)).not.toContain('diff, crop 1:');
  });
});
