/**
 * GitHub commit status builder for TestivAI visual reports
 */

import type { ResultsData } from './types';

export const STATUS_CONTEXT = 'TestivAI / visual';

/**
 * Resolve the commit status context from the status-context input.
 * Falls back to the default so callers pinned to an action.yml without
 * the input (or passing an empty string) keep the historical context.
 */
export function resolveStatusContext(input: string): string {
  return input.trim() || STATUS_CONTEXT;
}

export interface StatusConfig {
  failOnDiff: boolean;
  /** Fail on baselines that received no capture — silent coverage loss. */
  failOnMissing?: boolean;
}

/**
 * A check-run conclusion. `neutral` is the important one: GitHub treats it as
 * satisfying a required status check —
 *
 *   "Required status checks must have a successful, skipped, or neutral status
 *    before collaborators can make changes to a protected branch."
 *
 * — so it is visible and honest without ever blocking a merge. Reporting
 * `success` for a run that needs review (what this action used to do) trains
 * people to ignore green checks.
 */
export type CheckConclusion = 'success' | 'neutral' | 'failure';

export interface VisualStatus {
  /** Legacy commit status; has no `neutral`, so review maps to `success`. */
  state: 'success' | 'failure' | 'pending';
  /** Check-run conclusion — the honest one. */
  conclusion: CheckConclusion;
  description: string;
  /** Check-run output title (short) and summary (markdown). */
  title: string;
  summary: string;
}

/**
 * Decide what to report.
 *
 * Missing baselines lead the message: a changed snapshot is a change someone
 * made, but a baseline that received no capture is coverage that silently
 * disappeared, which is the harder failure to notice. They do not lead the
 * gate: a changed snapshot in the same run still fails it when fail-on-diff is
 * set (the CLI's exit codes rank changed above missing too), or a pull request
 * that drops one snapshot would wave through a change to another.
 */
export function determineStatus(results: ResultsData, config: StatusConfig): VisualStatus {
  const { summary } = results;
  const missing = summary.missing ?? results.missingBaselines?.length ?? 0;
  const changed = summary.changed;
  const added = summary.newSnapshots;

  if (summary.total === 0 && missing === 0) {
    return {
      state: 'success',
      conclusion: 'success',
      description: 'No visual snapshots captured',
      title: 'No visual snapshots captured',
      summary:
        'No captures were found for this run. If that is unexpected, check that the tests ran and that `.testivai/temp/` was produced.',
    };
  }

  const parts: string[] = [];
  if (changed > 0) parts.push(`${changed} changed`);
  if (added > 0) parts.push(`${added} new`);
  const label = parts.join(', ');

  if (missing > 0) {
    const s = missing === 1 ? '' : 's';
    const names = (results.missingBaselines ?? []).slice(0, 10);
    const list = names.length > 0 ? `\n\n${names.map((n) => `- \`${n}\``).join('\n')}` : '';
    const detail =
      `${missing} committed baseline${s} received no capture this run. ` +
      'A deleted or renamed test stops guarding its page without anything failing.' +
      list;
    // The changed and new snapshots of the same run still need their review.
    const others = label
      ? `\n\nAlso ${label}: review the diffs in the report artifact, then approve intentional changes ` +
        'with `/testivai approve` on this pull request.'
      : '';
    const title = `${missing} baseline${s} received no capture${label ? `; ${label}` : ''}`;

    const reasons: string[] = [];
    if (changed > 0 && config.failOnDiff) reasons.push(`${changed} snapshot${changed === 1 ? '' : 's'} changed`);
    if (config.failOnMissing) reasons.push(`${missing} baseline${s} not covered`);
    if (reasons.length > 0) {
      return {
        state: 'failure',
        conclusion: 'failure',
        description: reasons.join(', '),
        title,
        summary: detail + others,
      };
    }
    return {
      state: 'success',
      conclusion: 'neutral',
      description: `${missing} baseline${s} not covered${label ? `, ${label}` : ''} — review`,
      title,
      summary: detail + others,
    };
  }

  if (changed === 0 && added === 0) {
    // summary.passed includes snapshots witness auto-passed through a
    // configured pass criterion (maxDiffPercent / maxDiffPixels /
    // shiftTolerance / noiseAutoPass), whose pixels did differ: say that
    // nothing needs review, not that nothing was detected.
    return {
      state: 'success',
      conclusion: 'success',
      description: `All ${summary.passed} snapshots passed`,
      title: `All ${summary.passed} snapshots passed`,
      summary: 'No visual changes need review (diffs within your configured pass criteria count as passed).',
    };
  }

  if (changed > 0 && config.failOnDiff) {
    return {
      state: 'failure',
      conclusion: 'failure',
      description: `${changed} snapshot${changed === 1 ? '' : 's'} changed`,
      title: `${label} — visual regression`,
      summary:
        `${label}. Review the diffs in the report artifact, then approve intentional changes with ` +
        '`/testivai approve` on this pull request.',
    };
  }

  // Needs a human, does not block. This is the case that used to report green.
  return {
    state: 'success',
    conclusion: 'neutral',
    description: `${label} — review`,
    title: `${label} — needs review`,
    summary:
      `${label}. This does not block the merge. Review the diffs in the report artifact, then ` +
      'approve intentional changes with `/testivai approve` on this pull request.',
  };
}
