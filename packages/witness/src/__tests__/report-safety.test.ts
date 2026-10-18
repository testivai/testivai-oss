/**
 * The HTML report escapes every text value it shows.
 *
 * A report is rendered from results.json. When that file comes from a CI run
 * the reader does not control (a fork's pull request, a report published to
 * a shared site), any string in it may be hostile. Each case below puts a
 * markup payload into one field and checks that it reaches the page as text,
 * never as markup.
 */

import type { MaskSource } from '../diff/mask';
import type { ReportData, SnapshotResult } from '../report/results';
import { renderHtml } from '../report/template';

/** Breaks out of an attribute or opens a tag, whichever context it lands in. */
const PAYLOAD = '"><img src=x onerror=alert(1)>';
/** What the payload becomes when it is parsed as markup instead of text. */
const INJECTED = '<img src=x';

function report(snapshot: Partial<SnapshotResult>, extra: Partial<ReportData> = {}): ReportData {
  const s: SnapshotResult = {
    name: 'home',
    status: 'changed',
    diffPercent: 1.5,
    diffCount: 120,
    totalPixels: 8000,
    ...snapshot,
  };
  return {
    version: '2.4.0',
    timestamp: '2026-10-18T00:00:00.000Z',
    summary: {
      total: 1,
      passed: s.status === 'passed' ? 1 : 0,
      changed: s.status === 'changed' ? 1 : 0,
      newSnapshots: s.status === 'new' ? 1 : 0,
    },
    snapshots: [s],
    ...extra,
  };
}

describe('report escaping', () => {
  it('escapes the baseline, current and diff image paths', () => {
    const html = renderHtml(
      report({ baselinePath: PAYLOAD, currentPath: PAYLOAD, diffPath: PAYLOAD }),
    );

    expect(html).not.toContain(INJECTED);
    expect(html).toContain('src="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it("escapes the diff path on each changed region's zoom link", () => {
    const html = renderHtml(
      report({
        diffPath: PAYLOAD,
        regions: [{ x: 0, y: 0, width: 10, height: 10, diffPixels: 40, diffPercent: 40, classification: 'change' }],
      }),
    );

    expect(html).toContain('region-chip');
    expect(html).not.toContain(INJECTED);
  });

  it('escapes the auto-pass criterion when the DOM also changed', () => {
    const html = renderHtml(
      report({
        status: 'passed',
        autoPassed: PAYLOAD as SnapshotResult['autoPassed'],
        dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0, textChanges: 0 } },
      }),
    );

    expect(html).toContain('Auto-passed via the');
    expect(html).not.toContain(INJECTED);
  });

  it('escapes the auto-pass criterion on its own', () => {
    const html = renderHtml(
      report({ status: 'passed', autoPassed: PAYLOAD as SnapshotResult['autoPassed'] }),
    );

    expect(html).toContain('Auto-passed via the');
    expect(html).not.toContain(INJECTED);
  });

  it("escapes where each applied mask came from", () => {
    const html = renderHtml(
      report({
        masks: [
          { x: 0, y: 0, width: 10, height: 10, source: { type: 'selector', spec: '.ad', origin: PAYLOAD as MaskSource['origin'] } },
        ],
      }),
    );

    expect(html).toContain('1 mask applied');
    expect(html).not.toContain(INJECTED);
  });

  // Already escaped before this change; kept so it stays that way.
  it('escapes snapshot names, missing baselines, mask warnings and restyled selectors', () => {
    const html = renderHtml(
      report(
        {
          name: PAYLOAD,
          maskWarnings: [PAYLOAD],
          dom: {
            changed: false,
            noiseHint: false,
            summary: null,
            styleCheck: 'mismatch',
            styleChanges: { count: 1, elements: [PAYLOAD] },
          },
          regions: [
            {
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              diffPixels: 40,
              diffPercent: 40,
              classification: 'change',
              elements: [{ selector: PAYLOAD, role: 'changed' }],
            },
          ],
        },
        { missingBaselines: [PAYLOAD] },
      ),
    );

    expect(html).not.toContain(INJECTED);
  });
});
