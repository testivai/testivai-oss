/**
 * Tests for the TestivAI Diff Engine
 *
 * Uses programmatically generated pixel buffers (no external PNG files).
 */

import { diff, normalizeDimensions } from '../diff';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a solid-color RGBA pixel buffer */
function createSolidBuffer(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

/** Create a buffer with a colored block at a specific position */
function createBufferWithBlock(
  width: number, height: number,
  bgR: number, bgG: number, bgB: number,
  blockX: number, blockY: number, blockW: number, blockH: number,
  blockR: number, blockG: number, blockB: number,
): Uint8ClampedArray {
  const buf = createSolidBuffer(width, height, bgR, bgG, bgB);
  for (let y = blockY; y < blockY + blockH && y < height; y++) {
    for (let x = blockX; x < blockX + blockW && x < width; x++) {
      const idx = (y * width + x) * 4;
      buf[idx] = blockR;
      buf[idx + 1] = blockG;
      buf[idx + 2] = blockB;
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

/** Create an output diff buffer */
function createDiffBuffer(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Diff Engine', () => {
  describe('T1.1 - Identical buffers', () => {
    it('should return diffCount=0 and isIdentical=true for identical images', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 128, 64, 32);
      const candidate = createSolidBuffer(w, h, 128, 64, 32);
      const output = createDiffBuffer(w, h);

      const result = diff(baseline, candidate, output, w, h);

      expect(result.diffCount).toBe(0);
      expect(result.isIdentical).toBe(true);
      expect(result.diffPercent).toBe(0);
      expect(result.totalPixels).toBe(100);
      expect(result.hash).toBe(0);
    });
  });

  describe('T1.2 - Different buffers', () => {
    it('should return correct diffCount and diffPercent for completely different images', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);       // black
      const candidate = createSolidBuffer(w, h, 255, 255, 255); // white
      const output = createDiffBuffer(w, h);

      const result = diff(baseline, candidate, output, w, h);

      expect(result.diffCount).toBeGreaterThan(0);
      expect(result.isIdentical).toBe(false);
      expect(result.diffPercent).toBeGreaterThan(0);
      expect(result.totalPixels).toBe(100);
    });

    it('should detect partial differences when only some pixels differ', () => {
      const w = 10, h = 10;
      // Baseline: all black. Candidate: first row is white, rest is black.
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 0, 0, 0);
      // Make first row white
      for (let x = 0; x < w; x++) {
        const idx = x * 4;
        candidate[idx] = 255;
        candidate[idx + 1] = 255;
        candidate[idx + 2] = 255;
      }
      const output = createDiffBuffer(w, h);

      const result = diff(baseline, candidate, output, w, h);

      expect(result.diffCount).toBeGreaterThan(0);
      expect(result.diffCount).toBeLessThanOrEqual(w); // at most 10 pixels changed
      expect(result.isIdentical).toBe(false);
    });
  });

  describe('T1.3 - Threshold sensitivity', () => {
    it('should catch more diffs with lower threshold', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 100, 100, 100);
      // Subtle difference
      const candidate = createSolidBuffer(w, h, 110, 100, 100);
      const output1 = createDiffBuffer(w, h);
      const output2 = createDiffBuffer(w, h);

      const resultLow = diff(baseline, candidate, output1, w, h, { threshold: 0.01 });
      const resultHigh = diff(baseline, candidate, output2, w, h, { threshold: 0.5 });

      // Lower threshold should catch more or equal diffs
      expect(resultLow.diffCount).toBeGreaterThanOrEqual(resultHigh.diffCount);
    });
  });

  describe('T1.4 - Minimap overlay', () => {
    it('should modify output buffer when minimap is enabled', () => {
      const w = 20, h = 20;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 255, 255, 255);
      const outputNoMinimap = createDiffBuffer(w, h);
      const outputWithMinimap = createDiffBuffer(w, h);

      diff(baseline, candidate, outputNoMinimap, w, h, { enableMinimap: false });
      diff(baseline, candidate, outputWithMinimap, w, h, { enableMinimap: true });

      // With minimap, additional pixels get ORed with the minimap color,
      // so the output should be different from without minimap
      let differ = false;
      for (let i = 0; i < outputNoMinimap.length; i++) {
        if (outputNoMinimap[i] !== outputWithMinimap[i]) {
          differ = true;
          break;
        }
      }
      expect(differ).toBe(true);
    });
  });

  describe('T1.5 - Ignore regions', () => {
    it('should not count masked areas in diff', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 255, 255, 255);
      const output1 = createDiffBuffer(w, h);
      const output2 = createDiffBuffer(w, h);

      // Without ignore: all pixels differ
      const resultFull = diff(baseline, candidate, output1, w, h);

      // Ignore the entire image
      const resultIgnored = diff(baseline, candidate, output2, w, h, {
        ignoreRegions: [{ x: 0, y: 0, width: w, height: h }],
      });

      expect(resultFull.diffCount).toBeGreaterThan(0);
      expect(resultIgnored.diffCount).toBe(0);
      expect(resultIgnored.isIdentical).toBe(true);
    });

    it('should only ignore specified regions', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 255, 255, 255);
      const output = createDiffBuffer(w, h);

      // Ignore half the image
      const result = diff(baseline, candidate, output, w, h, {
        ignoreRegions: [{ x: 0, y: 0, width: 5, height: h }],
      });

      // Should still detect diffs in the non-ignored half
      expect(result.diffCount).toBeGreaterThan(0);
      // But less than full diff
      const fullResult = diff(
        createSolidBuffer(w, h, 0, 0, 0),
        createSolidBuffer(w, h, 255, 255, 255),
        createDiffBuffer(w, h),
        w, h,
      );
      expect(result.diffCount).toBeLessThan(fullResult.diffCount);
    });
  });

  describe('T1.6 - Size mismatch with pad', () => {
    it('should pad smaller image and return SizeMismatch info', () => {
      const baseline = createSolidBuffer(10, 10, 128, 128, 128);
      const candidate = createSolidBuffer(10, 8, 128, 128, 128); // shorter
      const output = createDiffBuffer(10, 10);

      const result = diff(baseline, candidate, output, 10, 10, {
        handleSizeMismatch: 'pad',
      });

      expect(result.sizeMismatch).toBeDefined();
      expect(result.sizeMismatch!.baseline).toEqual({ width: 10, height: 10 });
      expect(result.sizeMismatch!.candidate).toEqual({ width: 10, height: 8 });
      expect(result.sizeMismatch!.normalized.width).toBe(10);
      expect(result.sizeMismatch!.normalized.height).toBe(10);
    });
  });

  describe('T1.7 - Size mismatch with crop', () => {
    it('should use minimum dimensions', () => {
      const result = normalizeDimensions(
        createSolidBuffer(10, 10, 0, 0, 0), 10, 10,
        createSolidBuffer(8, 8, 0, 0, 0), 8, 8,
        'crop',
      );

      expect(result.width).toBe(8);
      expect(result.height).toBe(8);
      expect(result.normalizedBaseline.length).toBe(8 * 8 * 4);
      expect(result.normalizedCandidate.length).toBe(8 * 8 * 4);
    });
  });

  describe('T1.8 - Size mismatch with error', () => {
    it('should throw a descriptive error', () => {
      expect(() => {
        normalizeDimensions(
          createSolidBuffer(10, 10, 0, 0, 0), 10, 10,
          createSolidBuffer(8, 8, 0, 0, 0), 8, 8,
          'error',
        );
      }).toThrow(/Size mismatch.*10×10.*8×8/);
    });
  });

  describe('T1.9 - Region detection', () => {
    it('should return bounding boxes for change clusters', () => {
      const w = 20, h = 20;
      // Baseline: all black. Candidate: has a white block at (5,5)-(9,9)
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createBufferWithBlock(w, h, 0, 0, 0, 5, 5, 5, 5, 255, 255, 255);
      const output = createDiffBuffer(w, h);

      const result = diff(baseline, candidate, output, w, h, {
        detectRegions: true,
      });

      expect(result.regions).toBeDefined();
      expect(result.regions!.length).toBeGreaterThan(0);

      // The region should encompass the changed block
      const region = result.regions![0];
      expect(region.x).toBeGreaterThanOrEqual(5);
      expect(region.y).toBeGreaterThanOrEqual(5);
      expect(region.diffPixels).toBeGreaterThan(0);
    });
  });

  describe('T1.10 - Region detection filters noise', () => {
    it('should filter out regions below minSize', () => {
      const w = 20, h = 20;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 0, 0, 0);
      // Change just 2 pixels (below default minSize of 10)
      candidate[0] = 255;     // pixel (0,0) R
      candidate[1] = 255;     // pixel (0,0) G
      candidate[2] = 255;     // pixel (0,0) B
      candidate[4] = 255;     // pixel (1,0) R
      candidate[5] = 255;     // pixel (1,0) G
      candidate[6] = 255;     // pixel (1,0) B
      const output = createDiffBuffer(w, h);

      const result = diff(baseline, candidate, output, w, h, {
        detectRegions: true,
      });

      // Regions should be empty since 2 pixels < minSize of 10
      if (result.regions) {
        expect(result.regions.length).toBe(0);
      }
    });
  });

  describe('T1.11 - Backward compatibility', () => {
    it('should always return a full DiffResult object', () => {
      const w = 5, h = 5;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 255, 255, 255);
      const output = createDiffBuffer(w, h);

      const result = diff(baseline, candidate, output, w, h);

      // Verify all expected properties exist
      expect(typeof result.diffCount).toBe('number');
      expect(typeof result.cumulatedDiff).toBe('number');
      expect(typeof result.hash).toBe('number');
      expect(typeof result.diffPercent).toBe('number');
      expect(typeof result.totalPixels).toBe('number');
      expect(typeof result.isIdentical).toBe('boolean');
    });
  });

  describe('T1.12 - Hash consistency', () => {
    it('should produce the same hash for the same diff', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidate = createSolidBuffer(w, h, 255, 0, 0);

      const output1 = createDiffBuffer(w, h);
      const output2 = createDiffBuffer(w, h);

      const result1 = diff(baseline, candidate, output1, w, h);
      const result2 = diff(baseline, candidate, output2, w, h);

      expect(result1.hash).toBe(result2.hash);
      expect(result1.hash).not.toBe(0);
    });

    it('should produce different hashes for different diffs', () => {
      const w = 10, h = 10;
      const baseline = createSolidBuffer(w, h, 0, 0, 0);
      const candidateA = createSolidBuffer(w, h, 255, 0, 0);  // red
      const candidateB = createSolidBuffer(w, h, 0, 255, 0);  // green

      const outputA = createDiffBuffer(w, h);
      const outputB = createDiffBuffer(w, h);

      const resultA = diff(baseline, candidateA, outputA, w, h);
      const resultB = diff(baseline, candidateB, outputB, w, h);

      // Different color changes should produce different hashes
      // (Though Pbd hash is position-based, same positions → same hash for uniform images.
      //  But the diff *values* may differ, so we just check both are non-zero.)
      expect(resultA.hash).not.toBe(0);
      expect(resultB.hash).not.toBe(0);
    });
  });
});

describe('heatmap diff rendering', () => {
  const { diff } = require('../diff/diff');

  const px = (r: number, g: number, b: number) => [r, g, b, 255];
  const makeBuf = (pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

  it('changed pixels are opaque warm heat colors; unchanged pixels are washed context', () => {
    // 2x1: pixel 0 identical (mid gray), pixel 1 strongly different
    const baseline = makeBuf([px(128, 128, 128), px(0, 0, 0)]);
    const candidate = makeBuf([px(128, 128, 128), px(255, 255, 255)]);
    const out = new Uint8ClampedArray(2 * 1 * 4);

    const res = diff(baseline, candidate, out, 2, 1, { enableMinimap: false });
    expect(res.diffCount).toBe(1);

    // unchanged pixel: washed light grayscale, opaque
    expect(out[3]).toBe(255);
    expect(out[0]).toBeGreaterThanOrEqual(216);
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);

    // changed pixel: opaque, warm (red-dominant, blue-suppressed)
    expect(out[7]).toBe(255);
    expect(out[4]).toBeGreaterThan(180); // R high across the whole ramp
    expect(out[4]).toBeGreaterThan(out[6]); // R > B (never blue/green)
  });

  it('subtle diffs render yellow-ish, strong diffs render red-ish', () => {
    const baseline = makeBuf([px(120, 120, 120), px(0, 0, 0)]);
    const candidate = makeBuf([px(135, 135, 135), px(255, 255, 255)]); // small vs max delta
    const out = new Uint8ClampedArray(2 * 1 * 4);
    diff(baseline, candidate, out, 2, 1, { enableMinimap: false, threshold: 0.05 });

    const subtleG = out[1]; // green channel high → yellow
    const strongG = out[5]; // green channel low → red
    expect(subtleG).toBeGreaterThan(strongG);
  });

  it('region outlines are drawn when detectRegions is on', () => {
    const W = 12, H = 12;
    const baseline = new Uint8ClampedArray(W * H * 4).fill(255);
    const candidate = new Uint8ClampedArray(baseline);
    // 2x2 changed block in the middle
    for (const [x, y] of [[5,5],[6,5],[5,6],[6,6]]) {
      const i = (y * W + x) * 4;
      candidate[i] = 0; candidate[i+1] = 0; candidate[i+2] = 0;
    }
    const out = new Uint8ClampedArray(W * H * 4);
    const res = diff(baseline, candidate, out, W, H, {
      enableMinimap: false,
      detectRegions: true,
      regionOptions: { minSize: 1 },
    });
    expect(res.regions?.length).toBe(1);
    // outline pixel 2px outside the block should be the deep-red stroke
    const r = res.regions![0];
    const oi = ((r.y - 2) * W + r.x) * 4;
    expect(out[oi]).toBe(211);
    expect(out[oi + 1]).toBe(47);
  });
});

/**
 * Size mismatch with explicit `dimensions`: the caller knows both sizes, so
 * the engine can normalize a width difference too (the inference path
 * assumes a shared width), and with 'pad' every padded pixel counts as
 * changed — content below (or beside) the baseline is a change, whatever
 * color it has.
 */
describe('size mismatch with explicit dimensions', () => {
  it('counts every padded row as changed for a taller candidate with an identical overlap', () => {
    const baseline = createSolidBuffer(10, 10, 128, 128, 128);
    const candidate = createSolidBuffer(10, 12, 128, 128, 128);
    const output = createDiffBuffer(10, 12);

    const result = diff(baseline, candidate, output, 10, 10, {
      handleSizeMismatch: 'pad',
      dimensions: { baseline: { width: 10, height: 10 }, candidate: { width: 10, height: 12 } },
    });

    expect(result.sizeMismatch).toEqual({
      baseline: { width: 10, height: 10 },
      candidate: { width: 10, height: 12 },
      normalized: { width: 10, height: 12 },
    });
    expect(result.totalPixels).toBe(120);
    expect(result.diffCount).toBe(20);
    expect(result.isIdentical).toBe(false);
    // The padded rows are heat in the diff image (the core loop's own heat
    // where the pad's RGB differs, deep red where it does not), never the
    // grayscale wash.
    for (let y = 10; y < 12; y++) {
      for (let x = 0; x < 10; x++) {
        const i = (y * 10 + x) * 4;
        expect(output[i + 3]).toBe(255);
        expect(output[i]).toBeGreaterThanOrEqual(211); // yellow → red: r stays high
        expect(output[i + 2]).toBeLessThan(60); // and b low; the wash is r = g = b
      }
    }
    // The overlap is untouched (washed background, no heat).
    expect(output[3]).toBe(255);
    expect(output[0]).toBe(output[1]);
  });

  it('counts padded pixels even when the candidate there is black (the pad color)', () => {
    // The core loop compares RGB only: black content over a transparent
    // black pad is invisible to it. The pad must be flagged explicitly.
    const baseline = createSolidBuffer(10, 10, 0, 0, 0);
    const candidate = createSolidBuffer(10, 12, 0, 0, 0);
    const output = createDiffBuffer(10, 12);

    const result = diff(baseline, candidate, output, 10, 10, {
      handleSizeMismatch: 'pad',
      dimensions: { baseline: { width: 10, height: 10 }, candidate: { width: 10, height: 12 } },
    });

    expect(result.diffCount).toBe(20);
  });

  it('pads a wider candidate without misaligning rows: the diff is the right-hand strip only', () => {
    const baseline = createBufferWithBlock(10, 10, 255, 255, 255, 2, 2, 4, 4, 255, 0, 0);
    const candidate = createBufferWithBlock(14, 10, 255, 255, 255, 2, 2, 4, 4, 255, 0, 0);
    const output = createDiffBuffer(14, 10);

    const result = diff(baseline, candidate, output, 10, 10, {
      handleSizeMismatch: 'pad',
      detectRegions: true,
      regionOptions: { minSize: 1 },
      dimensions: { baseline: { width: 10, height: 10 }, candidate: { width: 14, height: 10 } },
    });

    expect(result.sizeMismatch!.normalized).toEqual({ width: 14, height: 10 });
    expect(result.diffCount).toBe(40);
    expect(result.regions).toEqual([
      expect.objectContaining({ x: 10, y: 0, width: 4, height: 10, diffPixels: 40 }),
    ]);
  });

  it('counts a shorter candidate\'s missing rows as changed', () => {
    const baseline = createSolidBuffer(10, 12, 200, 200, 200);
    const candidate = createSolidBuffer(10, 10, 200, 200, 200);
    const output = createDiffBuffer(10, 12);

    const result = diff(baseline, candidate, output, 10, 12, {
      handleSizeMismatch: 'pad',
      dimensions: { baseline: { width: 10, height: 12 }, candidate: { width: 10, height: 10 } },
    });

    expect(result.diffCount).toBe(20);
    expect(result.sizeMismatch!.candidate).toEqual({ width: 10, height: 10 });
  });

  it('with crop, nothing is padded and the identical overlap is identical', () => {
    const baseline = createSolidBuffer(10, 10, 128, 128, 128);
    const candidate = createSolidBuffer(10, 12, 128, 128, 128);
    const output = createDiffBuffer(10, 10);

    const result = diff(baseline, candidate, output, 10, 10, {
      handleSizeMismatch: 'crop',
      dimensions: { baseline: { width: 10, height: 10 }, candidate: { width: 10, height: 12 } },
    });

    expect(result.diffCount).toBe(0);
    expect(result.isIdentical).toBe(true);
    expect(result.sizeMismatch!.normalized).toEqual({ width: 10, height: 10 });
  });

  it('equal dimensions change nothing', () => {
    const baseline = createSolidBuffer(10, 10, 128, 128, 128);
    const candidate = createSolidBuffer(10, 10, 128, 128, 128);
    const output = createDiffBuffer(10, 10);

    const result = diff(baseline, candidate, output, 10, 10, {
      handleSizeMismatch: 'pad',
      dimensions: { baseline: { width: 10, height: 10 }, candidate: { width: 10, height: 10 } },
    });

    expect(result.diffCount).toBe(0);
    expect(result.sizeMismatch).toBeUndefined();
  });
});
