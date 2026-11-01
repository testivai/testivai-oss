/**
 * compareAll: a banner inserted above look-alike cards. With default element
 * paths the banner renumbers every `:nth-of-type` below it, and each card is
 * paired with its neighbour: same size, same styles, different content. That
 * used to read as a shift by a wrong distance, and a wrong page shift
 * (measured on react-native-web: −16 px while the content moved +64 px).
 * compareAll confirms every claimed move against the pixels.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compareAll } from '../report/compare';
import { makePng, type RGBA } from './helpers/synth';

const W = 200;
const H = 330;
const GREY: RGBA = [240, 240, 240, 255];
const INK: RGBA = [20, 20, 20, 255];
const GOLD: RGBA = [255, 224, 138, 255];
const TEXT = [120, 60, 150, 90];

/** Cards at the given tops; card i's dark bar (its "text") is TEXT[i] wide. */
function screen(tops: number[], banner: boolean): Buffer {
  const rects = tops.flatMap((y, i) => [
    { rect: { x: 10, y, width: 180, height: 40 }, color: GREY },
    { rect: { x: 20, y: y + 15, width: TEXT[i], height: 10 }, color: INK },
  ]);
  if (banner) rects.unshift({ rect: { x: 0, y: 0, width: W, height: 50 }, color: GOLD });
  return makePng(W, H, undefined, rects);
}

const BASE_TOPS = [20, 80, 140, 200];
const CAND_TOPS = BASE_TOPS.map((y) => y + 50);

function cards(tops: number[], pathOf: (i: number) => string) {
  return tops.map((y, i) => ({ path: pathOf(i), x: 10, y, width: 180, height: 40, styleHash: 'card' }));
}

describe('compareAll confirms shifts against the pixels', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-shiftcheck-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(baselineMap: object[], candidateMap: object[]) {
    for (const [side, png, map] of [
      ['baselines', screen(BASE_TOPS, false), baselineMap],
      ['temp', screen(CAND_TOPS, true), candidateMap],
    ] as const) {
      const dir = path.join(root, '.testivai', side, 'page');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'screenshot.png'), png);
      fs.writeFileSync(path.join(dir, 'elements.json'), JSON.stringify(map));
    }
    return compareAll({ projectRoot: root, reportDir: path.join(root, 'visual-report') })[0];
  }

  it('renumbered paths pair look-alike neighbours: no shift and no page shift is claimed', () => {
    // Baseline cards are div 1–4; the banner is div 1 in the candidate, so card k is div k+1.
    const baseline = cards(BASE_TOPS, (i) => `body > div:nth-of-type(${i + 1})`);
    const candidate = [
      { path: 'body > div:nth-of-type(1)', x: 0, y: 0, width: W, height: 50, styleHash: 'banner' },
      ...cards(CAND_TOPS, (i) => `body > div:nth-of-type(${i + 2})`),
    ];
    const r = run(baseline, candidate);
    expect(r.status).toBe('changed');
    const regions = r.regions ?? [];
    expect(regions.length).toBeGreaterThan(0);
    // Without the check: card 1 (moved to 70) paired with card 2 (at 80) read as a shift of -10.
    expect(regions.filter((x) => x.classification === 'shift')).toEqual([]);
    expect(r.pageShift).toBeUndefined();
  });

  it('control: the same move with stable paths is confirmed as a shift by the banner height', () => {
    const pathOf = (i: number) => `div[data-testid="card-${i}"]`;
    const r = run(cards(BASE_TOPS, pathOf), [
      { path: 'div[data-testid="banner"]', x: 0, y: 0, width: W, height: 50, styleHash: 'banner' },
      ...cards(CAND_TOPS, pathOf),
    ]);
    const shifts = (r.regions ?? []).filter((x) => x.classification === 'shift');
    expect(shifts.length).toBeGreaterThan(0);
    for (const s of shifts) expect(s.shift).toEqual({ dx: 0, dy: 50 });
    expect(r.pageShift).toMatchObject({ dy: 50, count: 4 });
  });
});
