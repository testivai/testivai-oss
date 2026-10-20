/**
 * Job summaries: what a TestivAI step shows on its workflow run's page
 * (@actions/core's `summary`, written to GITHUB_STEP_SUMMARY).
 *
 * The reporter's summary is its PR comment: the same markdown from the same
 * buildComment / buildEmptyComment call, so the two never drift, without
 * what only makes sense in a comment: the hidden markers, the
 * `/testivai approve` code blocks and the "approve all at once" line (nobody
 * can comment from a run page, and a push has no pull request to comment on). A
 * push has no comment, so on the default branch the summary is where a run's
 * result and report link show. The publish action's is publish/summary.ts.
 */

/** The part of @actions/core a summary write uses. */
export interface SummaryCore {
  summary: { addRaw: (text: string, addEOL?: boolean) => { write: () => Promise<unknown> } };
  warning: (message: string) => void;
}

/** A hidden marker on its own line: the lane's upsert marker and the run marker (comment.ts). */
const MARKER_LINE = /^<!-- testivai-[^\n]*-->(?:\n|$)/gm;

/** A changed snapshot's approve command, as buildComment writes it. */
const APPROVE_BLOCK = /\n```\n\/testivai approve [^\n]*\n```\n/g;

/** The bulk approve line under the changed snapshots, as buildComment writes it, with the blank line after it. */
const APPROVE_ALL_LINE = /^> To approve all at once: comment `\/testivai approve --all` on this PR\n\n?/gm;

/** The PR comment's markdown, for the run page: no hidden markers, no approve commands; nothing else changed. */
export function summaryFromComment(body: string): string {
  // The markers open the comment; the blank line after them goes with them.
  return body.replace(MARKER_LINE, '').replace(APPROVE_BLOCK, '').replace(APPROVE_ALL_LINE, '').replace(/^\n+/, '');
}

/**
 * Add the markdown to the step's summary. A summary is only a convenience:
 * when it cannot be written (no GITHUB_STEP_SUMMARY, a runner that does not
 * support it, a full disk), the step warns and goes on. Resolves to whether it
 * was written.
 */
export async function writeJobSummary(core: SummaryCore, markdown: string): Promise<boolean> {
  try {
    await core.summary.addRaw(markdown, true).write();
    return true;
  } catch (error) {
    core.warning(`Could not write the job summary: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
