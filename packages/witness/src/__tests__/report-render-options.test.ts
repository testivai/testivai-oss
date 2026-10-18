/**
 * renderHtml options for a report published to a shared site.
 *
 * notices: lines shown at the top of the report (which pull request, commit
 * and CI run it is, and a warning when the report comes from a fork's CI
 * run, whose results the fork controls). noindex: asks search engines not to
 * index the page.
 */

import type { ReportData } from '../report/results';
import { renderHtml } from '../report/template';

const DATA: ReportData = {
  version: '2.4.0',
  timestamp: '2026-10-18T00:00:00.000Z',
  summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
  snapshots: [{ name: 'home', status: 'changed', diffPercent: 1, diffCount: 10, totalPixels: 1000 }],
};

const noticeBlock = (html: string) => html.slice(html.indexOf('<main class="main">'), html.indexOf('<section'));

describe('renderHtml notices', () => {
  it('shows each notice at the top of the report, before the snapshots', () => {
    const html = renderHtml(DATA, {
      notices: [
        { text: 'Pull request #14 · commit 70d8c8e · CI run 39150236166 (attempt 1)' },
        { text: 'From a fork: produced by code in this pull request.', tone: 'warning' },
      ],
    });

    const top = noticeBlock(html);
    expect(top).toContain('Pull request #14 · commit 70d8c8e · CI run 39150236166 (attempt 1)');
    expect(top).toContain('From a fork: produced by code in this pull request.');
    expect(top).toContain('report-notice warning');
  });

  it('links a notice to an https page', () => {
    const html = renderHtml(DATA, {
      notices: [{ text: 'Pull request #14', link: { href: 'https://github.com/o/r/pull/14', label: 'open the pull request' } }],
    });

    expect(noticeBlock(html)).toContain('<a href="https://github.com/o/r/pull/14">open the pull request</a>');
  });

  it('shows notice text as text, never markup', () => {
    const html = renderHtml(DATA, { notices: [{ text: '"><img src=x onerror=alert(1)>' }] });

    expect(html).not.toContain('<img src=x');
  });

  it('does not link a notice to anything but an https page', () => {
    for (const href of ['javascript:alert(1)', 'http://example.com/', '"><img src=x>', '//evil.example/']) {
      const html = renderHtml(DATA, { notices: [{ text: 'x', link: { href, label: 'go' } }] });
      expect(noticeBlock(html)).not.toContain('<a href=');
      expect(html).not.toContain('<img src=x');
    }
  });

  it('adds nothing without notices', () => {
    expect(renderHtml(DATA)).not.toContain('class="report-notice');
    expect(renderHtml(DATA, { notices: [] })).not.toContain('class="report-notice');
  });
});

describe('renderHtml noindex', () => {
  it('asks search engines not to index a published report', () => {
    expect(renderHtml(DATA, { noindex: true })).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('leaves a local report as it was', () => {
    expect(renderHtml(DATA)).not.toContain('name="robots"');
  });
});
