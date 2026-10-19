/**
 * The publish action's job summary: what the publish did, on its workflow
 * run's page, as markdown.
 *
 * The same data as the site's front page (site.ts buildIndexPages): the
 * site's address, the default branch's latest run and each open pull
 * request's latest run with their counts, a fork tagged, plus the runs left
 * out and why. When nothing is published, the reason (pages.ts
 * decidePublish), so an admin's next step is on the run page and not only in
 * the log.
 *
 * A fork's pull request decides its title and what its artifact holds (a
 * reason a report could not be shown can quote it). The summary follows the
 * rule of the bot's own comment on a fork (comments.ts): for a fork, numbers
 * and our own links only. Every other text value is escaped (escapeMarkdown),
 * so it reads as the text it is.
 *
 * Every function here is pure: publish.ts writes the summary.
 */

import type { ReportSummary } from '../../../packages/witness/src/report/results';
import { safeReportUrl } from '../comment';
import type { DroppedRun, PlannedRun, SitePlan } from './plan';
import { counts, type RunOutcome, type SiteInfo } from './site';

/** A run on the site, as the summary lists it. */
export interface SummaryRun {
  runId: number;
  attempt: number;
  /** Its folder on the site, from numbers only: 'main' or 'pr/<number>/<run id>-<attempt>'. */
  dir: string;
  outcome: { ok: true; summary: ReportSummary } | { ok: false; reason: string };
}

export interface SummaryPr {
  number: number;
  fork: boolean;
  /** The pull request's title; never shown for a fork. */
  title?: string;
  /** How many of its runs are on the site. */
  runs: number;
  latest: SummaryRun;
}

/** What one publish put on the site: recorded by buildSite, listed by publishSummary. */
export interface PublishedSite {
  /** owner/name. */
  repo: string;
  /** https://github.com, or the GitHub Enterprise Server address. */
  serverUrl: string;
  defaultBranch: string;
  runsPerPr: number;
  main?: SummaryRun;
  prs: SummaryPr[];
  dropped: DroppedRun[];
  /** The folder of the repository's own pages (include-name). */
  include?: string;
}

export type PublishSummaryInput =
  | { published: false; reason: string }
  /** siteUrl: the address the comments link (the deploy's, else the build's), ending in '/'. */
  | { published: true; siteUrl: string; site?: PublishedSite };

/** From what buildSite published: the plan without the runs left out, and each run's outcome. */
export function publishedSite(input: { site: SiteInfo; plan: SitePlan; outcomes: Map<number, RunOutcome>; runsPerPr: number; include?: string }): PublishedSite {
  const { site, plan, outcomes } = input;
  const summaryRun = (run: PlannedRun): SummaryRun => {
    const outcome = outcomes.get(run.runId);
    return {
      runId: run.runId,
      attempt: run.attempt,
      dir: run.dir,
      outcome: !outcome ? { ok: false, reason: 'not published' } : outcome.ok ? { ok: true, summary: outcome.summary } : { ok: false, reason: outcome.reason },
    };
  };
  return {
    repo: site.repo,
    serverUrl: site.serverUrl,
    defaultBranch: site.defaultBranch,
    runsPerPr: input.runsPerPr,
    ...(plan.main ? { main: summaryRun(plan.main) } : {}),
    prs: plan.prs.map(({ pr, runs }) => ({
      number: pr.number,
      fork: pr.fork,
      ...(pr.title ? { title: pr.title } : {}),
      runs: runs.length,
      latest: summaryRun(runs[0]),
    })),
    dropped: plan.dropped.map((d) => ({ runId: d.runId, ...(d.pr !== undefined ? { pr: d.pr } : {}), reason: d.reason })),
    ...(input.include ? { include: input.include } : {}),
  };
}

/**
 * Text for markdown that reads as the text it is: every ASCII punctuation
 * character backslash-escaped (CommonMark allows it for any of them), so it
 * opens no link, image, HTML tag, emphasis, code span, table cell or math;
 * line breaks, control characters and direction overrides become a space.
 * GitHub may still turn a bare URL or @name in it into a link, which is why
 * text a fork controls is left out rather than escaped.
 */
/** Line breaks and other control characters, and the marks that reorder text. */
const INVISIBLE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;

export function escapeMarkdown(text: string): string {
  return text.replace(INVISIBLE, ' ').replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);
}

const TITLE_MAX = 200;
const whole = (n: number) => String(Math.trunc(n));

/** [text](url) for an https URL that cannot break out of the link; the text alone otherwise. */
function link(text: string, url: string): string {
  const safe = safeReportUrl(url);
  return safe ? `[${text}](${safe})` : text;
}

function title(pr: SummaryPr): string {
  if (pr.fork || !pr.title) return '';
  const plain = pr.title.replace(INVISIBLE, ' ');
  return ` ${escapeMarkdown(plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1)}…` : plain)}`;
}

/** The counts, or why the report could not be shown; a fork's reason is its artifact's doing, so only that its page says why. */
function outcomeText(run: SummaryRun, fork: boolean): string {
  if (run.outcome.ok) return counts(run.outcome.summary);
  return fork ? 'could not be shown (its page says why)' : `could not be shown: ${escapeMarkdown(run.outcome.reason)}`;
}

export function publishSummary(input: PublishSummaryInput): string {
  if (!input.published) return `### TestivAI reports not published\n\n${escapeMarkdown(input.reason)}\n`;

  const { siteUrl, site } = input;
  const about = site ? ` — the last ${whole(site.runsPerPr)} runs of each open pull request, and the latest run on ${escapeMarkdown(site.defaultBranch)}.` : '';
  const lines = ['### TestivAI reports published', '', `**${link('Open the reports site', siteUrl)}**${about}`];
  if (!site) return `${lines.join('\n')}\n`;

  const page = (dir: string) => `${siteUrl}${dir}/`;
  const prUrl = (n: number) => `${site.serverUrl}/${site.repo}/pull/${whole(n)}`;
  const runUrl = (id: number) => `${site.serverUrl}/${site.repo}/actions/runs/${whole(id)}`;
  const branch = escapeMarkdown(site.defaultBranch);

  if (site.main) {
    const m = site.main;
    lines.push('', `#### ${branch}`, '', `- ${link(`Latest run on ${branch}`, page(m.dir))} · ${outcomeText(m, false)} · ${link(`CI run ${whole(m.runId)}`, runUrl(m.runId))}, attempt ${whole(m.attempt)}`);
  }
  if (site.prs.length > 0) {
    lines.push('', '#### Open pull requests', '');
    for (const pr of site.prs) {
      const fork = pr.fork ? ' · from a fork' : '';
      const all = `all ${whole(pr.runs)} run${pr.runs === 1 ? '' : 's'}`;
      lines.push(
        `- ${link(`#${whole(pr.number)}`, prUrl(pr.number))}${title(pr)}${fork} · ${link('latest run', page(pr.latest.dir))} · ${outcomeText(pr.latest, pr.fork)} · ${link(all, page(`pr/${whole(pr.number)}`))}`,
      );
    }
  }
  if (!site.main && site.prs.length === 0) {
    lines.push('', 'Nothing is published yet: no open pull request or run on the default branch has a report.');
  }
  if (site.dropped.length > 0) {
    lines.push('', '#### Not published', '');
    for (const d of site.dropped) {
      const of = d.pr !== undefined ? ` of ${link(`#${whole(d.pr)}`, prUrl(d.pr))}` : '';
      lines.push(`- ${link(`Run ${whole(d.runId)}`, runUrl(d.runId))}${of}: ${escapeMarkdown(d.reason)}`);
    }
  }
  if (site.include) {
    lines.push('', '#### Also on this site', '', `- ${link(`${escapeMarkdown(site.include)}/`, page(site.include))}`);
  }
  return `${lines.join('\n')}\n`;
}
