/**
 * The published site's files: each run's report page, rebuilt from its data,
 * and the index pages.
 *
 * A run's page is rendered by the report template from its results.json, as
 * checked by parseReportData, and shows its PNGs, as checked by checkPng.
 * Nothing else from the artifact is published (its own index.html included):
 * a fork's pull request controls what its run uploads. Images are copied to
 * numbered paths (images/<snapshot index>/<kind>.png), so no name from the
 * report ends up in a URL, and every page is noindex, under a content
 * security policy that keeps it from loading or sending anything elsewhere.
 *
 * Every function here is pure: the caller writes the files.
 */

import { renderHtml, type ReportNotice } from '../../../packages/witness/src/report/template';
import { parseReportData } from '../../../packages/witness/src/report/validate';
import type { ReportData, ReportSummary } from '../../../packages/witness/src/report/results';
import { parseRunStamp, staleReport } from '../report-artifact';
import type { ReportArchive } from './archive';
import type { PlannedRun, PlanPr, SitePlan } from './plan';
import { checkPng } from './png';

export interface SiteInfo {
  /** The site's address, ending in '/'. */
  url: string;
  /** owner/name. */
  repo: string;
  /** https://github.com, or the GitHub Enterprise Server address. */
  serverUrl: string;
  defaultBranch: string;
}

export interface SiteFile {
  /** Relative to the site root, built from numbers and fixed names only. */
  path: string;
  data: string | Uint8Array;
}

export interface RunReportInput {
  site: SiteInfo;
  run: PlannedRun;
  /** The pull request; absent for the default branch's run (main/). */
  pr?: PlanPr;
  /** The report ZIP on GitHub (downloading it needs a GitHub sign-in). */
  artifactUrl: string;
  /** What the artifact held, or why it was refused. */
  archive: ReportArchive | { refused: string };
}

type OutcomeBase = { runId: number; dir: string; url: string };

export type RunOutcome =
  | (OutcomeBase & { ok: true; summary: ReportSummary; data: ReportData; omittedImages: string[] })
  | (OutcomeBase & { ok: false; reason: string });

const KINDS = ['baseline', 'current', 'diff'] as const;
const PATH_FIELD = { baseline: 'baselinePath', current: 'currentPath', diff: 'diffPath' } as const;

/** Policy for the index and fallback pages: no scripts at all. */
const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function buildRunReport(input: RunReportInput): { files: SiteFile[]; outcome: RunOutcome } {
  const { site, run, archive } = input;
  const base: OutcomeBase = { runId: run.runId, dir: run.dir, url: `${site.url}${run.dir}/` };
  const page = `${run.dir}/index.html`;

  const read = readResults(archive);
  if (!read.ok) {
    return { files: [{ path: page, data: fallbackPage(input, read.reason) }], outcome: { ...base, ok: false, reason: read.reason } };
  }
  const { data, raw } = read;

  // Image paths are never taken from results.json for the page. A path it
  // gives is only looked up in the archive, and only for its own kind.
  const files: SiteFile[] = [];
  const omittedImages: string[] = [];
  const archiveImages = (archive as ReportArchive).images;
  data.snapshots.forEach((snapshot, i) => {
    const rawSnapshot = raw.snapshots[i] as Record<string, unknown>;
    for (const kind of KINDS) {
      const field = PATH_FIELD[kind];
      const from = rawSnapshot[field];
      if (typeof from !== 'string' || !from.endsWith(`/${kind}.png`)) continue;
      const bytes = archiveImages.get(from);
      if (!bytes) continue;
      const check = checkPng(bytes);
      if (!check.ok) {
        omittedImages.push(`${from} (${check.reason})`);
        continue;
      }
      const to = `images/${i}/${kind}.png`;
      files.push({ path: `${run.dir}/${to}`, data: bytes });
      snapshot[field] = to;
    }
  });

  const notices = runNotices(input);
  if (omittedImages.length > 0) {
    const n = omittedImages.length;
    const shown = omittedImages.slice(0, 5).join(', ');
    const more = n > 5 ? `, and ${n - 5} more` : '';
    notices.push({
      text: `${n} image${n === 1 ? ' was' : 's were'} left out, as ${n === 1 ? 'it is' : 'they are'} not a PNG a browser can show: ${shown}${more}.`,
      tone: 'warning',
    });
  }
  if (archive && 'runStamp' in archive && archive.runStamp) {
    const stale = staleReport(parseRunStamp(new TextDecoder().decode(archive.runStamp)), {
      GITHUB_RUN_ID: String(run.runId),
      GITHUB_RUN_ATTEMPT: String(run.attempt),
    });
    if (stale) {
      notices.push({ text: `This report is from attempt ${stale.reportAttempt} of the run; attempt ${stale.thisAttempt} did not upload one.` });
    }
  }

  files.push({ path: page, data: renderHtml(data, { notices, noindex: true, csp: true }) });
  return { files, outcome: { ...base, ok: true, summary: data.summary, data, omittedImages } };
}

type ReadResults = { ok: true; data: ReportData; raw: { snapshots: unknown[] } } | { ok: false; reason: string };

function readResults(archive: ReportArchive | { refused: string }): ReadResults {
  if ('refused' in archive) return { ok: false, reason: `The report was not read: ${archive.refused}.` };
  if (!archive.results) return { ok: false, reason: 'The report has no results.json.' };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(archive.results));
  } catch {
    return { ok: false, reason: 'results.json is not valid JSON.' };
  }
  const parsed = parseReportData(raw);
  if (!parsed.ok) return { ok: false, reason: `results.json cannot be shown: ${parsed.reason}` };
  return { ok: true, data: parsed.data, raw: raw as { snapshots: unknown[] } };
}

// ── Links and wording ───────────────────────────────────────────────────

const prUrl = (site: SiteInfo, n: number) => `${site.serverUrl}/${site.repo}/pull/${n}`;
const runUrl = (site: SiteInfo, id: number) => `${site.serverUrl}/${site.repo}/actions/runs/${id}`;

function shortSha(sha: string): string {
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 7) : '';
}

/** "2026-10-18 10:05 UTC" from an ISO time; '' for anything else. */
function when(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : '';
}

/** "commit 70d8c8e · 2026-10-18 10:05 UTC", leaving out what is unknown. */
function commitAndTime(run: PlannedRun): string[] {
  const sha = shortSha(run.headSha);
  const time = when(run.createdAt);
  return [...(sha ? [`commit ${sha}`] : []), ...(time ? [time] : [])];
}

/** "Pull request #14 · commit 70d8c8e · CI run 391…, attempt 1 · 2026-10-18 10:05 UTC" */
function runLine(site: SiteInfo, run: PlannedRun, pr?: PlanPr): string {
  const [commit, time] = commitAndTime(run);
  return [pr ? `Pull request #${pr.number}` : site.defaultBranch, commit, `CI run ${run.runId}, attempt ${run.attempt}`, time]
    .filter(Boolean)
    .join(' · ');
}

function runNotices({ site, run, pr, artifactUrl }: RunReportInput): ReportNotice[] {
  const notices: ReportNotice[] = [
    {
      text: runLine(site, run, pr),
      links: [...(pr ? [{ href: prUrl(site, pr.number), label: 'pull request' }] : []), { href: runUrl(site, run.runId), label: 'CI run' }],
    },
    {
      text: "Published by TestivAI from this run's report",
      links: [
        ...(pr ? [{ href: `${site.url}pr/${pr.number}/`, label: "this pull request's runs" }] : []),
        { href: site.url, label: 'all reports' },
        { href: artifactUrl, label: 'report ZIP (GitHub sign-in)' },
      ],
    },
  ];
  if (pr?.fork) {
    notices.push({
      text: `From a fork (${pr.author}): this report was produced by code in the pull request, so its results and screenshots are the fork's. TestivAI checked their format and rebuilt this page from them, but cannot vouch for what they show.`,
      tone: 'warning',
    });
  }
  return notices;
}

function counts(s: ReportSummary): string {
  const parts: string[] = [];
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.newSnapshots) parts.push(`${s.newSnapshots} new`);
  if (s.missing) parts.push(`${s.missing} missing`);
  parts.push(`${s.passed} passed`);
  return parts.join(' · ');
}

function outcomeText(outcome: RunOutcome | undefined): string {
  if (!outcome) return 'not published';
  return outcome.ok ? counts(outcome.summary) : `could not be shown: ${outcome.reason}`;
}

// ── Pages of our own ────────────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** An href: an https URL, or a relative path made of numbers and fixed names. */
function href(value: string): string {
  return esc(value);
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)}</title>
  <style>
    :root { --bg: #f6f8fa; --surface: #ffffff; --border: #d0d7de; --text: #1f2328; --muted: #59636e; --accent: #0e7490; --link: #0969da; --changed: #cf222e; --new: #bc4c00; --passed: #1a7f37; --warn-bg: #bc4c0014; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #00d4ff; --link: #58a6ff; --changed: #f85149; --new: #f0883e; --passed: #3fb950; --warn-bg: #f0883e22; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
    h1 { font-size: 22px; margin: 0 0 4px; color: var(--accent); overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin: 28px 0 10px; }
    p { margin: 8px 0; }
    a { color: var(--link); }
    .muted { color: var(--muted); font-size: 14px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; overflow-wrap: anywhere; }
    .tag { display: inline-block; font-size: 12px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--new); color: var(--new); margin-left: 6px; }
    .notice { background: var(--warn-bg); border: 1px solid var(--border); border-left: 4px solid var(--new); border-radius: 10px; padding: 12px 14px; margin: 16px 0; overflow-wrap: anywhere; }
    code { font-family: 'SF Mono', ui-monospace, monospace; font-size: 13px; }
  </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function fallbackPage(input: RunReportInput, reason: string): string {
  const { site, run, pr, artifactUrl } = input;
  const links = [
    ...(pr ? [`<a href="${href(prUrl(site, pr.number))}">pull request</a>`] : []),
    `<a href="${href(runUrl(site, run.runId))}">CI run</a>`,
    `<a href="${href(artifactUrl)}">report ZIP (GitHub sign-in)</a>`,
    ...(pr ? [`<a href="${href(`${site.url}pr/${pr.number}/`)}">this pull request's runs</a>`] : []),
    `<a href="${href(site.url)}">all reports</a>`,
  ];
  return layout(
    'TestivAI report not shown',
    `  <h1>This report could not be shown</h1>
  <p class="muted">${esc(runLine(site, run, pr))}</p>
  <div class="notice">${esc(reason)}</div>
  <p>The run's own report is in its ZIP. ${links.join(' · ')}</p>`,
  );
}

export interface IndexInput {
  site: SiteInfo;
  plan: SitePlan;
  /** By run id. */
  outcomes: Map<number, RunOutcome>;
  runsPerPr: number;
  /** The folder of the repository's own pages (the include input), linked from the front page. */
  include?: string;
}

/** The front page, a page per pull request, and the 404 page. */
export function buildIndexPages({ site, plan, outcomes, runsPerPr, include }: IndexInput): SiteFile[] {
  const files: SiteFile[] = [];
  const about = `Published by TestivAI: the last ${runsPerPr} runs of each open pull request, and the latest run on ${esc(site.defaultBranch)}. A closed pull request's reports go with the next publish.`;

  const sections: string[] = [];
  if (plan.main) {
    const m = plan.main;
    sections.push(`  <h2>${esc(site.defaultBranch)}</h2>
  <ul><li><a href="main/">Latest run on ${esc(site.defaultBranch)}</a> · ${esc(outcomeText(outcomes.get(m.runId)))}<br><span class="muted">${esc(runLine(site, m))}</span></li></ul>`);
  }
  if (plan.prs.length > 0) {
    const items = plan.prs.map(({ pr, runs }) => {
      const latest = runs[0];
      const title = pr.title ? ` ${esc(truncate(pr.title, 200))}` : '';
      const fork = pr.fork ? `<span class="tag">fork · ${esc(pr.author)}</span>` : '';
      return `<li><strong>#${pr.number}</strong>${title}${fork}<br><a href="${href(`${latest.dir}/`)}">Latest run</a> · ${esc(outcomeText(outcomes.get(latest.runId)))} · <a href="${href(`pr/${pr.number}/`)}">all ${runs.length} run${runs.length === 1 ? '' : 's'}</a></li>`;
    });
    sections.push(`  <h2>Open pull requests</h2>\n  <ul>${items.join('\n  ')}</ul>`);
  }
  if (sections.length === 0) {
    sections.push('  <p>Nothing is published yet: no open pull request or run on the default branch has a report.</p>');
  }
  if (include) {
    sections.push(`  <h2>Also on this site</h2>\n  <ul><li><a href="${href(`${include}/`)}">${esc(include)}/</a></li></ul>`);
  }
  files.push({
    path: 'index.html',
    data: layout(`Visual reports · ${site.repo}`, `  <h1>Visual reports · ${esc(site.repo)}</h1>\n  <p class="muted">${about}</p>\n${sections.join('\n')}`),
  });

  for (const { pr, runs } of plan.prs) {
    const items = runs.map(
      (r) =>
        `<li><a href="${href(`${r.dir.slice(`pr/${pr.number}/`.length)}/`)}">CI run ${r.runId}, attempt ${r.attempt}</a> · ${esc(outcomeText(outcomes.get(r.runId)))}<br><span class="muted">${esc(commitAndTime(r).join(' · '))}</span></li>`,
    );
    const dropped = plan.dropped
      .filter((d) => d.pr === pr.number)
      .map((d) => `<li>Run ${d.runId} is not published: ${esc(d.reason)}</li>`);
    const title = pr.title ? ` · ${esc(truncate(pr.title, 200))}` : '';
    const fork = pr.fork ? `<div class="notice">From a fork (${esc(pr.author)}): these reports were produced by code in the pull request. TestivAI checked their format and rebuilt the pages from them, but cannot vouch for what they show.</div>` : '';
    files.push({
      path: `pr/${pr.number}/index.html`,
      data: layout(
        `Pull request #${pr.number} · visual reports`,
        `  <h1>Pull request #${pr.number}${title}</h1>
  <p class="muted"><a href="${href(prUrl(site, pr.number))}">Open the pull request</a> · <a href="${href(site.url)}">all reports</a>. Its last ${runsPerPr} runs with a report, newest first.</p>
  ${fork}
  <ul>${items.join('\n  ')}</ul>${dropped.length ? `\n  <h2>Not published</h2>\n  <ul>${dropped.join('\n  ')}</ul>` : ''}`,
      ),
    });
  }

  files.push({
    path: '404.html',
    data: layout(
      'Report not found',
      `  <h1>This report is no longer published</h1>
  <p>Reports stay published for the last ${runsPerPr} runs of each open pull request and the latest run on ${esc(site.defaultBranch)}; an older run's report, or a closed pull request's, is removed with the next publish. Its ZIP may still be on the run's page on GitHub, until the artifact expires.</p>
  <p><a href="${href(site.url)}">All published reports for ${esc(site.repo)}</a></p>`,
    ),
  });
  return files;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
