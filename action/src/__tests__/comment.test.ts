/**
 * Tests for comment builder
 */

import { buildComment, buildEmptyComment, resolveUpsertMarker, UPSERT_MARKER } from '../comment';
import { STATUS_CONTEXT } from '../status';
import type { ResultsData } from '../types';

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
    it('renders "DOM unchanged" hint when noiseHint is true', () => {
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
      expect(comment).toContain('DOM unchanged');
      expect(comment).toContain('likely render noise');
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

    it('omits DOM hint when snapshot has no dom data', () => {
      const results: ResultsData = {
        timestamp: Date.now(),
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [
          { id: '1', name: 'no-dom', status: 'changed', diffPercent: 5, currentPath: 'x.png' },
        ],
      };
      const comment = buildComment(results);
      expect(comment).not.toContain('**DOM unchanged**');
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

  // An identical DOM alone cannot tell render noise from a stylesheet-only
  // change; only a compared style check rules that out. The notes are the
  // witness HTML report's, so both surfaces say the same thing.
  const noiseComment = (styleCheck?: 'match' | 'unavailable') =>
    buildComment({
      ...base,
      snapshots: [{
        name: 'n', status: 'changed', diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null, ...(styleCheck ? { styleCheck } : {}) },
      }],
    } as any);
  const lineStarting = (comment: string, prefix: string) => comment.split('\n').find(l => l.startsWith(prefix));

  it('noise hint says the styles were verified when the style check matched', () => {
    expect(lineStarting(noiseComment('match'), '> **DOM unchanged**')).toBe(
      '> **DOM unchanged** — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged.',
    );
  });

  it('noise hint says the styles were not compared when the style check was unavailable', () => {
    expect(lineStarting(noiseComment('unavailable'), '> **DOM unchanged**')).toBe(
      '> **DOM unchanged** — pixel diff is likely render noise (anti-aliasing, font hinting). (Style check unavailable — no comparable style digests on both sides.)',
    );
  });

  it('noise hint from an older results.json (no styleCheck) is unchanged', () => {
    expect(lineStarting(noiseComment(), '> **DOM unchanged**')).toBe(
      '> **DOM unchanged** — pixel diff is likely render noise (anti-aliasing, font hinting).',
    );
  });

  it('footer says an identical DOM rules out a style-only change only when the styles were verified', () => {
    const footer = lineStarting(noiseComment('match'), '> Pixel-exact comparison');
    expect(footer).toContain(
      'An identical DOM points to render noise, and rules out a stylesheet-only change only when the hint also says "Styles verified unchanged".',
    );
    expect(footer).toContain('[`@testivai/mcp`]');
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
    expect(comment).toContain('DOM unchanged');
  });
});
