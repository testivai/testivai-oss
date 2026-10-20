/**
 * A project whose captures and baselines record no capture health, the way
 * every capture did before it was recorded (and the WebdriverIO, Selenium,
 * Python, Ruby and Java adapters still do): one snapshot per reading the
 * compare gives. Its results.json must stay byte-identical to the one the
 * code before capture health wrote (fixtures/no-health.results.json).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BLUE, encodePng, paintRect, RED, solidRgba } from './synth';

const W = 200;
const H = 100;
const DATE = '2026-10-01T00:00:00.000Z';

const ENV = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
  browser: { name: 'chromium', version: '130.0.6723.58', headless: true },
  framework: { name: 'playwright', version: '1.48.2', language: 'typescript', runner: '@playwright/test' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
  render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
};
const ENV_141 = { ...ENV, browser: { ...ENV.browser, version: '141.0.7390.37' } };

function card(width = W, height = H, color = BLUE): Uint8ClampedArray {
  const data = solidRgba(width, height);
  paintRect(data, width, height, { x: 20, y: 20, width: 120, height: 40 }, color);
  return data;
}

/** 30 isolated glyph-edge pixels nudged: scattered, below the region floor. */
function edgeNoise(): Uint8ClampedArray {
  const data = card();
  for (let i = 0; i < 30; i++) {
    const x = 150 + (i % 6) * 7;
    const y = 5 + Math.floor(i / 6) * 17;
    const at = (y * W + x) * 4;
    data[at] = 215;
    data[at + 1] = 215;
    data[at + 2] = 215;
  }
  return data;
}

const HTML = '<html><body><main><div class="card">Card</div></main></body></html>';
const HTML_CHANGED = '<html><body><main><div class="card">Card</div><p>New</p></main></body></html>';
const elements = (styleHash: string) =>
  JSON.stringify([{ path: 'body > main > div.card', x: 20, y: 20, width: 120, height: 40, styleHash }]);

interface Side {
  png: Buffer;
  dom?: string;
  elements?: string;
  environment?: object;
}

function write(root: string, name: string, baseline: Side | null, candidate: Side): void {
  const tDir = path.join(root, '.testivai', 'temp', name);
  fs.mkdirSync(tDir, { recursive: true });
  fs.writeFileSync(path.join(tDir, 'screenshot.png'), candidate.png);
  if (candidate.dom) fs.writeFileSync(path.join(tDir, 'dom.html'), candidate.dom);
  if (candidate.elements) fs.writeFileSync(path.join(tDir, 'elements.json'), candidate.elements);
  if (candidate.environment) fs.writeFileSync(path.join(tDir, 'metadata.json'), JSON.stringify({ name, environment: candidate.environment }));
  if (!baseline) return;
  const bDir = path.join(root, '.testivai', 'baselines', name);
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, 'screenshot.png'), baseline.png);
  if (baseline.dom) fs.writeFileSync(path.join(bDir, 'dom.html'), baseline.dom);
  if (baseline.elements) fs.writeFileSync(path.join(bDir, 'elements.json'), baseline.elements);
  fs.writeFileSync(
    path.join(bDir, 'metadata.json'),
    JSON.stringify({ name, createdAt: DATE, updatedAt: DATE, ...(baseline.environment ? { environment: baseline.environment } : {}) }),
  );
}

/** Writes the project under `root`, with noiseAutoPass on so the noise auto-pass is covered too. */
export function writeNoHealthProject(root: string): void {
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ noiseAutoPass: true, autoOpen: false }));
  const base: Side = { png: encodePng(card(), W, H), dom: HTML, elements: elements('aaaa1111'), environment: ENV };

  write(root, 'identical', base, base);
  write(root, 'noise', base, { ...base, png: encodePng(edgeNoise(), W, H) });
  write(root, 'styles-not-compared', { ...base, elements: undefined }, { ...base, elements: undefined, png: encodePng(edgeNoise(), W, H) });
  write(root, 'style-only', base, { ...base, elements: elements('bbbb2222'), png: encodePng(card(W, H, RED), W, H) });
  write(root, 'structural', base, { ...base, dom: HTML_CHANGED, png: encodePng(card(W, H, RED), W, H) });
  write(root, 'taller', base, { ...base, png: encodePng(card(W, H + 40), W, H + 40) });
  write(root, 'drift', base, { ...base, environment: ENV_141, png: encodePng(edgeNoise(), W, H) });
  write(root, 'first-capture', null, base);
}
