/**
 * The `/testivai approve` command, bundled as dist/approve.cjs: reading the
 * comment (`auth`, approve/action.yml's first step) and the reply (`reply`,
 * its last step).
 *
 * It names the run whose captures were approved and, when that run's report
 * is published on the repository's Pages site (publish@v1), links it and
 * each approved snapshot's card in it. The link is never guessed: publish@v1
 * adds it to the TestivAI comment only after the deploy, and only when the
 * comment's run marker names the published run, so the reply takes it from
 * there. Anything that goes wrong looking for it leaves the link out; the
 * reply itself is always posted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseHealth } from '../../packages/witness/src/capture/health';
import { snapshotAnchorId } from '../../packages/witness/src/report/anchor';
import { assessHealth } from '../../packages/witness/src/report/health';
import { readRunKey, safeReportUrl } from './comment';
import { BOT_LOGIN } from './publish/comments';
import { readRunStamp, type RunStamp } from './report-artifact';

// ── the command ─────────────────────────────────────────────────────────────

export type ApproveCommand =
  /** `target` is `--all` or the snapshot names, separated by single spaces. */
  | { kind: 'approve'; target: string }
  /** `approve` with something glued to it (`approve-all`): never read as a target. */
  | { kind: 'unknown'; command: string; suggestion?: string };

const COMMAND_SHOWN_MAX = 80;

/**
 * Read a PR comment. `null` when it is not a `/testivai approve` command (no
 * reply). `approve` must be a word of its own: `/testivai approve-all` is an
 * unknown command, not the target `-all` (testivai/testivai-site#26). No
 * target means `--all`. There are no aliases: `--all` is the only spelling
 * that approves everything, and `/testivai approve all` names a snapshot
 * called `all`.
 */
export function parseApproveCommand(body: string): ApproveCommand | null {
  const text = body.trim();
  const approve = text.match(/^\/testivai\s+approve(?:\s+(.+))?$/i);
  if (approve) {
    const target = (approve[1] ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
    return { kind: 'approve', target: target || '--all' };
  }
  const glued = text.match(/^\/testivai\s+(approve(\S.*))$/i);
  if (!glued) return null;
  const line = `/testivai ${glued[1]}`.trim();
  const command = line.length > COMMAND_SHOWN_MAX ? `${line.slice(0, COMMAND_SHOWN_MAX)}…` : line;
  const meansAll = /^[-_]*all$/i.test(glued[2].trim());
  return { kind: 'unknown', command, ...(meansAll ? { suggestion: '/testivai approve --all' } : {}) };
}

/**
 * Inline code that the text cannot end early: a fence longer than any run of
 * backticks in it, and control characters (a line break could start a new
 * Markdown block) shown as `?`.
 */
export function codeSpan(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?');
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

const USAGE = [
  'Usage:',
  '- `/testivai approve --all` approves every pending snapshot',
  '- `/testivai approve <name> [<name> …]` approves the named snapshots',
].join('\n');

/** The reply to an unknown command: what was typed, what it likely meant, and the usage. */
export function buildUnknownCommandReply({ command, suggestion }: { kind: 'unknown'; command: string; suggestion?: string }): string {
  const first = `Unknown command ${codeSpan(command)}.${suggestion ? ` Did you mean ${codeSpan(suggestion)}?` : ''}`;
  return [first, '', 'No baselines were updated.', '', USAGE].join('\n');
}

export interface ExistingComment {
  author: string;
  body: string;
}

export interface ApprovedRun {
  id: string;
  /** Known only from the report's run stamp, when it names the run the report was downloaded from. */
  attempt?: number;
}

/** Markdown links to an https address with nothing that could end the link early. */
const LINK = /\]\((https:\/\/[^\s()<>"'`\\]+)\)/g;

/**
 * The published report of run `runKey` (`<run id>-<attempt>`) on pull request
 * `pr`, from a github-actions[bot] comment whose run marker names that run:
 * the reporter's comment once publish@v1 added its links, or publish@v1's own
 * comment on a fork's pull request. Only a link to that run's page
 * (`…/pr/<pr>/<run key>/`, no query) counts; its #fragment is dropped.
 */
export function findReportUrl(comments: ExistingComment[], { pr, runKey }: { pr: number; runKey: string }): string | undefined {
  const page = `/pr/${Math.trunc(pr)}/${runKey}/`;
  for (const comment of comments) {
    if (comment.author !== BOT_LOGIN || readRunKey(comment.body) !== runKey) continue;
    for (const [, raw] of comment.body.matchAll(LINK)) {
      const url = safeReportUrl(raw);
      if (!url) continue;
      const parsed = new URL(url);
      if (!parsed.search && parsed.pathname.endsWith(page)) return url;
    }
  }
  return undefined;
}

/**
 * The approved run: the one the report was downloaded from (a number), with
 * the attempt from the report's run stamp when the stamp names that same run.
 */
export function approvedRun(stamp: RunStamp | null, downloadedRunId: string | undefined): ApprovedRun | undefined {
  if (!downloadedRunId || !/^\d+$/.test(downloadedRunId)) return undefined;
  if (stamp && stamp.runId === downloadedRunId) return { id: downloadedRunId, attempt: stamp.runAttempt };
  return { id: downloadedRunId };
}

export interface ReplyInput {
  approved: string[];
  skipped: string[];
  count: number;
  actor: string;
  run?: ApprovedRun;
  /** The approved run's published report (findReportUrl). */
  reportUrl?: string;
  /** https://github.com, or the GitHub Enterprise Server address. */
  serverUrl: string;
  /** owner/name. */
  repo: string;
  /** Approved captures that were unhealthy (readApprovedHealth): said in the reply. */
  unhealthy?: Array<{ name: string; reasons: string[] }>;
  /** The snapshots the downloaded report could approve (readPendingNames); undefined when unknown. */
  pending?: string[];
}

/**
 * The snapshots the downloaded report could approve: the real directories
 * directly inside pending-baselines (what the apply step accepts), sorted.
 * Undefined when the report has no pending-baselines or it cannot be read.
 */
export function readPendingNames(artifactDir: string): string[] | undefined {
  try {
    return fs
      .readdirSync(path.join(artifactDir, 'pending-baselines'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
}

/**
 * The approved captures that were unhealthy (a web font or stylesheet that
 * failed to load), from each one's metadata.json in the downloaded artifact
 * (pending-baselines/<name>/, what the apply step copied). The artifact comes
 * from the pull request's own CI run: a name that would leave
 * pending-baselines, or metadata that is not a valid health record, is
 * skipped.
 */
export function readApprovedHealth(artifactDir: string, names: string[]): Array<{ name: string; reasons: string[] }> {
  const out: Array<{ name: string; reasons: string[] }> = [];
  for (const name of names) {
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(artifactDir, 'pending-baselines', name, 'metadata.json'), 'utf-8'));
      const health = parseHealth(meta?.health);
      if (!health) continue;
      const assessment = assessHealth(health);
      if (assessment.unhealthy) out.push({ name, reasons: assessment.reasons });
    } catch {
      // no metadata, or not JSON: nothing recorded
    }
  }
  return out;
}

/** At most this many pending snapshots are listed in a reply. */
const PENDING_SHOWN_MAX = 50;

/**
 * Nothing was approved. With the report's pending snapshots known, say which
 * names matched none of them and list them; otherwise the generic reasons.
 */
function buildNothingApproved({ skipped, pending, runLink }: { skipped: string[]; pending?: string[]; runLink?: string }): string {
  if (!pending) {
    const lines = [
      'No baselines were updated.',
      '',
      'Possible reasons:',
      "- The snapshot name(s) don't match any pending changes.",
      '- The artifact is from a run where no visual differences were detected.',
      '- Re-run the OSS visual regression tests and try again.',
    ];
    if (skipped.length) lines.push('', `Not found in pending baselines: ${skipped.map(codeSpan).join(', ')}`);
    return lines.join('\n');
  }

  const where = runLink ?? 'the run';
  if (!skipped.length) {
    return [`No baselines were updated: ${where} has no pending snapshots.`, '', 'Re-run the visual regression tests and try again.'].join('\n');
  }

  const names = skipped.map(codeSpan);
  const unmatched = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  const lines = [`No baselines were updated: no pending snapshot is named ${unmatched}.`, ''];
  if (!pending.length) {
    lines.push(`${runLink ?? 'The run'} has no pending snapshots. Re-run the visual regression tests and try again.`);
    return lines.join('\n');
  }
  const shown = pending.slice(0, PENDING_SHOWN_MAX).map(codeSpan).join(', ');
  const more = pending.length > PENDING_SHOWN_MAX ? ` and ${pending.length - PENDING_SHOWN_MAX} more` : '';
  lines.push(
    `Pending snapshots in ${where}: ${shown}${more}`,
    '',
    'Approve some with `/testivai approve <name> [<name> …]`, or every one with `/testivai approve --all`.',
  );
  return lines.join('\n');
}

const RERUN_NOTE =
  'CI runs again on this commit when the approve step pushes with a personal access token or GitHub App token. With the default `GITHUB_TOKEN`, GitHub starts no run for this push: push another commit to re-run CI.';

/** The reply's Markdown. Snapshot names are shown as code and reach a link only as their anchor id. */
export function buildApproveReply({ approved, skipped, count, actor, run, reportUrl, serverUrl, repo, unhealthy = [], pending }: ReplyInput): string {
  const runLink = run
    ? `[CI run ${run.id}${run.attempt ? `, attempt ${run.attempt}` : ''}](${serverUrl}/${repo}/actions/runs/${run.id}${run.attempt ? `/attempts/${run.attempt}` : ''})`
    : undefined;

  if (count === 0) return buildNothingApproved({ skipped, pending, runLink });

  const report = safeReportUrl(reportUrl);
  const from = runLink ? ` from ${runLink}` : '';
  const lines = [`**${count} baseline${count === 1 ? '' : 's'} approved** by @${actor}${from}`, ''];
  if (report) lines.push(`> **[Open the visual report](${report})** of that run: baseline, current and diff side by side`, '');
  lines.push(approved.map((n) => (report ? `- \`${n}\` · [open in report](${report}#${snapshotAnchorId(n)})` : `- \`${n}\``)).join('\n'));
  for (const u of unhealthy) {
    lines.push(
      '',
      `> **\`${u.name}\` was approved from an unhealthy capture** — ${u.reasons.join('; ')}. ` +
        'Every compare against it will say so: fix the page, the server or the test, re-run and approve a healthy capture.',
    );
  }
  if (skipped.length) lines.push('', `Not found in pending baselines: ${skipped.map((n) => `\`${n}\``).join(', ')}`);
  lines.push('', RERUN_NOTE);
  return lines.join('\n');
}

// ── the github-script step ──────────────────────────────────────────────────

interface Github {
  rest: {
    issues: {
      listComments: (params: { owner: string; repo: string; issue_number: number; per_page: number; page: number }) => Promise<{
        data: Array<{ user?: { login?: string } | null; body?: string | null }>;
      }>;
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<unknown>;
    };
  };
}

interface Context {
  repo: { owner: string; repo: string };
  issue: { number: number };
  serverUrl?: string;
}

interface Core {
  info: (message: string) => void;
  warning: (message: string) => void;
}

const PAGE = 100;
const MAX_PAGES = 10;

async function listComments(github: Github, context: Context): Promise<ExistingComment[]> {
  const comments: ExistingComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await github.rest.issues.listComments({ ...context.repo, issue_number: context.issue.number, per_page: PAGE, page });
    comments.push(...data.map((c) => ({ author: c.user?.login ?? '', body: c.body ?? '' })));
    if (data.length < PAGE) break;
  }
  return comments;
}

const words = (value?: string) => (value ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * Post the reply. Inputs come through the environment, never the script:
 * APPROVED, SKIPPED, COUNT (the apply step), ACTOR, RUN_ID (the run the
 * report was downloaded from) and ARTIFACT_DIR (where it was unzipped).
 */
export async function reply({ github, context, core, env }: { github: Github; context: Context; core: Core; env: Record<string, string | undefined> }): Promise<void> {
  const count = Number.parseInt(env.COUNT ?? '', 10) || 0;
  const run = approvedRun(env.ARTIFACT_DIR ? readRunStamp(env.ARTIFACT_DIR) : null, env.RUN_ID);

  let reportUrl: string | undefined;
  if (count > 0 && run?.attempt !== undefined) {
    try {
      reportUrl = findReportUrl(await listComments(github, context), { pr: context.issue.number, runKey: `${run.id}-${run.attempt}` });
      core.info(reportUrl ? `Linking run ${run.id}'s published report: ${reportUrl}` : `Run ${run.id}, attempt ${run.attempt} has no published report linked in a TestivAI comment.`);
    } catch (error) {
      core.warning(`Could not read the pull request's comments for the report link (${error instanceof Error ? error.message : String(error)}); the reply goes without it.`);
    }
  }

  const approvedNames = words(env.APPROVED);
  const unhealthy = count > 0 && env.ARTIFACT_DIR ? readApprovedHealth(env.ARTIFACT_DIR, approvedNames) : [];
  const body = buildApproveReply({
    approved: approvedNames,
    skipped: words(env.SKIPPED),
    count,
    actor: env.ACTOR ?? '',
    ...(run ? { run } : {}),
    ...(reportUrl ? { reportUrl } : {}),
    serverUrl: context.serverUrl || 'https://github.com',
    repo: `${context.repo.owner}/${context.repo.repo}`,
    ...(unhealthy.length > 0 ? { unhealthy } : {}),
    ...(count === 0 && env.ARTIFACT_DIR ? { pending: readPendingNames(env.ARTIFACT_DIR) } : {}),
  });
  await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
}

// ── the auth step ───────────────────────────────────────────────────────────

interface AuthGithub {
  rest: {
    repos: {
      getCollaboratorPermissionLevel: (params: { owner: string; repo: string; username: string }) => Promise<{ data: { permission: string } }>;
    };
    issues: {
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<unknown>;
    };
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{ data: { head: { ref: string } } }>;
    };
  };
}

interface AuthContext {
  payload: { comment?: { body?: string | null } | null };
  repo: { owner: string; repo: string };
  issue: { number: number };
  actor: string;
}

export type AuthResult = { skip: true } | { skip: false; cmd: 'approve'; target: string; branch: string; actor: string };

/**
 * Read the comment, check the commenter can write to the repository, and
 * resolve the pull request's branch. The result is the step's output, read by
 * the later steps. A comment that is not a `/testivai approve` command is
 * skipped without a reply; someone without write access gets the access
 * reply; an unknown command (`/testivai approve-all`) gets a reply naming it,
 * and approves nothing.
 */
export async function auth({ github, context, core }: { github: AuthGithub; context: AuthContext; core: Pick<Core, 'info'> }): Promise<AuthResult> {
  const command = parseApproveCommand(context.payload.comment?.body ?? '');
  if (!command) {
    core.info('Not a /testivai approve command — skipping.');
    return { skip: true };
  }

  let permission = 'none';
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: context.actor });
    permission = data.permission;
  } catch {
    // actor is not a collaborator at all
  }

  const post = (body: string) => github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });

  if (!['write', 'maintain', 'admin'].includes(permission)) {
    await post(`@${context.actor} — only collaborators with **write** access can approve visual baselines.`);
    return { skip: true };
  }

  if (command.kind === 'unknown') {
    core.info(`Unknown command: ${command.command} — replying with the usage.`);
    await post(buildUnknownCommandReply(command));
    return { skip: true };
  }

  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: context.issue.number });
  core.info(`Command: /testivai approve ${command.target} (by @${context.actor}, branch: ${pr.head.ref})`);
  return { skip: false, cmd: 'approve', target: command.target, branch: pr.head.ref, actor: context.actor };
}
