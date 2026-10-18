/**
 * OSS E2E — capture provenance, through the public API.
 *
 *   1. A capture recorded in Chromium 130 is approved: its environment is
 *      frozen into the baseline's metadata.json.
 *   2. The same page is captured in Chromium 141, identical except for
 *      glyph-edge anti-aliasing pixels; DOM and element map identical.
 *   3. The report must call it rendering drift (the browser changed, not the
 *      page), never "likely render noise". A control pair with no recorded
 *      environment still reads as likely render noise.
 *   4. environmentPolicy "strict" turns the byte-identical case into a change.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { BaselineStore, generateReport, snapshotAnchorId } from '@testivai/witness';

const W = 240;
const H = 120;

function page(edgeNoise: boolean): Buffer {
  const png = new PNG({ width: W, height: H });
  png.data.fill(255);
  for (let y = 30; y < 70; y++) {
    for (let x = 20; x < 180; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = 30;
      png.data[i + 1] = 60;
      png.data[i + 2] = 200;
    }
  }
  if (edgeNoise) {
    // 30 isolated pixels: below the region noise floor, well under 1%.
    for (let n = 0; n < 30; n++) {
      const x = 190 + (n % 6) * 7;
      const y = 5 + Math.floor(n / 6) * 20;
      const i = (y * W + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = 215;
    }
  }
  return PNG.sync.write(png);
}

const HTML = '<html><body><main><div class="card">Card</div></main></body></html>';
const ELEMENTS = JSON.stringify([{ path: 'body > main > div.card', x: 20, y: 30, width: 160, height: 40, styleHash: 'aaaa1111' }]);

const env = (version: string) => ({
  os: { platform: process.platform, release: os.release(), arch: process.arch },
  browser: { name: 'chromium', version, headless: true },
  framework: { name: 'playwright', version: '1.64.1', language: 'typescript', runner: '@playwright/test' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.7', captureMethod: 'full-page:cdp' },
  render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
});

function capture(store: BaselineStore, root: string, name: string, png: Buffer, environment?: object) {
  store.writeTemp(name, png, HTML);
  fs.writeFileSync(path.join(root, '.testivai', 'temp', name, 'elements.json'), ELEMENTS);
  if (environment) store.writeTempMetadata(name, { name, environment });
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-provenance-'));
  try {
    const store = new BaselineStore(root);

    // 1. Baselines: one recorded in Chromium 130, one control with no environment.
    capture(store, root, 'pricing', page(false), env('130.0.6723.58'));
    capture(store, root, 'control', page(false));
    store.approve('pricing');
    store.approve('control');
    assert.strictEqual(store.readMetadata('pricing')?.environment?.browser.version, '130.0.6723.58', 'approve freezes the environment');
    assert.strictEqual(store.readMetadata('control')?.environment, undefined, 'no environment recorded, none frozen');
    store.clearTemp();

    // 2. Current captures: Chromium 141 with edge noise; the control with the same noise.
    capture(store, root, 'pricing', page(true), env('141.0.7390.37'));
    capture(store, root, 'control', page(true));

    // 3. Report.
    const data = generateReport({ projectRoot: root, autoOpen: false });
    assert.strictEqual(data.version, '2.5.0');
    const pricing = data.snapshots.find((s) => s.name === 'pricing')!;
    const control = data.snapshots.find((s) => s.name === 'control')!;
    assert.strictEqual(pricing.status, 'changed');
    assert.deepStrictEqual(pricing.dom && { changed: pricing.dom.changed, styleCheck: pricing.dom.styleCheck }, { changed: false, styleCheck: 'match' });
    assert.deepStrictEqual(pricing.environment?.renderingDelta, ['browser.version']);
    assert.strictEqual(control.environment, undefined);

    const html = fs.readFileSync(path.join(root, 'visual-report', 'index.html'), 'utf-8');
    // Each snapshot's card, found by its link target (snapshotAnchorId).
    const card = (name: string) => {
      const start = html.indexOf(`<div class="snapshot" id="${snapshotAnchorId(name)}">`);
      assert.notStrictEqual(start, -1, `no card for ${name} in the report`);
      const end = html.indexOf('<div class="snapshot" ', start + 1);
      return html.slice(start, end === -1 ? undefined : end);
    };
    assert.match(card('pricing'), /Rendering drift — the environment changed since the baseline \(chromium 130\.0\.6723\.58 → 141\.0\.7390\.37\)/);
    assert.doesNotMatch(card('pricing'), /Likely render noise/);
    assert.match(card('control'), /Likely render noise/);
    console.log('[e2e] ✓ A browser bump with edge noise reads as rendering drift; without provenance, as likely render noise.');

    // 4. strict: the byte-identical capture of a new browser is a change.
    fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ environmentPolicy: 'strict', autoOpen: false }));
    store.clearTemp();
    capture(store, root, 'pricing', page(false), env('141.0.7390.37'));
    const strict = generateReport({ projectRoot: root, autoOpen: false });
    const s = strict.snapshots.find((x) => x.name === 'pricing')!;
    assert.strictEqual(s.status, 'changed', 'strict: identical pixels, new browser → changed');
    assert.strictEqual(s.environment?.policy, 'strict');
    console.log('[e2e] ✓ environmentPolicy "strict" makes a byte-identical capture from a new browser a change.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Provenance E2E failed');
  console.error(err);
  process.exit(1);
});
