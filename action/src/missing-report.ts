/**
 * When the run wrote no results.json (index.ts).
 *
 * A CI step runs only on success by default, so one failing test skips the
 * compare step (`testivai report`, or merge-captures then report in a sharded
 * run) although every capture was taken. The action then:
 *
 * - compares the captures itself when there are any in .testivai/temp/, with
 *   the project's .testivai/config.json and committed baselines (the same
 *   generateReport the reporter and `testivai report` run), and posts the full
 *   report, saying the action compared them (comparedByActionNotice);
 * - otherwise says there is no visual report for this run, why that may be and
 *   what to do (buildNoReportComment, noReportStatus), so the pull request
 *   never keeps showing an earlier run's result as the current one.
 *
 * One shard's captures are never compared alone: a shard runs a slice of the
 * suite, so every other shard's baseline would read as missing coverage. Nor
 * is a merge that lacks a shard (merge-captures failed it, so the comparison
 * after it did not run): it is part of the suite too.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateReport } from '../../packages/witness/src/report/generator';
import { loadLocalConfig } from '../../packages/witness/src/config/local-config';
import { MERGE_RECORD, SHARD_MANIFEST } from '../../packages/witness/src/capture/shard';
import { runMarkerLine } from './comment';
import type { VisualStatus } from './status';
import type { ResultsData } from './types';

/**
 * What .testivai/temp/ holds: the capture folders (with a screenshot.png),
 * the shard that wrote them if one did, and the shards a merge lacks if
 * merge-captures wrote them there.
 */
export interface CapturesFound {
  names: string[];
  shard: { current: number; total: number } | null;
  merge: { total: number; seen: number[]; missing: number[] } | null;
}

/** Why the run has no visual report. */
export type NoReportReason =
  | { kind: 'no-captures' }
  | { kind: 'shard'; captures: number; shard: { current: number; total: number } }
  | { kind: 'incomplete-merge'; captures: number; total: number; seen: number[]; missing: number[] }
  | { kind: 'compare-failed'; captures: number; error: string };

/** The captures in a .testivai/temp/ folder; none when it does not exist. */
export function findCaptures(tempDir: string): CapturesFound {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(tempDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(tempDir, e.name, 'screenshot.png')))
      .map((e) => e.name)
      .sort();
  } catch {
    names = [];
  }
  return { names, shard: readShard(tempDir), merge: readMerge(tempDir) };
}

const shardNumbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 1) ? (value as number[]) : null;

/** The merge record merge-captures writes (shard.ts); null without a valid one, or for an unsharded merge. */
function readMerge(tempDir: string): CapturesFound['merge'] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(tempDir, MERGE_RECORD), 'utf-8'));
    const total = raw?.shardTotal;
    const seen = shardNumbers(raw?.shardsSeen);
    const missing = shardNumbers(raw?.shardsMissing);
    if (!Number.isInteger(total) || total < 1 || !seen || !missing) return null;
    return { total, seen, missing };
  } catch {
    return null;
  }
}

/** The shard named by the manifest the reporter writes in a shard's temp folder; null without a valid one. */
function readShard(tempDir: string): CapturesFound['shard'] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(tempDir, SHARD_MANIFEST), 'utf-8'));
    const current = raw?.shard?.current;
    const total = raw?.shard?.total;
    if (!Number.isInteger(current) || !Number.isInteger(total) || total < 1 || current < 1 || current > total) return null;
    return { current, total };
  } catch {
    return null;
  }
}

/**
 * Whether the captures can be compared as this run's whole set: there are
 * some, and they are not one shard's slice of several. Returns the reason
 * when they cannot.
 */
export function cannotCompare(found: CapturesFound): NoReportReason | null {
  if (found.names.length === 0) return { kind: 'no-captures' };
  if (found.shard && found.shard.total > 1) return { kind: 'shard', captures: found.names.length, shard: found.shard };
  if (found.merge && found.merge.missing.length > 0) {
    return { kind: 'incomplete-merge', captures: found.names.length, ...found.merge };
  }
  return null;
}

/**
 * Compare the project's captures against its baselines and write the report
 * (results.json, index.html, images/) to reportDir, as `testivai report`
 * does: the project's config.json for the threshold and the pass criteria,
 * never opening a browser. Throws when the comparison fails.
 */
export function compareCaptures(projectRoot: string, reportDir: string): ResultsData {
  const config = loadLocalConfig(projectRoot);
  const report = generateReport({ projectRoot, reportDir, threshold: config.threshold, autoOpen: false });
  return report as unknown as ResultsData;
}

/** The notice under the comment's summary line when the action compared the captures. */
export function comparedByActionNotice(captures: number): string {
  return (
    `> **Compared by the TestivAI action.** This run wrote no \`results.json\` (its compare step most likely ` +
    `did not run because a test failed), so the action compared the ${plural(captures, 'capture')} in ` +
    '`.testivai/temp/` against the committed baselines, with `.testivai/config.json`. To compare in your own ' +
    'step, run it with `if: ${{ !cancelled() }}`.\n\n'
  );
}

/** Where the comment came from and what it is about. */
export interface NoReportCommentOptions {
  /** The results.json the action looked for. */
  resultsPath: string;
  /** The commit this run is about. */
  sha: string;
  /** The lane's upsert marker (resolveUpsertMarker). */
  marker: string;
  /** The run marker (runKeyFromEnv), so a later publish step can tell which run the comment is about. */
  runKey?: string;
}

/** Text in a code span it cannot close, on one line, at most 500 characters. */
function code(text: string): string {
  let t = text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/`/g, "'");
  if (!t) t = 'unknown error';
  if (t.length > 500) t = `${t.slice(0, 499)}…`;
  return `\`${t}\``;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What is missing, in one paragraph. */
function whatIsMissing(reason: NoReportReason, resultsPath: string): string {
  const notFound = `${code(resultsPath)} was not found`;
  switch (reason.kind) {
    case 'no-captures':
      return `${notFound}, and there were no captures in \`.testivai/temp/\` to compare.`;
    case 'shard':
      return (
        `${notFound}, and the ${plural(reason.captures, 'capture')} in \`.testivai/temp/\` are shard ` +
        `${reason.shard.current} of ${reason.shard.total} only. Comparing one shard's slice would report every ` +
        "other shard's baseline as missing, so the action did not compare them."
      );
    case 'incomplete-merge':
      return (
        `${notFound}, and the ${plural(reason.captures, 'capture')} in \`.testivai/temp/\` were merged from ` +
        `${reason.seen.length} of ${reason.total} shards (${missingShards(reason)}). Comparing part of the suite ` +
        "would report every missing shard's baseline as missing, so the action did not compare them."
      );
    case 'compare-failed':
      return (
        `${notFound}, and the action could not compare the ${plural(reason.captures, 'capture')} in ` +
        `\`.testivai/temp/\`: ${code(reason.error)}`
      );
  }
}

function missingShards(reason: { missing: number[] }): string {
  return `missing: ${reason.missing.join(', ')}`;
}

/** The likely causes, as list items. */
function likelyCauses(reason: NoReportReason): string[] {
  switch (reason.kind) {
    case 'no-captures':
      return [
        'The tests failed or crashed before taking any capture: see the test step\'s log.',
        'The test step was skipped, or ran without the TestivAI reporter or `witness()` calls.',
        'The compare step wrote the report somewhere else: `report-dir` must name the folder that holds `results.json`.',
      ];
    case 'shard':
      return [
        'This action runs in a shard job, or the job that merges every shard\'s captures did not run its compare step (a failing test in any shard skips a job that `needs` the shards).',
      ];
    case 'incomplete-merge':
      return [
        'A shard crashed, was cancelled, or did not upload its captures: a shard\'s upload step runs only on success by default, so a failing test there skips it.',
      ];
    case 'compare-failed':
      return [
        'The compare step did not run (a CI step runs only on success by default, so a failing test skips it), and the captures it left could not be read.',
        'A capture was cut short, for example by a browser that crashed mid-screenshot.',
      ];
  }
}

/** What to do, as list items. */
function whatToDo(reason: NoReportReason): string[] {
  const always = 'Run the compare step and this action with `if: ${{ !cancelled() }}`, so they run after a failing test too.';
  switch (reason.kind) {
    case 'no-captures':
      return ['Fix what stopped the tests, then push again or re-run the job.', always];
    case 'shard':
      return [
        'Merge every shard\'s captures with `npx testivai merge-captures <dirs...>`, then run `npx testivai report`, in one job that `needs` the shards and has `if: ${{ !cancelled() }}`; run this action there.',
      ];
    case 'incomplete-merge':
      return [
        'Upload each shard\'s captures with `if: ${{ !cancelled() }}`, so a shard with a failing test still uploads them.',
        'Re-run the missing shards, or pass `--allow-incomplete` to `merge-captures` to compare part of the suite on purpose.',
      ];
    case 'compare-failed':
      return ['Re-run the job; if it happens again, run `npx testivai report` locally on the same captures to see the error.', always];
  }
}

/**
 * The comment (and job summary) for a run without a visual report: what is
 * missing, the likely causes, and what to do. It replaces the lane's earlier
 * comment, so an earlier run's numbers never read as this run's.
 */
export function buildNoReportComment(reason: NoReportReason, options: NoReportCommentOptions): string {
  const commit = options.sha ? ` for commit \`${options.sha.slice(0, 7)}\`` : '';
  return `${options.marker}${runMarkerLine(options.runKey)}

### TestivAI Visual Report

> **No visual report for this run**${commit}. ${whatIsMissing(reason, options.resultsPath)} Any earlier result this comment showed is out of date.

**Likely causes**

${likelyCauses(reason).map((line) => `- ${line}`).join('\n')}

**What to do**

${whatToDo(reason).map((line) => `- ${line}`).join('\n')}

---
*Generated by [TestivAI](https://github.com/testivai/testivai-oss)*
`;
}

/**
 * The check run and commit status for a run without a visual report. The
 * check fails (neutral would satisfy a required check, and nothing was
 * verified); the commit status is `error`, GitHub's state for a check that
 * could not produce a result. The step fails too.
 */
export function noReportStatus(reason: NoReportReason, resultsPath: string): VisualStatus {
  const description = (() => {
    switch (reason.kind) {
      case 'no-captures':
        return 'No visual report: results.json not found and no captures';
      case 'shard':
        return `No visual report: shard ${reason.shard.current}/${reason.shard.total} captures only, not compared`;
      case 'incomplete-merge':
        return `No visual report: ${reason.seen.length} of ${reason.total} shards merged, not compared`;
      case 'compare-failed':
        return 'No visual report: could not compare the captures';
    }
  })();
  return {
    state: 'error',
    conclusion: 'failure',
    description,
    title: 'No visual report for this run',
    summary:
      `${whatIsMissing(reason, resultsPath)}\n\n` +
      `${whatToDo(reason).map((line) => `- ${line}`).join('\n')}`,
  };
}

/** Why the step fails for a run without a visual report. */
export function noReportFailure(reason: NoReportReason, resultsPath: string): string {
  switch (reason.kind) {
    case 'no-captures':
      return `No visual report for this run: ${resultsPath} not found, and no captures in .testivai/temp/ to compare. Did the tests run?`;
    case 'shard':
      return `No visual report for this run: ${resultsPath} not found, and .testivai/temp/ holds shard ${reason.shard.current} of ${reason.shard.total} only. Merge every shard's captures, then run testivai report.`;
    case 'incomplete-merge':
      return `No visual report for this run: ${resultsPath} not found, and .testivai/temp/ holds captures merged from ${reason.seen.length} of ${reason.total} shards (${missingShards(reason)}).`;
    case 'compare-failed':
      return `No visual report for this run: ${resultsPath} not found, and the action could not compare the captures in .testivai/temp/: ${reason.error}`;
  }
}
