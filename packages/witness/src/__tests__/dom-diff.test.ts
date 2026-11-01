import { domDiff } from '../diff/dom-diff';

describe('domDiff', () => {
  describe('fast paths', () => {
    test('returns no signal when both inputs are missing', () => {
      expect(domDiff(null, null)).toEqual({ domChanged: false, summary: null });
      expect(domDiff(undefined, undefined)).toEqual({ domChanged: false, summary: null });
      expect(domDiff('', '')).toEqual({ domChanged: false, summary: null });
    });

    test('returns no signal when only one side has DOM data', () => {
      expect(domDiff('<div></div>', null)).toEqual({ domChanged: false, summary: null });
      expect(domDiff(null, '<div></div>')).toEqual({ domChanged: false, summary: null });
    });

    test('returns no signal for byte-identical input', () => {
      const html = '<html><body><h1 class="hero">Hi</h1></body></html>';
      expect(domDiff(html, html)).toEqual({ domChanged: false, summary: null });
    });
  });

  describe('structural changes', () => {
    test('detects added elements', () => {
      const baseline = '<div><p>One</p></div>';
      const candidate = '<div><p>One</p><p>Two</p></div>';
      const result = domDiff(baseline, candidate);
      expect(result.domChanged).toBe(true);
      // the new <p>'s text ("Two") also registers as a text change
      expect(result.summary).toEqual({ added: 1, removed: 0, attributeChanges: 0, textChanges: 1 });
    });

    test('detects removed elements', () => {
      const baseline = '<div><p>One</p><p>Two</p></div>';
      const candidate = '<div><p>One</p></div>';
      const result = domDiff(baseline, candidate);
      expect(result.domChanged).toBe(true);
      expect(result.summary).toEqual({ added: 0, removed: 1, attributeChanges: 0, textChanges: 1 });
    });

    test('detects mixed add/remove (different tag types)', () => {
      const baseline = '<div><p>One</p></div>';
      const candidate = '<div><span>One</span></div>';
      const result = domDiff(baseline, candidate);
      expect(result.domChanged).toBe(true);
      // p removed, span added
      expect(result.summary?.added).toBe(1);
      expect(result.summary?.removed).toBe(1);
    });
  });

  describe('attribute changes', () => {
    test('detects attribute value change on otherwise-identical structure', () => {
      const baseline = '<button class="primary">Go</button>';
      const candidate = '<button class="secondary">Go</button>';
      const result = domDiff(baseline, candidate);
      expect(result.domChanged).toBe(true);
      expect(result.summary).toEqual({ added: 0, removed: 0, attributeChanges: 1, textChanges: 0 });
    });

    test('detects added attribute', () => {
      const baseline = '<a href="/foo">x</a>';
      const candidate = '<a href="/foo" target="_blank">x</a>';
      const result = domDiff(baseline, candidate);
      expect(result.domChanged).toBe(true);
      expect(result.summary?.attributeChanges).toBe(1);
    });

    test('treats attribute order as insignificant', () => {
      const baseline = '<input type="text" name="email" required>';
      const candidate = '<input required name="email" type="text">';
      // Same attributes, different source order → no signal
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('treats tag name case as insignificant', () => {
      const baseline = '<DIV><Span>Hi</Span></DIV>';
      const candidate = '<div><span>Hi</span></div>';
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });
  });

  describe('text content', () => {
    test('detects text content changes', () => {
      const baseline = '<p>Hello world</p>';
      const candidate = '<p>Goodbye world</p>';
      // A wording edit is a real UI change — with noiseAutoPass enabled, a
      // text-blind DOM diff would silently auto-pass it.
      const result = domDiff(baseline, candidate);
      expect(result.domChanged).toBe(true);
      expect(result.summary).toEqual({ added: 0, removed: 0, attributeChanges: 0, textChanges: 1 });
    });

    test('ignores script and style bodies', () => {
      const baseline = '<div><script>var a = 1;</script><style>.x{color:red}</style><p>Hi</p></div>';
      const candidate = '<div><script>var a = 2;</script><style>.x{color:blue}</style><p>Hi</p></div>';
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('ignores whitespace-only differences', () => {
      const baseline = '<div>\n  <p>Hi</p>\n</div>';
      const candidate = '<div><p>Hi</p></div>';
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });
  });

  describe('void / self-closing elements', () => {
    test('handles void elements (br, img, input)', () => {
      const baseline = '<div><br><img src="a.png"><input type="text"></div>';
      const candidate = '<div><br/><img src="a.png" /><input type="text" /></div>';
      // Same elements, different self-closing syntax
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('flags img src change as attribute change', () => {
      const baseline = '<img src="logo-v1.png">';
      const candidate = '<img src="logo-v2.png">';
      expect(domDiff(baseline, candidate).summary?.attributeChanges).toBe(1);
    });
  });

  describe('robustness', () => {
    test('skips comments', () => {
      const baseline = '<div><!-- old comment --><p>Hi</p></div>';
      const candidate = '<div><!-- new comment --><p>Hi</p></div>';
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('handles doctype', () => {
      const baseline = '<!DOCTYPE html><html><body><p>x</p></body></html>';
      const candidate = '<!DOCTYPE html><html><body><p>x</p></body></html>';
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('handles script content opaquely', () => {
      const baseline = '<div><script>console.log("a")</script><p>x</p></div>';
      const candidate = '<div><script>console.log("b")</script><p>x</p></div>';
      // Inline JS content changes don't affect structure
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('handles style content opaquely', () => {
      const baseline = '<head><style>.a{color:red}</style></head>';
      const candidate = '<head><style>.a{color:blue}</style></head>';
      // Style changes are pixel territory, not DOM tree territory
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('handles attributes containing >', () => {
      const baseline = '<a title="2 > 1">x</a>';
      const candidate = '<a title="2 > 1">x</a>';
      expect(domDiff(baseline, candidate)).toEqual({ domChanged: false, summary: null });
    });

    test('does not throw on truncated HTML', () => {
      expect(() => domDiff('<div><p>unclosed', '<div><p>unclosed')).not.toThrow();
      expect(() => domDiff('<div', '<span')).not.toThrow();
    });

    test('handles realistic page-size input without timing out', () => {
      // Build a 5000-element page; should be sub-100ms
      const items = Array.from({ length: 5000 }, (_, i) => `<li class="item">Item ${i}</li>`).join('');
      const baseline = `<html><body><ul>${items}</ul></body></html>`;
      const candidate = `<html><body><ul>${items}<li class="item">Extra</li></ul></body></html>`;
      const start = Date.now();
      const result = domDiff(baseline, candidate);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
      expect(result.domChanged).toBe(true);
      expect(result.summary?.added).toBe(1);
    });
  });

  describe('summary semantics', () => {
    test('multiple of the same change type accumulate', () => {
      const baseline = '<ul></ul>';
      const candidate = '<ul><li>a</li><li>b</li><li>c</li></ul>';
      const result = domDiff(baseline, candidate);
      expect(result.summary?.added).toBe(3);
    });

    test('add and attribute change count separately', () => {
      const baseline = '<div><p class="a">x</p></div>';
      const candidate = '<div><p class="b">x</p><p>new</p></div>';
      const result = domDiff(baseline, candidate);
      expect(result.summary?.added).toBe(1);
      expect(result.summary?.attributeChanges).toBe(1);
    });
  });
});

describe('volatile attributes (per-run URL churn)', () => {
  const { domDiff } = require('../diff/dom-diff');

  it('blob: URLs are always normalized — no attributeChanges, noise hint survives', () => {
    const a = '<div><img src="blob:https://app/1111-aaaa"></div>';
    const b = '<div><img src="blob:https://app/2222-bbbb"></div>';
    const r = domDiff(a, b);
    expect(r.domChanged).toBe(false);
    expect(r.summary?.attributeChanges ?? 0).toBe(0);
  });

  it('data: URIs stay significant (content-addressed)', () => {
    const a = '<img src="data:image/png;base64,AAAA">';
    const b = '<img src="data:image/png;base64,BBBB">';
    const r = domDiff(a, b);
    expect(r.domChanged).toBe(true);
  });

  it('http src change counts by default', () => {
    const a = '<img src="https://cdn/x.1.png">';
    const b = '<img src="https://cdn/x.2.png">';
    expect(domDiff(a, b).domChanged).toBe(true);
  });

  it('volatileAttributes ignores the value but keeps presence', () => {
    const a = '<img src="https://cdn/x.1.png">';
    const b = '<img src="https://cdn/x.2.png">';
    const r = domDiff(a, b, { volatileAttributes: ['src'] });
    expect(r.domChanged).toBe(false);
    // removing the attribute entirely is still a change
    const r2 = domDiff(a, '<img>', { volatileAttributes: ['src'] });
    expect(r2.domChanged).toBe(true);
  });

  it('volatileAttributes is case-insensitive', () => {
    const a = '<img SRC="https://cdn/x.1.png">';
    const b = '<img src="https://cdn/x.2.png">';
    expect(domDiff(a, b, { volatileAttributes: ['SRC'] }).domChanged).toBe(false);
  });
});

describe('<script> attribute values (they never render)', () => {
  const page = (script: string) => `<html><head>${script}</head><body><h1>Orders</h1></body></html>`;

  it("a bundle renamed by content hash is not a DOM change (Expo's index-<hash>.js)", () => {
    const a = page('<script src="/_expo/static/js/web/index-47d040f9ce41f4cf25ecac26e3425a98.js" defer=""></script>');
    const b = page('<script src="/_expo/static/js/web/index-66295cebe0bf99bbd7a2c9d1060d53d0.js" defer=""></script>');
    expect(domDiff(a, b).domChanged).toBe(false);
  });

  it('integrity and nonce values (per build, per request) are not a DOM change', () => {
    const a = page('<script src="/a.js" integrity="sha384-AAA" nonce="r4nd0m1"></script>');
    const b = page('<script src="/a.js" integrity="sha384-BBB" nonce="r4nd0m2"></script>');
    expect(domDiff(a, b).domChanged).toBe(false);
  });

  it('a script added or removed still is', () => {
    const a = page('<script src="/a.js"></script>');
    const b = page('<script src="/a.js"></script><script src="/b.js"></script>');
    expect(domDiff(a, b).domChanged).toBe(true);
    expect(domDiff(a, b).summary).toMatchObject({ added: 1 });
  });

  it('an attribute added to or removed from a script still is (presence counts)', () => {
    const a = page('<script src="/a.js"></script>');
    const b = page('<script src="/a.js" defer></script>');
    expect(domDiff(a, b).domChanged).toBe(true);
  });

  it('the same values on any other element still count', () => {
    const a = page('<img src="/hero-1.png">');
    const b = page('<img src="/hero-2.png">');
    expect(domDiff(a, b).domChanged).toBe(true);
    const l1 = page('<link rel="stylesheet" href="/app-1.css">');
    const l2 = page('<link rel="stylesheet" href="/app-2.css">');
    expect(domDiff(l1, l2).domChanged).toBe(true);
  });
});
