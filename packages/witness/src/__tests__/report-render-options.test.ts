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

  it('links a notice to https pages, in order', () => {
    const html = renderHtml(DATA, {
      notices: [
        {
          text: 'Pull request #14',
          links: [
            { href: 'https://github.com/o/r/pull/14', label: 'pull request' },
            { href: 'https://github.com/o/r/actions/runs/1', label: 'CI run' },
          ],
        },
      ],
    });

    expect(noticeBlock(html)).toContain(
      'Pull request #14 · <a href="https://github.com/o/r/pull/14">pull request</a> · <a href="https://github.com/o/r/actions/runs/1">CI run</a>',
    );
  });

  it('shows link labels as text', () => {
    const html = renderHtml(DATA, { notices: [{ text: 'x', links: [{ href: 'https://example.com/', label: '<b>go</b>' }] }] });

    expect(noticeBlock(html)).toContain('>&lt;b&gt;go&lt;/b&gt;</a>');
  });

  it('shows notice text as text, never markup', () => {
    const html = renderHtml(DATA, { notices: [{ text: '"><img src=x onerror=alert(1)>' }] });

    expect(html).not.toContain('<img src=x');
  });

  it('does not link a notice to anything but an https page', () => {
    for (const href of ['javascript:alert(1)', 'http://example.com/', '"><img src=x>', '//evil.example/']) {
      const html = renderHtml(DATA, { notices: [{ text: 'x', links: [{ href, label: 'go' }, { href: 'https://example.com/', label: 'ok' }] }] });
      expect(noticeBlock(html)).toContain('x · <a href="https://example.com/">ok</a></div>');
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

describe('renderHtml csp', () => {
  // The report needs nothing but its own inline styles and scripts and its
  // own images. A published report's data can come from a fork, and project
  // sites on <owner>.github.io share one origin, so the policy keeps a page
  // from loading or sending anything elsewhere even if markup ever got
  // through the escaping.
  const policy = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];

  it('lets a published report load only its own images, styles and scripts', () => {
    const csp = policy(renderHtml(DATA, { csp: true }));

    expect(csp?.split('; ')).toEqual([
      "default-src 'none'",
      "img-src 'self'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });

  it('puts the policy before anything the page loads', () => {
    const html = renderHtml(DATA, { csp: true });

    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'));
  });

  it('leaves a local report as it was', () => {
    expect(renderHtml(DATA)).not.toContain('Content-Security-Policy');
  });
});
