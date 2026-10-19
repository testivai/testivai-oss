/**
 * Each snapshot in the HTML report has a stable link target, so a PR comment
 * (or anyone) can link straight to one snapshot: report/#snap-home.
 *
 * The comment builds the same id from the snapshot name with the exported
 * snapshotAnchorId(), so the two never drift apart.
 */

import * as fs from 'fs';
import * as path from 'path';
import { snapshotAnchorId as fromPackageRoot } from '../index';
import type { ReportData, SnapshotResult } from '../report/results';
import { renderHtml, snapshotAnchorId } from '../report/template';

const SAFE_ID = /^snap-[A-Za-z0-9_-]+$/;

function snap(name: string, status: SnapshotResult['status']): SnapshotResult {
  return { name, status, diffPercent: 0, diffCount: 0, totalPixels: 100 };
}

function report(snapshots: SnapshotResult[]): ReportData {
  return {
    version: '2.4.0',
    timestamp: '2026-10-18T00:00:00.000Z',
    summary: {
      total: snapshots.length,
      passed: snapshots.filter((s) => s.status === 'passed').length,
      changed: snapshots.filter((s) => s.status === 'changed').length,
      newSnapshots: snapshots.filter((s) => s.status === 'new').length,
    },
    snapshots,
  };
}

describe('snapshotAnchorId', () => {
  it('keeps a plain snapshot name readable', () => {
    expect(snapshotAnchorId('home')).toBe('snap-home');
    expect(snapshotAnchorId('products__firefox_128_2x')).toBe('snap-products__firefox_128_2x');
    expect(snapshotAnchorId('Checkout-Step-2')).toBe('snap-Checkout-Step-2');
  });

  it('gives any other name a safe id', () => {
    for (const name of ['home page', 'a/b', 'quote"s', '<script>', 'café', '#hash', '   ', '']) {
      expect(snapshotAnchorId(name)).toMatch(SAFE_ID);
    }
  });

  it('keeps names that differ only in unsafe characters apart', () => {
    const names = ['home page', 'home-page', 'home_page', 'home/page', 'Home page', 'home  page'];
    const ids = names.map(snapshotAnchorId);
    expect(new Set(ids).size).toBe(names.length);
  });

  it('gives the same name the same id every time', () => {
    expect(snapshotAnchorId('home page')).toBe(snapshotAnchorId('home page'));
  });

  it('keeps ids short for very long names', () => {
    const id = snapshotAnchorId(`${'x'.repeat(300)} y`);
    expect(id).toMatch(SAFE_ID);
    expect(id.length).toBeLessThanOrEqual(80);
  });

  it('takes time in proportion to the name, even a name of many dashes', () => {
    // A name comes from results.json, which a fork's CI run controls. A
    // backtracking trim (/^-+|-+$/) is quadratic on dashes between two other
    // characters: it retries the end anchor from every dash. Seconds, not ms.
    const name = `x${'-'.repeat(50_000)}x`;
    const started = Date.now();
    const id = snapshotAnchorId(name);
    expect(Date.now() - started).toBeLessThan(250);
    expect(id).toMatch(SAFE_ID);
  });

  it('is exported from the package root for the PR comment to use', () => {
    expect(fromPackageRoot).toBe(snapshotAnchorId);
  });
});

describe('report link targets', () => {
  it('gives every snapshot, in every section, its id', () => {
    const snapshots = [snap('home', 'changed'), snap('signup form', 'new'), snap('footer', 'passed')];
    const html = renderHtml(report(snapshots));

    for (const s of snapshots) {
      expect(html).toContain(`id="${snapshotAnchorId(s.name)}"`);
    }
  });

  it('never gives two snapshots the same id', () => {
    const html = renderHtml(
      report([snap('home page', 'changed'), snap('home-page', 'changed'), snap('home_page', 'passed')]),
    );

    const ids = [...html.matchAll(/id="(snap-[^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('links each snapshot name to its own id, so the link can be copied from the page', () => {
    const html = renderHtml(report([snap('home', 'changed')]));

    expect(html).toContain('href="#snap-home"');
  });
});

describe('docs/cli/report.md documents the link targets', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'cli', 'report.md'), 'utf8');
  const start = doc.indexOf('## Linking to a snapshot');
  const section = start === -1 ? '' : doc.slice(start, doc.indexOf('\n## ', start + 1));

  it('has a section on linking to one snapshot', () => {
    expect(section).not.toBe('');
  });

  it('every #snap- id it shows is the one the report gives that name', () => {
    const shown = [...section.matchAll(/`([^`\n]+)`\s*→\s*`#(snap-[^`]+)`/g)];
    expect(shown.length).toBeGreaterThanOrEqual(2);
    for (const [, name, id] of shown) expect(id).toBe(snapshotAnchorId(name));
    // One plain name, kept as is, and one that is not, hashed.
    expect(shown.some(([, name, id]) => id === `snap-${name}`)).toBe(true);
    expect(shown.some(([, name, id]) => id !== `snap-${name}`)).toBe(true);
  });
});
