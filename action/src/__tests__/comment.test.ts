/**
 * Tests for comment builder
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildComment, buildEmptyComment, resolveUpsertMarker, UPSERT_MARKER } from '../comment';
import { STATUS_CONTEXT } from '../status';
import type { ResultsData, SnapshotResult } from '../types';

describe('resolveUpsertMarker', () => {
  it('returns the legacy bare marker for the default status context', () => {
    expect(resolveUpsertMarker(STATUS_CONTEXT)).toBe('<!-- testivai-visual-report -->');
  });

  it('namespaces the marker with a custom status context', () => {
    expect(resolveUpsertMarker('TestivAI / visual (pytest)'))
      .toBe('<!-- testivai-visual-report:TestivAI / visual (pytest) -->');
  });

  it('keeps the legacy marker out of namespaced comment bodies (no cross-lane upsert match)', () => {
    const namespaced = resolveUpsertMarker('TestivAI / e2e');
    expect(namespaced.includes(UPSERT_MARKER)).toBe(false);
  });

  it('markers of prefix-related contexts do not match each other', () => {
    const short = resolveUpsertMarker('TestivAI / A');
    const long = resolveUpsertMarker('TestivAI / A (mobile)');
    expect(long.includes(short)).toBe(false);
  });

  it('sanitizes characters that would break the HTML comment', () => {
    expect(resolveUpsertMarker('a -- b')).toBe('<!-- testivai-visual-report:a - b -->');
    expect(resolveUpsertMarker('a <b> c')).toBe('<!-- testivai-visual-report:a b c -->');
  });
});

describe('buildComment', () => {
  it('T6.1 - includes TestivAI Visual Report header', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0 },
      snapshots: [{ id: '1', name: 'homepage', status: 'passed', currentPath: 'test.png' }],
    };

    const comment = buildComment(results);
    expect(comment).toContain('### TestivAI Visual Report');
  });

  it('T6.2 - includes upsert marker', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 },
      snapshots: [],
    };

    const comment = buildComment(results);
    expect(comment).toContain('<!-- testivai-visual-report -->');
  });

  it('T6.3 - includes summary line with counts', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 5, passed: 2, changed: 2, newSnapshots: 1 },
      snapshots: [],
    };

    const comment = buildComment(results);
    expect(comment).toContain('**2 passed**');
    expect(comment).toContain('**2 changed**');
    expect(comment).toContain('**1 new**');
  });

  it('T6.4 - includes details with approve command for changed snapshots', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [
        { id: '1', name: 'homepage', status: 'changed', diffPercentage: 12.5, currentPath: 'test.png' },
      ],
    };

    const comment = buildComment(results);
    expect(comment).toContain('homepage');
    expect(comment).toContain('12.50% different');
    expect(comment).toContain('/testivai approve homepage');
    expect(comment).toContain('/testivai approve --all');
  });

  it('T6.5 - no details sections when all passed', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 3, passed: 3, changed: 0, newSnapshots: 0 },
      snapshots: [
        { id: '1', name: 'page1', status: 'passed', currentPath: 'test.png' },
        { id: '2', name: 'page2', status: 'passed', currentPath: 'test.png' },
        { id: '3', name: 'page3', status: 'passed', currentPath: 'test.png' },
      ],
    };

    const comment = buildComment(results);
    expect(comment).not.toContain('Changed Snapshots');
    expect(comment).not.toContain('New Snapshots');
  });

  it('T6.6 - empty results has graceful message', () => {
    const comment = buildEmptyComment();
    expect(comment).toContain('No visual snapshots were captured');
  });

  it('embeds a custom upsert marker when provided', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 },
      snapshots: [],
    };
    const marker = resolveUpsertMarker('TestivAI / visual (pytest)');

    expect(buildComment(results, undefined, marker)).toContain(marker);
    expect(buildEmptyComment(undefined, marker)).toContain(marker);
  });

  it('renders new-snapshots section when present', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 1, passed: 0, changed: 0, newSnapshots: 1 },
      snapshots: [
        { id: '1', name: 'fresh-baseline', status: 'new', currentPath: 'fresh.png' },
      ],
    };
    const comment = buildComment(results);
    expect(comment).toContain('#### New Snapshots');
    expect(comment).toContain('`fresh-baseline`');
  });

  it('accepts diffPercent (new) and diffPercentage (legacy) interchangeably', () => {
    const newField: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [
        { id: '1', name: 'a', status: 'changed', diffPercent: 7.5, currentPath: 'a.png' },
      ],
    };
    const legacyField: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [
        { id: '1', name: 'a', status: 'changed', diffPercentage: 7.5, currentPath: 'a.png' },
      ],
    };
    expect(buildComment(newField)).toContain('7.50% different');
    expect(buildComment(legacyField)).toContain('7.50% different');
  });

  describe('DOM noise hint in PR comment', () => {
    // No styleCheck (an older results.json): the styles were never compared,
    // so an identical DOM alone does not make this likely noise.
    it('renders "DOM unchanged, styles not compared" when noiseHint is true without a style check', () => {
      const results: ResultsData = {
        timestamp: Date.now(),
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [
          {
            id: '1',
            name: 'noisy',
            status: 'changed',
            diffPercent: 0.5,
            currentPath: 'noisy.png',
            dom: { changed: false, summary: null, noiseHint: true },
          },
        ],
      };
      const comment = buildComment(results);
      expect(comment).toContain('**DOM unchanged, styles not compared**');
      expect(comment).toContain('could be render noise or a stylesheet-only change');
      expect(comment).not.toContain('likely render noise');
    });

    it('renders "DOM changed" hint with counts when noiseHint is false', () => {
      const results: ResultsData = {
        timestamp: Date.now(),
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [
          {
            id: '1',
            name: 'real-change',
            status: 'changed',
            diffPercent: 12,
            currentPath: 'rc.png',
            dom: {
              changed: true,
              summary: { added: 2, removed: 0, attributeChanges: 1 },
              noiseHint: false,
            },
          },
        ],
      };
      const comment = buildComment(results);
      expect(comment).toContain('DOM changed');
      expect(comment).toContain('2 added');
      expect(comment).toContain('1 attribute change');
    });

    // results.json 2.4.0: a candidate whose dimensions differ from the
    // baseline's. The row shows both sizes; the body says what the change
    // means (content added or removed, or a viewport change) and never noise.
    describe('size mismatch', () => {
      const changedWith = (extra: Partial<SnapshotResult>): ResultsData => ({
        timestamp: Date.now(),
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [{ name: 'products', status: 'changed', diffPercent: 7.49, currentPath: 'p.png', ...extra }],
      });

      it('shows the two sizes on the snapshot row; with DOM additions and no page shift, the DOM says what changed, not where', () => {
        const comment = buildComment(
          changedWith({
            sizeMismatch: { baseline: { width: 1280, height: 2348 }, candidate: { width: 1280, height: 2538 } },
            dom: { changed: true, noiseHint: false, summary: { added: 4, removed: 0, attributeChanges: 0, textChanges: 2 }, styleCheck: 'match' },
          }),
        );
        expect(comment).toContain('<summary><code>products</code> — 7.49% different · baseline 1280×2348 → current 1280×2538 (+190 px)</summary>');
        expect(comment).toContain(
          '> **Size changed — page grew 190 px** (baseline 1280×2348 → current 1280×2538): the DOM summary says what changed; every pixel of the added band at the bottom counts as changed, but the change itself can be anywhere on the page. Compare the images and confirm the change is intended before approving.',
        );
        expect(comment).toContain('> **DOM changed** — 4 added, 2 text changes.');
      });

      // Found dogfooding testivai-example: an inserted banner grows the page
      // and moves everything below y=203 down; the added band at the bottom
      // is the new height, not where the banner is. The size line places it,
      // so the separate layout-shift line is not repeated.
      it('with a page shift, the size line says to look above it, once', () => {
        const comment = buildComment(
          changedWith({
            sizeMismatch: { baseline: { width: 1280, height: 876 }, candidate: { width: 1280, height: 949 } },
            pageShift: { dy: 73, belowY: 203, count: 25 },
            dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0, textChanges: 1 }, styleCheck: 'match' },
          }),
        );
        expect(comment).toContain(
          '> **Size changed — page grew 73 px** (baseline 1280×876 → current 1280×949): everything below y=203 moved down 73 px, so look above that line; every pixel of the added band at the bottom counts as changed. Compare the images and confirm the change is intended before approving.',
        );
        expect(comment).not.toContain('**Layout shift**');
        expect(comment).not.toContain("below the baseline's height");
        expect(comment).toContain('> **DOM changed** — 1 added, 1 text change.');
      });

      // Also found dogfooding: against baselines from another machine, a page
      // came out 5 px taller with the DOM and styles identical.
      it('with an identical DOM, the same content laid out taller, never content added', () => {
        const comment = buildComment(
          changedWith({
            sizeMismatch: { baseline: { width: 1280, height: 871 }, candidate: { width: 1280, height: 876 } },
            dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
          }),
        );
        expect(comment).toContain(
          '> **Size changed — page grew 5 px** (baseline 1280×871 → current 1280×876): no elements were added or removed, so the same content is laid out taller (often fonts or rendering that differ between machines); every pixel of the added band at the bottom counts as changed. Compare the images before approving.',
        );
        expect(comment).not.toMatch(/content was added|DOM unchanged|likely render noise/);
      });

      it('a width change points at the viewport or device scale and is never called noise', () => {
        const comment = buildComment(
          changedWith({
            sizeMismatch: { baseline: { width: 1280, height: 800 }, candidate: { width: 1440, height: 800 } },
            dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
          }),
        );
        expect(comment).toContain('<summary><code>products</code> — 7.49% different · baseline 1280×800 → current 1440×800 (+160 px wide)</summary>');
        expect(comment).toContain(
          "> **Size changed — width changed 1280 → 1440: viewport or device scale differs** (baseline 1280×800 → current 1440×800), so this is not a page change; the diff is on a padded canvas and does not describe the page. Re-capture at the baseline's viewport and device scale, or re-baseline if the new size is intended.",
        );
        expect(comment).not.toContain('likely render noise');
        expect(comment).not.toContain('DOM unchanged');
      });

      it('a shorter page without DOM data does not guess where the change is', () => {
        const comment = buildComment(
          changedWith({ sizeMismatch: { baseline: { width: 1280, height: 2538 }, candidate: { width: 1280, height: 2348 } } }),
        );
        expect(comment).toContain('baseline 1280×2538 → current 1280×2348 (-190 px)');
        expect(comment).toContain('> **Size changed — page shrank 190 px** (baseline 1280×2538 → current 1280×2348): every pixel of the missing band at the bottom counts as changed, but the change itself can be anywhere on the page. Compare the images and confirm the change is intended before approving.');
      });

      it('a row without sizeMismatch is unchanged', () => {
        const comment = buildComment(changedWith({}));
        expect(comment).toContain('<summary><code>products</code> — 7.49% different</summary>');
        expect(comment).not.toContain('Size changed');
      });
    });

    it('omits DOM hint when snapshot has no dom data', () => {
      const results: ResultsData = {
        timestamp: Date.now(),
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [
          { id: '1', name: 'no-dom', status: 'changed', diffPercent: 5, currentPath: 'x.png' },
        ],
      };
      const comment = buildComment(results);
      expect(comment).not.toContain('DOM unchanged');
      expect(comment).not.toContain('**DOM changed**');
    });

    it('singular vs plural attribute-change wording', () => {
      const buildWith = (count: number): string => buildComment({
        timestamp: Date.now(),
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [{
          id: '1', name: 'x', status: 'changed', diffPercent: 1, currentPath: 'x.png',
          dom: { changed: true, summary: { added: 0, removed: 0, attributeChanges: count }, noiseHint: false },
        }],
      });
      expect(buildWith(1)).toContain('1 attribute change');
      expect(buildWith(1)).not.toContain('1 attribute changes');
      expect(buildWith(3)).toContain('3 attribute changes');
    });
  });
});

describe('verdict lines in the PR comment (layered analysis)', () => {
  const base = {
    timestamp: 0,
    summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
  };

  it('style-only change renders as real-not-noise with the element name', () => {
    const comment = buildComment({
      ...base,
      snapshots: [{
        name: 'cta', status: 'changed', diffPercent: 2.1,
        dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count: 1, elements: ['main > button.cta'] } },
      }],
    } as any);
    expect(comment).toContain('Style-only change — real, not noise');
    expect(comment).toContain('button.cta');
    expect(comment).not.toContain('DOM unchanged');
  });

  it('a DOM change that also restyles elements reads as a DOM change, never "identical DOM"', () => {
    // A class or style attribute change: the DOM diff sees the attribute and
    // the style check, which runs whenever DOM data exists, sees a mismatch.
    const comment = buildComment({
      ...base,
      snapshots: [{
        name: 'cta', status: 'changed', diffPercent: 2.1,
        dom: {
          changed: true, noiseHint: false,
          summary: { added: 0, removed: 0, attributeChanges: 1, textChanges: 0 },
          styleCheck: 'mismatch', styleChanges: { count: 2, elements: ['main > button.cta', 'main > a.more'] },
        },
      }],
    } as any);
    // The snapshot's own block; the static footer explains identical-DOM hints in general.
    const block = comment.slice(comment.indexOf('<details>'), comment.indexOf('</details>'));
    expect(block).toContain('<code>cta</code>');
    expect(block).not.toContain('Style-only change');
    expect(block).not.toContain('identical DOM');
    expect(block).toContain('> **DOM changed** — 1 attribute change. Computed styles also changed on 2 elements (`button.cta`, `a.more`).');
  });

  // An identical DOM alone cannot tell render noise from a stylesheet-only
  // change; only a compared style check rules that out. Three cases when the
  // pixels differ and the DOM is identical:
  //   'match'        → likely render noise (still not proof)
  //   'mismatch'     → a real style-only change (covered above)
  //   'unavailable' or no styleCheck (older results.json) → styles not
  //                    compared: render noise or a stylesheet-only change
  const noiseComment = (styleCheck?: 'match' | 'unavailable') =>
    buildComment({
      ...base,
      snapshots: [{
        name: 'n', status: 'changed', diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null, ...(styleCheck ? { styleCheck } : {}) },
      }],
    } as any);
  const lineStarting = (comment: string, prefix: string) => comment.split('\n').find(l => l.startsWith(prefix));
  const NOT_COMPARED_LINE =
    '> **DOM unchanged, styles not compared** — could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.';

  it('noise hint says the styles were verified and the diff is small and scattered when the style check matched', () => {
    const comment = noiseComment('match');
    expect(lineStarting(comment, '> **DOM unchanged')).toBe(
      '> **DOM unchanged** — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.',
    );
    expect(comment).not.toContain('styles not compared');
  });

  // Matching styles are likely noise only when the diff is small and
  // scattered. Real runs from packages/witness (fixtures/README.md there).
  describe('styles verified unchanged, but not the shape of render noise (real runs)', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'packages', 'witness', 'src', '__tests__', 'fixtures', 'render-noise-shapes.results.json'),
        'utf8',
      ),
    );
    const realComment = (name: string) =>
      buildComment({ ...base, snapshots: [fixture.snapshots.find((s: { name: string }) => s.name === name)] } as any);
    const NOISE_CLAIMS = /likely (render )?noise|worth a glance|not a block|don.t block|do not block/i;

    it('a diff concentrated in one area names the area and says what it can be', () => {
      expect(lineStarting(realComment('card-clipped'), '> **DOM and styles unchanged')).toBe(
        '> **DOM and styles unchanged, but the diff is concentrated in one area** — 3 regions within 155×52 px, 0.8% of the page: ' +
          'a bad capture, or a change the style check does not cover (size, overflow, position, transform, text decoration, ' +
          'filters, pseudo-elements, or images and other assets). Compare the images before approving.',
      );
    });

    it.each([['card-clipped'], ['card-text-not-painted'], ['baseline-band-shifted'], ['titles-underlined']])(
      '%s is not called noise',
      (name) => {
        const comment = realComment(name);
        expect(comment).toContain('concentrated in one area');
        expect(comment).not.toMatch(NOISE_CLAIMS);
      },
    );

    it('a large spread-out diff says it is more than render noise usually changes', () => {
      expect(lineStarting(realComment('font-subpixel-noise-over-1pct'), '> **DOM and styles unchanged')).toBe(
        '> **DOM and styles unchanged, but the diff is large** — 1.19% of pixels differ, spread across the page: more than ' +
          'render noise usually changes (often fonts or rendering that differ between machines). Compare the images before approving.',
      );
      expect(realComment('fonts-differ-between-machines')).not.toMatch(NOISE_CLAIMS);
    });

    it('scattered render noise keeps the likely-noise line', () => {
      for (const name of ['glyph-edge-noise', 'font-subpixel-noise']) {
        expect(lineStarting(realComment(name), '> **DOM unchanged')).toMatch(/likely render noise/);
      }
    });
  });

  it('noise hint says the styles were not compared when the style check was unavailable', () => {
    expect(lineStarting(noiseComment('unavailable'), '> **DOM unchanged')).toBe(NOT_COMPARED_LINE);
  });

  it('noise hint from an older results.json (no styleCheck) says the styles were not compared', () => {
    expect(lineStarting(noiseComment(), '> **DOM unchanged')).toBe(NOT_COMPARED_LINE);
  });

  it.each([['unavailable' as const], [undefined]])(
    'never calls an identical-DOM diff noise when styles were not compared (styleCheck %s)',
    (styleCheck) => {
      const comment = noiseComment(styleCheck);
      expect(comment).not.toMatch(/likely (render )?noise/i);
      expect(comment).not.toMatch(/worth a glance|not a block|don.t block|do not block|dismiss/i);
      expect(comment).not.toContain('Styles verified unchanged.');
    },
  );

  it('footer ties render noise to a verified style check and a small, scattered diff, and points dynamic content at ignoreSelectors/mask', () => {
    const footerLine = noiseComment('match').split('\n').find(l => l.includes('[`@testivai/mcp`]'));
    expect(footerLine).toBeDefined();
    expect(footerLine).toContain(
      'An identical DOM points to render noise only when the styles are verified unchanged and the diff is small and scattered, as the hint then says; otherwise a stylesheet-only change, a bad capture, or a change the style check does not cover is not ruled out.',
    );
    expect(footerLine).not.toContain('only when the hint also says "Styles verified unchanged"');
    expect(footerLine).toContain(
      'Content that changes between runs (timestamps, ads, rotating images) can show up as a pixel diff unless you hide it with `ignoreSelectors` or exclude it with `mask`.',
    );
    // The comparison is tolerant (per-pixel color threshold), not pixel-exact,
    // and an identical DOM alone is not evidence of noise.
    expect(footerLine).not.toContain('Pixel-exact');
    expect(footerLine).not.toContain('An identical DOM points to render noise,');
  });

  it('pageShift renders the look-above guidance', () => {
    const comment = buildComment({
      ...base,
      snapshots: [{
        name: 'home', status: 'changed', diffPercent: 12,
        pageShift: { dy: 24, belowY: 80, count: 17 },
        dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
      }],
    } as any);
    expect(comment).toContain('Layout shift');
    expect(comment).toContain('below y=80 moved down 24px');
    expect(comment).toContain('DOM changed');
  });

  it('missing baselines are surfaced as a coverage warning', () => {
    const comment = buildComment({
      timestamp: 0,
      summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0, missing: 2 },
      snapshots: [{ name: 'ok', status: 'passed', diffPercent: 0 }],
      missingBaselines: ['pricing', 'checkout'],
    } as any);
    expect(comment).toContain('2 baselines received no capture');
    expect(comment).toContain('`pricing`');
    expect(comment).toContain('coverage just shrank');
  });

  it('older results.json without new fields still renders (backcompat)', () => {
    const comment = buildComment({
      ...base,
      snapshots: [{
        name: 'legacy', status: 'changed', diffPercent: 1,
        dom: { changed: false, noiseHint: true, summary: null },
      }],
    } as any);
    expect(comment).toContain('DOM unchanged, styles not compared');
  });
});
