/**
 * makeShiftCheck: is a claimed shift the same content, moved? Element maps
 * pair baseline and candidate elements by path, and a path renumbered by
 * inserted content can pair an element with a look-alike neighbour (same
 * size, same styles, different text). The pixels tell them apart: the same
 * content moved matches at the new position, a neighbour does not.
 */
import { makeShiftCheck, SHIFT_PIXEL_TOLERANCE } from '../report/shift-check';
import { paintRect, solidRgba, type RGBA } from './helpers/synth';

const W = 200;
const H = 300;
const GREY: RGBA = [240, 240, 240, 255];
const INK: RGBA = [20, 20, 20, 255];

/** A white page with grey cards; each card has a dark "text" bar whose width is the card's content. */
function page(cards: Array<{ y: number; text: number }>) {
  const data = solidRgba(W, H);
  for (const c of cards) {
    paintRect(data, W, H, { x: 10, y: c.y, width: 180, height: 40 }, GREY);
    paintRect(data, W, H, { x: 20, y: c.y + 15, width: c.text, height: 10 }, INK);
  }
  return { data, width: W, height: H };
}

const card = (y: number) => ({ x: 10, y, width: 180, height: 40 });

describe('makeShiftCheck', () => {
  it('the same content moved is a shift', () => {
    const baseline = page([{ y: 20, text: 100 }, { y: 80, text: 60 }]);
    const current = page([{ y: 70, text: 100 }, { y: 130, text: 60 }]);
    const check = makeShiftCheck(baseline, current, 0.1);
    expect(check(card(20), card(70))).toBe(true);
    expect(check(card(80), card(130))).toBe(true);
  });

  it('a look-alike neighbour with different content is not', () => {
    // Baseline card 2 (text 60) paired with current card 1 moved down (text 100).
    const baseline = page([{ y: 20, text: 100 }, { y: 80, text: 60 }]);
    const current = page([{ y: 70, text: 100 }, { y: 130, text: 60 }]);
    const check = makeShiftCheck(baseline, current, 0.1);
    expect(check(card(80), card(70))).toBe(false);
  });

  it('absorbs a 1 px difference between the rounded rects and where the content was drawn', () => {
    const baseline = page([{ y: 20, text: 100 }]);
    const current = page([{ y: 71, text: 100 }]);
    expect(makeShiftCheck(baseline, current, 0.1)(card(20), card(70))).toBe(true);
  });

  it('pixels under a mask are not compared', () => {
    const baseline = page([{ y: 20, text: 100 }]);
    const current = page([{ y: 70, text: 40 }]);
    const unmasked = makeShiftCheck(baseline, current, 0.1);
    expect(unmasked(card(20), card(70))).toBe(false);
    // Mask both text bars (where they sit on each side).
    const masks = [{ x: 20, y: 35, width: 100, height: 10 }, { x: 20, y: 85, width: 100, height: 10 }];
    expect(makeShiftCheck(baseline, current, 0.1, masks)(card(20), card(70))).toBe(true);
  });

  it('a difference within the tolerance still matches; one beyond it does not', () => {
    const base = page([{ y: 20, text: 100 }]);
    const area = 180 * 40;
    const within = Math.floor(area * SHIFT_PIXEL_TOLERANCE * 0.5);
    const beyond = Math.ceil(area * SHIFT_PIXEL_TOLERANCE * 3);
    const near = page([{ y: 70, text: 100 }]);
    paintRect(near.data, W, H, { x: 150, y: 72, width: within, height: 1 }, INK);
    const far = page([{ y: 70, text: 100 }]);
    paintRect(far.data, W, H, { x: 10, y: 72, width: 180, height: Math.ceil(beyond / 180) }, INK);
    expect(makeShiftCheck(base, near, 0.1)(card(20), card(70))).toBe(true);
    expect(makeShiftCheck(base, far, 0.1)(card(20), card(70))).toBe(false);
  });

  it('nothing comparable (outside both images): no evidence against the map', () => {
    const baseline = page([]);
    const current = page([]);
    expect(makeShiftCheck(baseline, current, 0.1)({ x: 10, y: 400, width: 50, height: 20 }, { x: 10, y: 500, width: 50, height: 20 })).toBe(true);
  });

  it('answers the same pair once (cached)', () => {
    const baseline = page([{ y: 20, text: 100 }]);
    const current = page([{ y: 70, text: 100 }]);
    const check = makeShiftCheck(baseline, current, 0.1);
    const reads = { n: 0 };
    const counting = new Proxy(current.data, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.n++;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const check2 = makeShiftCheck(baseline, { ...current, data: counting }, 0.1);
    expect(check(card(20), card(70))).toBe(true);
    check2(card(20), card(70));
    const first = reads.n;
    check2(card(20), card(70));
    expect(reads.n).toBe(first);
  });
});
