/**
 * OSS Smoke E2E
 *
 * Exercises the public API surface of @testivai/witness end-to-end without
 * launching a browser:
 *
 *   1. Use BaselineStore to write a baseline + a temp screenshot
 *   2. Use generateReport() to produce results.json + index.html
 *   3. Assert the report content reflects passed and changed states
 *   4. Verify @testivai/witness-playwright entry points load
 *
 * This validates that the published packages link together correctly and the
 * documented public APIs work as advertised.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';

import { PNG } from 'pngjs';
import { BaselineStore, generateReport, diff, domDiff } from '@testivai/witness';

function makeRgbaPng(width: number, height: number, fill: [number, number, number, number]): Buffer {
  // Create a "fake" PNG buffer that's actually raw RGBA. The OSS report
  // pipeline does a quick byte-equal check first and falls back to the diff
  // engine when bytes differ. This is sufficient for an E2E smoke test of
  // the public surface — we don't need to round-trip a real PNG.
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4 + 0] = fill[0];
    buf[i * 4 + 1] = fill[1];
    buf[i * 4 + 2] = fill[2];
    buf[i * 4 + 3] = fill[3];
  }
  return buf;
}

/** A real PNG: white, with one blue card per 100px row band. */
function makeCardsPng(width: number, height: number, cards: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (let c = 0; c < cards; c++) {
    for (let y = 20 + c * 100; y < 80 + c * 100; y++) {
      for (let x = 20; x < width - 20; x++) {
        const i = (y * width + x) * 4;
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

const cardsHtml = (count: number): string =>
  `<html><body><main class="cards">${Array.from(
    { length: count },
    (_, i) => `<article class="card"><h3>Card ${i + 1}</h3><p>Description ${i + 1}</p><span class="price">$${i + 1}.00</span></article>`,
  ).join('')}</main></body></html>`;

async function main(): Promise<void> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-'));
  console.log(`[e2e] Using temp project root: ${projectRoot}`);

  try {
    // 1. Sanity-check the diff engine export
    const a = new Uint8ClampedArray(16);
    const b = new Uint8ClampedArray(16);
    const out = new Uint8ClampedArray(16);
    const result = diff(a, b, out, 2, 2, { threshold: 0.1 });
    assert.strictEqual(typeof result.diffCount, 'number', 'diff() should return DiffResult');
    assert.strictEqual(result.isIdentical, true, 'identical buffers should be identical');

    // 2. Use BaselineStore to seed baselines + temps
    const store = new BaselineStore(projectRoot);

    // Identical snapshot (passed)
    const greenBaseline = makeRgbaPng(8, 8, [0, 255, 0, 255]);
    store.write('snapshot-passed', greenBaseline);
    store.writeTemp('snapshot-passed', greenBaseline);

    // Changed snapshot, no DOM data on either side → no DOM signal
    const redBaseline = makeRgbaPng(8, 8, [255, 0, 0, 255]);
    const blueCurrent = makeRgbaPng(8, 8, [0, 0, 255, 255]);
    store.write('snapshot-changed', redBaseline);
    store.writeTemp('snapshot-changed', blueCurrent);

    // Changed pixels but DOM is identical → noise hint should fire
    const yellowBaseline = makeRgbaPng(8, 8, [255, 255, 0, 255]);
    const yellowishCurrent = makeRgbaPng(8, 8, [254, 255, 0, 255]);
    const stableHtml = '<html><body><h1 class="hero">Hello</h1></body></html>';
    store.write('snapshot-noise', yellowBaseline, undefined, stableHtml);
    store.writeTemp('snapshot-noise', yellowishCurrent, stableHtml);

    // Changed pixels AND DOM differs → DOM-changed hint with summary
    const purpleBaseline = makeRgbaPng(8, 8, [128, 0, 128, 255]);
    const purpleCurrent = makeRgbaPng(8, 8, [200, 0, 200, 255]);
    const beforeHtml = '<html><body><h1>One</h1></body></html>';
    const afterHtml = '<html><body><h1>One</h1><h1>Two</h1></body></html>';
    store.write('snapshot-dom-change', purpleBaseline, undefined, beforeHtml);
    store.writeTemp('snapshot-dom-change', purpleCurrent, afterHtml);

    // A page that GREW: three cards in a 200×300 baseline, a fourth card
    // appended → 200×400 current, identical overlap. Used to pass at 0%.
    store.write('snapshot-taller', makeCardsPng(200, 300, 3), undefined, cardsHtml(3));
    store.writeTemp('snapshot-taller', makeCardsPng(200, 400, 4), cardsHtml(4));

    // New snapshot (no baseline)
    store.writeTemp('snapshot-new', makeRgbaPng(8, 8, [128, 128, 128, 255]));

    assert.deepStrictEqual(
      store.list().sort(),
      ['snapshot-changed', 'snapshot-dom-change', 'snapshot-noise', 'snapshot-passed', 'snapshot-taller'],
      'baseline list should match seeded baselines',
    );
    assert.deepStrictEqual(
      store.listTemp().sort(),
      ['snapshot-changed', 'snapshot-dom-change', 'snapshot-new', 'snapshot-noise', 'snapshot-passed', 'snapshot-taller'],
      'temp list should match seeded temps',
    );

    // Quick sanity check on the DOM diff helper itself
    const noChange = domDiff(stableHtml, stableHtml);
    assert.strictEqual(noChange.domChanged, false, 'identical DOM should report no change');
    const realChange = domDiff(beforeHtml, afterHtml);
    assert.strictEqual(realChange.domChanged, true, 'differing DOM should report change');
    assert.strictEqual(realChange.summary?.added, 1, 'one h1 added');

    // 3. Generate the local HTML report
    const reportData = generateReport({
      projectRoot,
      reportDir: 'visual-report',
      threshold: 0.1,
      autoOpen: false,
    });

    assert.strictEqual(reportData.summary.total, 6, 'should report 6 snapshots');
    assert.strictEqual(reportData.summary.passed, 1, 'should report 1 passed');
    assert.strictEqual(reportData.summary.changed, 4, 'should report 4 changed');
    assert.strictEqual(reportData.summary.newSnapshots, 1, 'should report 1 new');

    const reportDir = path.join(projectRoot, 'visual-report');
    assert.ok(fs.existsSync(path.join(reportDir, 'index.html')), 'index.html should exist');
    assert.ok(fs.existsSync(path.join(reportDir, 'results.json')), 'results.json should exist');

    const html = fs.readFileSync(path.join(reportDir, 'index.html'), 'utf-8');
    assert.ok(html.length > 100, 'index.html should be non-trivial');
    assert.ok(html.includes('DOM unchanged'), 'noise hint badge should appear in HTML report');
    assert.ok(html.includes('DOM changed'), 'dom-changed badge should appear in HTML report');

    const resultsJson = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));
    assert.strictEqual(resultsJson.snapshots.length, 6);
    assert.strictEqual(resultsJson.version, '2.6.0', 'results.json should carry schema 2.6.0');

    const byName = Object.fromEntries(resultsJson.snapshots.map((s: any) => [s.name, s]));

    // snapshot-changed has no DOM data on either side → no DOM block
    assert.strictEqual(byName['snapshot-changed'].dom, undefined, 'snapshot without DOM data should have no dom field');

    // snapshot-noise: pixels differ, DOM same → noiseHint true
    assert.ok(byName['snapshot-noise'].dom, 'snapshot-noise should have a dom signal');
    assert.strictEqual(byName['snapshot-noise'].dom.changed, false);
    assert.strictEqual(byName['snapshot-noise'].dom.noiseHint, true);

    // snapshot-dom-change: pixels differ, DOM differs → noiseHint false, summary populated
    assert.ok(byName['snapshot-dom-change'].dom, 'snapshot-dom-change should have a dom signal');
    assert.strictEqual(byName['snapshot-dom-change'].dom.changed, true);
    assert.strictEqual(byName['snapshot-dom-change'].dom.noiseHint, false);
    assert.strictEqual(byName['snapshot-dom-change'].dom.summary.added, 1);

    // snapshot-taller: the page grew → changed, never passed, with both sizes
    // and the DOM additions; the report row and verdict say so
    const taller = byName['snapshot-taller'];
    assert.strictEqual(taller.status, 'changed', 'a taller capture with an identical overlap must be changed');
    assert.strictEqual(taller.autoPassed, undefined, 'a taller capture is never auto-passed');
    assert.deepStrictEqual(
      taller.sizeMismatch,
      { baseline: { width: 200, height: 300 }, candidate: { width: 200, height: 400 } },
      'sizeMismatch records both sizes',
    );
    assert.strictEqual(taller.totalPixels, 200 * 400, 'the diff canvas is the larger size');
    assert.strictEqual(taller.diffCount, 200 * 100, 'every padded pixel counts as changed');
    assert.strictEqual(taller.dom.changed, true);
    assert.strictEqual(taller.dom.summary.added, 4, 'the appended card adds 4 elements');
    assert.ok(html.includes('baseline 200×300 → current 200×400 (+100 px)'), 'report row should show both sizes');
    assert.ok(html.includes('page grew 100 px'), 'report verdict should say the page grew');

    // 4. Verify @testivai/witness-playwright entry points load (no browser)
    //    We dynamically require to avoid TS path lookup issues if not built yet.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const playwrightSdk = require('@testivai/witness-playwright');
    assert.ok(playwrightSdk.testivai, '@testivai/witness-playwright should export `testivai`');
    assert.strictEqual(typeof playwrightSdk.testivai.witness, 'function', 'testivai.witness should be a function');

    // 5. Verify @testivai/witness-webdriverio entry points load
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wdioSdk = require('@testivai/witness-webdriverio');
    assert.ok(wdioSdk.testivai, '@testivai/witness-webdriverio should export `testivai`');
    assert.strictEqual(typeof wdioSdk.testivai.witness, 'function', 'wdio testivai.witness should be a function');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wdioSvc = require('@testivai/witness-webdriverio/service');
    assert.ok(wdioSvc.TestivaiService, '@testivai/witness-webdriverio/service should export TestivaiService');
    assert.strictEqual(typeof wdioSvc.TestivaiService, 'function', 'TestivaiService should be a class');
    assert.strictEqual(typeof new wdioSvc.TestivaiService().onComplete, 'function', 'service should expose onComplete');

    console.log('[e2e] ✓ All smoke checks passed.');
  } finally {
    // Clean up temp directory
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Smoke E2E failed');
  console.error(err);
  process.exit(1);
});
