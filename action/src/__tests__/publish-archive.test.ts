/**
 * Reading a report artifact (a ZIP) someone else's CI run uploaded.
 *
 * Only what the published report is rebuilt from is read: results.json,
 * the run stamp (testivai-run.json) and the baseline/current/diff PNGs under
 * images/. Everything else, the artifact's own index.html included, is never
 * decompressed. Every entry is size-checked as it inflates, and the whole
 * archive is refused as soon as one is over its limit, so a crafted ZIP (a
 * "zip bomb", or one that understates its sizes) cannot exhaust the runner.
 */

import { zipSync, strToU8 } from 'fflate';
import { ArchiveRefused, readReportArchive, type ArchiveLimits } from '../publish/archive';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const LIMITS: ArchiveLimits = { maxEntries: 100, maxTotalBytes: 4 * 1024 * 1024, maxImageBytes: 1024 * 1024, maxJsonBytes: 256 * 1024 };

function zip(files: Record<string, Uint8Array | string>, level: 0 | 6 = 6): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, data] of Object.entries(files)) {
    entries[name] = [typeof data === 'string' ? strToU8(data) : data, { level }];
  }
  return zipSync(entries);
}

describe('readReportArchive', () => {
  it('reads results.json, the run stamp and the report images, and nothing else', () => {
    const archive = readReportArchive(
      zip({
        'results.json': '{"version":"2.5.0"}',
        'testivai-run.json': '{"runId":"1","runAttempt":1}',
        'index.html': '<script>alert(1)</script>',
        'images/home/baseline.png': PNG,
        'images/home/current.png': PNG,
        'images/home/diff.png': PNG,
        'images/checkout/step-2/current.png': PNG,
        'images/home/notes.png': PNG,
        'pending-baselines/home/screenshot.png': PNG,
        'evil.js': 'x',
      }),
      LIMITS,
    );

    expect(new TextDecoder().decode(archive.results)).toBe('{"version":"2.5.0"}');
    expect(new TextDecoder().decode(archive.runStamp)).toBe('{"runId":"1","runAttempt":1}');
    expect([...archive.images.keys()].sort()).toEqual([
      'images/checkout/step-2/current.png',
      'images/home/baseline.png',
      'images/home/current.png',
      'images/home/diff.png',
    ]);
    expect(archive.images.get('images/home/diff.png')).toEqual(PNG);
  });

  it('reads the thumbnail (thumb.png) with the other report images', () => {
    const archive = readReportArchive(
      zip({ 'results.json': '{}', 'images/home/thumb.png': PNG, 'images/home/thumbnail.png': PNG, 'images/home/thumb.png.html': PNG }),
      LIMITS,
    );

    expect([...archive.images.keys()]).toEqual(['images/home/thumb.png']);
  });

  it('reads stored (uncompressed) entries too', () => {
    const archive = readReportArchive(zip({ 'results.json': '{}', 'images/a/current.png': PNG }, 0), LIMITS);

    expect(archive.results).toBeDefined();
    expect(archive.images.get('images/a/current.png')).toEqual(PNG);
  });

  it.each([
    'images/../../etc/current.png',
    'images/a/../b/current.png',
    'images/./a/current.png',
    '/images/a/current.png',
    'images\\a\\current.png',
    'images//current.png',
    'images/a/current.png/',
    'Images/a/current.png',
  ])('ignores an image path that is not a plain relative path: %s', (name) => {
    const archive = readReportArchive(zip({ 'results.json': '{}', [name]: PNG }), LIMITS);

    expect(archive.images.size).toBe(0);
  });

  it('has no results when the archive has no results.json', () => {
    expect(readReportArchive(zip({ 'images/a/current.png': PNG }), LIMITS).results).toBeUndefined();
  });

  it('refuses an image over its limit by its declared size, before inflating it', () => {
    const big = new Uint8Array(LIMITS.maxImageBytes + 1);
    expect(() => readReportArchive(zip({ 'images/a/current.png': big }), LIMITS)).toThrow(/current\.png is 1048577 bytes, over/);
  });

  it('refuses results.json over its limit', () => {
    const big = '{' + ' '.repeat(LIMITS.maxJsonBytes) + '}';
    expect(() => readReportArchive(zip({ 'results.json': big }), LIMITS)).toThrow(/results\.json/);
  });

  it('refuses an archive whose images add up to more than its total', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) files[`images/s${i}/current.png`] = new Uint8Array(900 * 1024);
    expect(() => readReportArchive(zip(files), LIMITS)).toThrow(ArchiveRefused);
  });

  it('refuses an archive with too many entries', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < LIMITS.maxEntries + 1; i++) files[`x/${i}.txt`] = 'x';
    expect(() => readReportArchive(zip(files), LIMITS)).toThrow(/entries/);
  });

  it('stops a zip bomb that understates its size, after inflating little more than the limit', () => {
    // 64 MB of zeros compresses to ~64 KB. The headers are patched to claim 11
    // bytes, so only the bytes actually inflated can give it away.
    const bomb = zip({ 'images/a/current.png': new Uint8Array(64 * 1024 * 1024) });
    understateSizes(bomb, 11);

    const started = Date.now();
    expect(() => readReportArchive(bomb, LIMITS)).toThrow(ArchiveRefused);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops it on the entry's own limit, whatever the total allows", () => {
    const bomb = zip({ 'images/a/current.png': new Uint8Array(64 * 1024 * 1024) });
    understateSizes(bomb, 11);

    let message = '';
    try {
      readReportArchive(bomb, { ...LIMITS, maxTotalBytes: 1024 * 1024 * 1024 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/inflates past the 1048576-byte limit/);
    // Fed in small slices, it stops within one slice's worth of inflation:
    // far short of the 64 MB it would reach if inflated in one go.
    const stoppedAfter = Number(/stopped after (\d+) bytes/.exec(message)?.[1]);
    expect(stoppedAfter).toBeLessThan(32 * 1024 * 1024);
  });

  it('never decompresses entries it does not read', () => {
    // A bomb under a name the report never uses is skipped, not inflated.
    const archive = readReportArchive(
      zip({ 'results.json': '{}', 'pending-baselines/a/screenshot.png': new Uint8Array(64 * 1024 * 1024) }),
      LIMITS,
    );

    expect(archive.results).toBeDefined();
  });
});

/** Rewrite every local and central header's uncompressed size (ZIP APPNOTE 4.3.7, 4.3.12). */
function understateSizes(data: Uint8Array, size: number): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i + 4 <= data.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) view.setUint32(i + 22, size, true); // local file header
    if (sig === 0x02014b50) view.setUint32(i + 24, size, true); // central directory header
  }
}
