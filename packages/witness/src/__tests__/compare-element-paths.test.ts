/**
 * elementIdAttributes on the compare side: element maps are matched by
 * path, and the option changes the paths. A baseline captured with one
 * setting and a capture taken with another share only the elements no
 * anchor covers (body and the wrappers above the anchors), so comparing
 * their styles would be a verdict on a fraction of the page: a false
 * "match", which noiseAutoPass can turn into a pass. The capture records the
 * setting in metadata.json (only when set), approving freezes it into the
 * baseline, and styles are only compared when both sides used the same one.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaselineStore } from '../baselines/store';
import { compareAll } from '../report/compare';
import { makePng, RED } from './helpers/synth';

const W = 400;
const H = 300;

/** Small dots spread over the page: a small, scattered diff (the shape noiseAutoPass accepts). */
const DOTS = [
  { x: 10, y: 10 },
  { x: 380, y: 10 },
  { x: 10, y: 280 },
  { x: 380, y: 280 },
  { x: 200, y: 150 },
].map((p) => ({ rect: { ...p, width: 2, height: 2 }, color: RED }));

const DOM = '<html><body><div><div data-testid="board"><span>1</span></div></div></body></html>';

// The same page captured with and without anchors: the wrappers keep their
// paths, the anchored subtree does not. The board's style differs between
// the two maps, as if its colour changed.
const wrappers = [
  { path: 'body', x: 0, y: 0, width: W, height: H, styleHash: 'aaaa0001' },
  { path: 'body > div', x: 0, y: 0, width: W, height: H, styleHash: 'aaaa0002' },
];
const plainBoard = [{ path: 'body > div > div', x: 20, y: 20, width: 100, height: 100, styleHash: 'bbbb0001' }];
const anchoredBoard = [{ path: 'div[data-testid="board"]', x: 20, y: 20, width: 100, height: 100, styleHash: 'bbbb0002' }];

describe('compareAll: element paths captured with different elementIdAttributes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-ids-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(
    side: 'baselines' | 'temp',
    png: Buffer,
    elements: object[],
    idAttributes?: string[],
  ) {
    const dir = path.join(root, '.testivai', side, 'page');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'screenshot.png'), png);
    fs.writeFileSync(path.join(dir, 'dom.html'), DOM);
    fs.writeFileSync(path.join(dir, 'elements.json'), JSON.stringify(elements));
    const meta: Record<string, unknown> = { name: 'page' };
    if (side === 'baselines') Object.assign(meta, { createdAt: 'x', updatedAt: 'x' });
    if (idAttributes) meta.elementIdAttributes = idAttributes;
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
  }

  const run = () =>
    compareAll({
      projectRoot: root,
      reportDir: path.join(root, 'visual-report'),
      passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 1 },
    })[0];

  it('control: the same setting on both sides compares styles as usual (and the fixture is noise-shaped)', () => {
    write('baselines', makePng(W, H), [...wrappers, ...anchoredBoard], ['data-testid']);
    write('temp', makePng(W, H, undefined, DOTS), [...wrappers, { ...anchoredBoard[0], styleHash: 'bbbb0001' }], ['data-testid']);
    // Make the two anchored boards identical: the styles match.
    fs.writeFileSync(
      path.join(root, '.testivai', 'baselines', 'page', 'elements.json'),
      JSON.stringify([...wrappers, { ...anchoredBoard[0], styleHash: 'bbbb0001' }]),
    );
    const r = run();
    expect(r.dom?.styleCheck).toBe('match');
    expect(r.status).toBe('passed');
    expect(r.autoPassed).toBe('noise');
  });

  it('a baseline without the option and a capture with it: styles are not compared, and noiseAutoPass does not pass it', () => {
    write('baselines', makePng(W, H), [...wrappers, ...plainBoard]);
    write('temp', makePng(W, H, undefined, DOTS), [...wrappers, ...anchoredBoard], ['data-testid']);
    const r = run();
    // Comparing only the wrappers would say 'match' while the board's style changed.
    expect(r.dom?.styleCheck).toBe('unavailable');
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('the other way round (option turned off) is not compared either', () => {
    write('baselines', makePng(W, H), [...wrappers, ...anchoredBoard], ['data-testid']);
    write('temp', makePng(W, H, undefined, DOTS), [...wrappers, ...plainBoard]);
    expect(run().dom?.styleCheck).toBe('unavailable');
  });

  it('a different list or order (a different precedence) is a different setting', () => {
    write('baselines', makePng(W, H), [...wrappers, ...anchoredBoard], ['data-testid', 'data-test']);
    write('temp', makePng(W, H, undefined, DOTS), [...wrappers, ...anchoredBoard], ['data-test', 'data-testid']);
    expect(run().dom?.styleCheck).toBe('unavailable');
  });

  it('neither side recorded a setting (every capture before the option, or with it unset): compared as before', () => {
    write('baselines', makePng(W, H), [...wrappers, ...plainBoard]);
    write('temp', makePng(W, H, undefined, DOTS), [...wrappers, ...plainBoard]);
    const r = run();
    expect(r.dom?.styleCheck).toBe('match');
    expect(r.autoPassed).toBe('noise');
  });
});

describe('BaselineStore.approve and elementIdAttributes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-ids-approve-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('freezes the capture setting into the baseline metadata', () => {
    const store = new BaselineStore(root);
    store.writeTemp('page', makePng(10, 10));
    store.writeTempMetadata('page', { name: 'page', elementIdAttributes: ['data-testid'] });
    store.approve('page');
    expect(store.readMetadata('page')?.elementIdAttributes).toEqual(['data-testid']);
  });

  it('a capture without it leaves the baseline without it (no key at all)', () => {
    const store = new BaselineStore(root);
    store.writeTemp('page', makePng(10, 10));
    store.writeTempMetadata('page', { name: 'page', elementIdAttributes: ['data-testid'] });
    store.approve('page');
    store.clearTemp();
    store.writeTemp('page', makePng(10, 10));
    store.approve('page');
    const meta = store.readMetadata('page');
    expect(meta && 'elementIdAttributes' in meta).toBe(false);
  });
});
