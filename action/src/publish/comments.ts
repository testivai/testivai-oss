/**
 * The pull request comment, once a run's report is published.
 *
 * The reporter's comment (action/src/index.ts) is rebuilt with the report's
 * links, only when its hidden run marker names the published run: a comment
 * already about a newer run is left for that run's publish. A fork's CI run
 * cannot comment, so for a fork with no reporter comment the publish posts
 * its own, built only from numbers and its own links: a fork controls the
 * text in its results (snapshot names, the reasons a report was refused),
 * and none of it goes into a comment the bot posts, so it shows no
 * thumbnail either: those go only into the reporter's rebuilt comment.
 */

import type { ReportData, ReportSummary } from '../../../packages/witness/src/report/results';
import { buildComment, buildEmptyComment, MAX_COMMENT_THUMBNAILS, readRunKey } from '../comment';
import type { ResultsData } from '../types';

/** Marks the comment the publish posts on a fork's pull request. */
export const FORK_MARKER = '<!-- testivai-published-report -->';

/** The author of comments posted with the workflow's own token. */
export const BOT_LOGIN = 'github-actions[bot]';

export interface PublishedPr {
  pr: number;
  fork: boolean;
  runId: number;
  attempt: number;
  headSha: string;
  /** The run's page on the site. */
  url: string;
  artifactUrl: string;
  outcome: { ok: true; summary: ReportSummary; data: ReportData } | { ok: false; reason: string };
}

export interface ExistingComment {
  id: number;
  body: string;
  author: string;
}

export type CommentAction = { kind: 'create'; body: string } | { kind: 'update'; id: number; body: string } | { kind: 'none'; why: string };

/** The run id in a run key ("<run id>-<attempt>"). */
function runIdOf(key: string | undefined): number | undefined {
  const m = key ? /^(\d+)-\d+$/.exec(key) : null;
  return m ? Number(m[1]) : undefined;
}

export interface CommentOptions {
  /**
   * Show the published thumbnails (default true). Off for a private site:
   * GitHub fetches a comment's images through its own proxy, without the
   * reader's sign-in, so a private site's image would show broken.
   */
  thumbnails?: boolean;
}

export function commentFor(published: PublishedPr, comments: ExistingComment[], marker: string, options: CommentOptions = {}): CommentAction {
  const reporter = comments.find((c) => c.body.includes(marker) && readRunKey(c.body) !== undefined);
  if (reporter) return updateReporterComment(published, reporter, marker, options.thumbnails !== false);
  if (!published.fork) return { kind: 'none', why: `no TestivAI comment for run ${published.runId} on the pull request` };
  return forkComment(published, comments);
}

function updateReporterComment(published: PublishedPr, comment: ExistingComment, marker: string, withThumbnails: boolean): CommentAction {
  const runKey = readRunKey(comment.body) as string;
  const described = runIdOf(runKey);
  if (described !== published.runId) {
    return { kind: 'none', why: `the TestivAI comment describes run ${described ?? runKey}, not run ${published.runId}` };
  }
  if (!published.outcome.ok) {
    return { kind: 'none', why: `the report of run ${published.runId} could not be shown, so the comment keeps its ZIP link` };
  }
  const { data } = published.outcome;
  const links = { reportUrl: published.url, runKey, thumbnails: withThumbnails ? publishedThumbnails(published) : [] };
  const body =
    data.snapshots.length === 0
      ? buildEmptyComment(published.artifactUrl, marker, links)
      : buildComment(data as unknown as ResultsData, published.artifactUrl, marker, links);
  if (body === comment.body) return { kind: 'none', why: 'the comment already links the report' };
  return { kind: 'update', id: comment.id, body };
}

/**
 * The thumbnails the comment shows: the first MAX_COMMENT_THUMBNAILS changed
 * snapshots, in results order, whose thumb.png the site published. site.ts
 * sets `thumbPath` to images/<index>/thumb.png only for a thumb it published
 * (parseReportData never takes one from results.json), and the URL is built
 * from the run's page URL and that index only.
 */
export function publishedThumbnails(published: PublishedPr): Array<{ name: string; url: string }> {
  if (!published.outcome.ok) return [];
  const thumbnails: Array<{ name: string; url: string }> = [];
  published.outcome.data.snapshots.forEach((s, i) => {
    if (thumbnails.length >= MAX_COMMENT_THUMBNAILS || s.status !== 'changed' || s.thumbPath !== `images/${i}/thumb.png`) return;
    thumbnails.push({ name: s.name, url: `${published.url}images/${i}/thumb.png` });
  });
  return thumbnails;
}

function forkComment(published: PublishedPr, comments: ExistingComment[]): CommentAction {
  const body = forkCommentBody(published);
  const own = comments.find((c) => c.author === BOT_LOGIN && c.body.includes(FORK_MARKER));
  if (!own) return { kind: 'create', body };
  const described = runIdOf(readRunKey(own.body));
  if (described !== undefined && described > published.runId) {
    return { kind: 'none', why: `the comment already describes a newer run (${described})` };
  }
  if (own.body === body) return { kind: 'none', why: 'the comment already links the report' };
  return { kind: 'update', id: own.id, body };
}

function counts(s: ReportSummary): string {
  const parts: string[] = [];
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.newSnapshots) parts.push(`${s.newSnapshots} new`);
  if (s.missing) parts.push(`${s.missing} missing`);
  parts.push(`${s.passed} passed`);
  return parts.join(' · ');
}

/** Numbers and our own links only. */
function forkCommentBody(p: PublishedPr): string {
  const sha = /^[0-9a-f]{7,64}$/i.test(p.headSha) ? ` · commit ${p.headSha.slice(0, 7)}` : '';
  const run = `CI run ${Math.trunc(p.runId)}, attempt ${Math.trunc(p.attempt)}${sha}`;
  const lines = ['### TestivAI visual report', ''];
  if (p.outcome.ok) {
    lines.push(`**[Open the visual report](${p.url})** · ${run} · ${counts(p.outcome.summary)}`);
    lines.push('');
    lines.push(
      "This pull request comes from a fork, so its CI run could not comment here; TestivAI published its report instead. The page was rebuilt from the run's results and screenshots: TestivAI checked their format, but cannot vouch for what they show.",
    );
  } else {
    lines.push(`The report of ${run} could not be shown; [the published page](${p.url}) says why and links the run's report ZIP.`);
    lines.push('');
    lines.push('This pull request comes from a fork, so its CI run could not comment here.');
  }
  lines.push('', FORK_MARKER, `<!-- testivai-run:${Math.trunc(p.runId)}-${Math.trunc(p.attempt)} -->`);
  return lines.join('\n');
}
