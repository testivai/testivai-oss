/**
 * elementIdAttributes — element paths anchored on attributes such as
 * `data-testid` (opt-in).
 *
 * Unit tests of the page-side collector against a duck-typed DOM (the same
 * function is serialised into the page). The real-browser checks (selector
 * round trip, byte-identical default output against the collector as it
 * was before this option, and the banner shift) are in
 * e2e/src/element-id-attributes.test.ts.
 */

import {
  buildElementMapExpression,
  collectElementMap,
  normalizeElementIdAttributes,
  type ElementLike,
} from '../capture/element-map';

interface FakeEl extends ElementLike {
  attrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  children: FakeEl[];
  parentElement: FakeEl | null;
  getAttribute(name: string): string | null;
}

function el(tag: string, opts: { cls?: string[]; attrs?: Record<string, string>; h?: number } = {}): FakeEl {
  const e: FakeEl = {
    tagName: tag.toUpperCase(),
    classList: opts.cls ?? [],
    attrs: opts.attrs ?? {},
    children: [],
    parentElement: null,
    rect: { x: 0, y: 0, width: 100, height: opts.h ?? 20 },
    getBoundingClientRect() {
      return this.rect;
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
  };
  return e;
}

function tree(parent: FakeEl, ...children: FakeEl[]): FakeEl {
  for (const c of children) {
    c.parentElement = parent;
    parent.children.push(c);
  }
  return parent;
}

const win = {
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};

function paths(body: FakeEl, ids?: string[], ignore: string[] = []): string[] {
  const out = ids === undefined
    ? collectElementMap({ body }, win, 3000, ignore)
    : collectElementMap({ body }, win, 3000, ignore, ids);
  return out.map((e) => e.path);
}

function pathOf(body: FakeEl, target: FakeEl, ids?: string[]): string {
  // Tag the target with a unique height so it can be found in the output.
  target.rect = { ...target.rect, height: 777 };
  const out = collectElementMap({ body }, win, 3000, [], ids ?? []);
  const found = out.filter((e) => e.height === 777);
  expect(found).toHaveLength(1);
  return found[0].path;
}

/** A react-native-web style page: atomic classes, every view a div. */
function rnwPage(withBanner: boolean) {
  const body = el('body', { h: 800 });
  const root = el('div', { attrs: { id: 'root' }, h: 800 });
  const app = el('div', { cls: ['css-g5y9jx'], h: 800 });
  const header = el('div', { cls: ['css-g5y9jx'], attrs: { 'data-testid': 'header' } });
  const title = el('div', { cls: ['css-146c3p1'] });
  const board = el('div', { cls: ['css-g5y9jx'], attrs: { 'data-testid': 'board' }, h: 300 });
  const tiles = [0, 1, 2].map((c) => el('div', { cls: ['css-g5y9jx'], attrs: { 'data-testid': `tile-r0-c${c}` } }));
  const tileText = el('div', { cls: ['css-146c3p1'] });
  const footer = el('div', { cls: ['css-g5y9jx'] });
  tree(body, tree(root, app));
  if (withBanner) tree(app, el('div', { cls: ['css-g5y9jx'], attrs: { 'data-testid': 'daily-banner' } }));
  tree(app, tree(header, title), tree(board, ...tiles), footer);
  tree(tiles[1], tileText);
  return { body, header, title, board, tiles, tileText, footer };
}

describe('elementIdAttributes: default output', () => {
  it('without the option, paths ignore the attribute entirely (the nth-of-type chain as before)', () => {
    const page = rnwPage(false);
    const expected = [
      'body',
      'body > div',
      'body > div > div.css-g5y9jx',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(1)',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(1) > div.css-146c3p1',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(2)',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(2) > div.css-g5y9jx:nth-of-type(1)',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(2) > div.css-g5y9jx:nth-of-type(2)',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(2) > div.css-g5y9jx:nth-of-type(2) > div.css-146c3p1',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(2) > div.css-g5y9jx:nth-of-type(3)',
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(3)',
    ];
    expect(paths(page.body)).toEqual(expected);
    expect(paths(page.body, [])).toEqual(expected);
  });

  it('an empty list reads no attribute at all', () => {
    const page = rnwPage(false);
    let reads = 0;
    const visit = (e: FakeEl) => {
      const original = e.getAttribute.bind(e);
      e.getAttribute = (name: string) => {
        reads++;
        return original(name);
      };
      e.children.forEach(visit);
    };
    visit(page.body);
    paths(page.body, []);
    expect(reads).toBe(0);
  });

  it('the page expression passes no fifth argument without the option', () => {
    const expr = buildElementMapExpression(3000, ['.ad']);
    expect(expr.endsWith(')(document, window, 3000, [".ad"])')).toBe(true);
    expect(buildElementMapExpression(3000, ['.ad'], [])).toBe(expr);
  });

  it('the page expression passes the attribute list when set', () => {
    const expr = buildElementMapExpression(3000, [], ['data-testid', 'data-test']);
    expect(expr.endsWith(')(document, window, 3000, [], ["data-testid","data-test"])')).toBe(true);
  });
});

describe('elementIdAttributes: anchored paths', () => {
  it('an element carrying the attribute is its own anchor: tag plus the attribute', () => {
    const page = rnwPage(false);
    expect(pathOf(page.body, page.board, ['data-testid'])).toBe('div[data-testid="board"]');
  });

  it('a descendant is anchored on its nearest ancestor that carries the attribute', () => {
    const page = rnwPage(false);
    expect(pathOf(page.body, page.title, ['data-testid'])).toBe('div[data-testid="header"] > div.css-146c3p1');
    const p2 = rnwPage(false);
    expect(pathOf(p2.body, p2.tileText, ['data-testid'])).toBe('div[data-testid="tile-r0-c1"] > div.css-146c3p1');
  });

  it('elements with no anchor above them keep the full chain from body', () => {
    const page = rnwPage(false);
    expect(pathOf(page.body, page.footer, ['data-testid'])).toBe(
      'body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(3)',
    );
  });

  it('nested anchors: the nearest one wins', () => {
    const body = el('body');
    const outer = el('section', { attrs: { 'data-testid': 'outer' } });
    const inner = el('div', { attrs: { 'data-testid': 'inner' } });
    const leaf = el('span');
    tree(body, tree(outer, tree(inner, leaf)));
    expect(pathOf(body, leaf, ['data-testid'])).toBe('div[data-testid="inner"] > span');
  });

  it('inserting an element before anchored content keeps the anchored paths (the banner case)', () => {
    const ids = ['data-testid'];
    for (const key of ['header', 'title', 'board', 'tileText'] as const) {
      const before = rnwPage(false);
      const after = rnwPage(true);
      expect(pathOf(after.body, after[key], ids)).toBe(pathOf(before.body, before[key], ids));
    }
    // Without the option the same insertion renumbers them (the reported bug).
    const b = rnwPage(false);
    const a = rnwPage(true);
    expect(pathOf(a.body, a.board)).not.toBe(pathOf(b.body, b.board));
  });

  it('an empty attribute value is not an anchor', () => {
    const body = el('body');
    const a = el('div', { attrs: { 'data-testid': '' } });
    tree(body, a);
    expect(pathOf(body, a, ['data-testid'])).toBe('body > div');
  });

  it('every path is unique, anchored or not', () => {
    const page = rnwPage(true);
    const all = paths(page.body, ['data-testid']);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('elementIdAttributes: duplicate values', () => {
  function listPage() {
    const body = el('body');
    const list = el('ul', { attrs: { 'data-testid': 'list' } });
    const rows = [0, 1, 2].map(() => el('li', { attrs: { 'data-testid': 'row' } }));
    const labels = rows.map(() => el('span'));
    rows.forEach((r, i) => {
      tree(r, labels[i]);
    });
    tree(body, tree(list, ...rows));
    return { body, list, rows, labels };
  }

  it('a value used more than once in the document is not an anchor: the path falls back to the next anchor up', () => {
    const page = listPage();
    expect(pathOf(page.body, page.rows[1], ['data-testid'])).toBe('ul[data-testid="list"] > li:nth-of-type(2)');
    const p2 = listPage();
    expect(pathOf(p2.body, p2.labels[2], ['data-testid'])).toBe('ul[data-testid="list"] > li:nth-of-type(3) > span');
  });

  it('with no unique anchor above, the full chain from body applies', () => {
    const body = el('body');
    const a = el('div', { attrs: { 'data-testid': 'card' } });
    const b = el('div', { attrs: { 'data-testid': 'card' } });
    tree(body, a, b);
    expect(paths(body, ['data-testid'])).toEqual(['body', 'body > div:nth-of-type(1)', 'body > div:nth-of-type(2)']);
  });

  it('duplicates are counted over the whole document, including elements the map skips', () => {
    const body = el('body');
    const visible = el('div', { attrs: { 'data-testid': 'x' } });
    const tiny = el('i', { attrs: { 'data-testid': 'x' } });
    tiny.rect = { x: 0, y: 0, width: 1, height: 1 };
    const ignored = el('aside', { attrs: { 'data-testid': 'x', class: 'ad' } });
    (ignored as FakeEl & { matches(s: string): boolean }).matches = (s: string) => s === '.ad';
    tree(body, visible, tiny, ignored);
    // Two other elements carry the value, so neither the visible one's path
    // nor anything else depends on which of them the walk happened to keep.
    expect(pathOf(body, visible, ['data-testid'])).toBe('body > div');
  });

  it('paths stay unique with duplicates', () => {
    const page = listPage();
    const all = paths(page.body, ['data-testid']);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('elementIdAttributes: several attributes', () => {
  it('the first listed attribute the element carries wins', () => {
    const body = el('body');
    const both = el('div', { attrs: { 'data-testid': 'a', 'data-test': 'b' } });
    const second = el('p', { attrs: { 'data-test': 'c' } });
    tree(body, both, second);
    const ids = ['data-testid', 'data-test'];
    expect(pathOf(body, both, ids)).toBe('div[data-testid="a"]');
    expect(paths(body, ['data-test', 'data-testid'])).toContain('div[data-test="b"]');
    expect(paths(body, ids)).toContain('p[data-test="c"]');
  });

  it('a duplicated first attribute falls through to the next listed one on the same element', () => {
    const body = el('body');
    const a = el('div', { attrs: { 'data-testid': 'dup', 'data-test': 'one' } });
    const b = el('div', { attrs: { 'data-testid': 'dup', 'data-test': 'two' } });
    tree(body, a, b);
    expect(paths(body, ['data-testid', 'data-test'])).toEqual([
      'body',
      'div[data-test="one"]',
      'div[data-test="two"]',
    ]);
  });
});

describe('elementIdAttributes: escaping', () => {
  function single(value: string): string {
    const body = el('body');
    const a = el('div', { attrs: { 'data-testid': value } });
    tree(body, a);
    return pathOf(body, a, ['data-testid']);
  }

  it('escapes quotes and backslashes', () => {
    expect(single('say "hi"')).toBe('div[data-testid="say \\"hi\\""]');
    expect(single('a\\b')).toBe('div[data-testid="a\\\\b"]');
  });

  it('escapes newlines and other control characters as hex escapes', () => {
    expect(single('a\nb')).toBe('div[data-testid="a\\a b"]');
    expect(single('a\r\tb')).toBe('div[data-testid="a\\d \\9 b"]');
    expect(single('a\u007fb')).toBe('div[data-testid="a\\7f b"]');
  });

  it("escapes '>' so the ' > ' separator the report splits on stays unambiguous", () => {
    const p = single('a > b');
    expect(p).toBe('div[data-testid="a \\> b"]');
    expect(p.split(' > ')).toHaveLength(1);
  });

  it('keeps other characters, Unicode included, as they are', () => {
    expect(single("it's ✓ [1] #x .y")).toBe('div[data-testid="it\'s ✓ [1] #x .y"]');
  });

  it('a value containing NUL is not an anchor (no selector can match it)', () => {
    expect(single('a\u0000b')).toBe('body > div');
  });
});

describe('elementIdAttributes: attribute names', () => {
  it('the collector ignores names that are not plain attribute names', () => {
    const body = el('body');
    const a = el('div', { attrs: { 'data-testid': 'a', 'x"]': 'evil', 'data test': 'b', 'ns:id': 'c' } });
    tree(body, a);
    expect(pathOf(body, a, ['x"]', 'data test', '', 'ns:id'])).toBe('body > div');
    const b2 = el('body');
    const a2 = el('div', { attrs: { 'data-testid': 'a', 'x"]': 'evil' } });
    tree(b2, a2);
    expect(pathOf(b2, a2, ['x"]', 'data-testid'])).toBe('div[data-testid="a"]');
  });

  it('normalizeElementIdAttributes keeps valid names in order, once', () => {
    expect(normalizeElementIdAttributes(['data-testid', 'data-test', 'data-testid', 'x"]', '', 7, 'id', 'data_qa'])).toEqual([
      'data-testid',
      'data-test',
      'id',
      'data_qa',
    ]);
    expect(normalizeElementIdAttributes(undefined)).toEqual([]);
    expect(normalizeElementIdAttributes('data-testid')).toEqual([]);
  });
});
