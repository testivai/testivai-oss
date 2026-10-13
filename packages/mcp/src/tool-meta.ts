/**
 * Titles and descriptions for every tool the server registers.
 *
 * The model reads these before it calls a tool, so they are part of the
 * agent-facing contract alongside the verdicts in lib.ts and must not
 * contradict them. Kept apart from server.ts (which starts the stdio server
 * on import) so tests can read them.
 */
export interface ToolMeta {
  title: string;
  description: string;
  /** Client hints advertised in tools/list alongside the description. */
  _meta?: Record<string, unknown>;
}

// Baseline approval must come from a person. Claude Code honours this key by
// showing the tool's permission prompt on every call, even in auto-approving
// permission modes; other clients ignore it.
const requiresUserInteraction = { 'anthropic/requiresUserInteraction': true };

const diffImages: ToolMeta = {
  title: 'View snapshot diff images',
  description:
    'Return the baseline, current, and diff images for one changed snapshot so you can see what changed visually. ' +
    'Use get_report / get_visual_results first to find snapshot names.',
};

export const TOOL_META = {
  get_visual_results: {
    title: 'Get visual test results',
    description:
      'Read the latest TestivAI visual regression results (visual-report/results.json). ' +
      'Returns a per-snapshot verdict combining the pixel diff with the DOM and computed-style signals. ' +
      'A pixel diff is likely render noise when the DOM and the computed styles both match; ' +
      'a style-only change (identical DOM, different computed styles) is a real change, not noise, ' +
      'and so is any DOM change — both need human review. ' +
      'When the styles were not compared (style check unavailable), the verdict says so and does not call the diff noise: ' +
      'with an identical DOM it could be render noise or a stylesheet-only change, so look at the diff (get_diff) before approving. ' +
      'Run the test suite first (e.g. `npx playwright test`) if results are stale or missing.',
  },
  // `get_diff` is the canonical name; `get_snapshot_diff` is kept as an alias.
  get_diff: diffImages,
  get_snapshot_diff: diffImages,
  get_report: {
    title: 'Get the raw visual report (results.json)',
    description:
      'Return the machine-readable results.json payload verbatim (summary + per-snapshot status, diff %, ' +
      'DOM signal, and region→selector attribution). Parse this instead of scraping CLI output.',
  },
  approve_snapshot: {
    title: 'Approve one snapshot as the new baseline',
    description:
      'Promote .testivai/temp/<name>/ to the committed baseline (same as `testivai approve <name>`). ' +
      'Only approve changes a reviewer has confirmed are intended; then commit .testivai/baselines/.',
    _meta: requiresUserInteraction,
  },
  approve_all: {
    title: 'Approve all pending snapshots as baselines',
    description:
      'Promote every pending capture under .testivai/temp/ to committed baselines (same as `testivai approve --all`). ' +
      'Only run this after a reviewer has confirmed the changes; then commit .testivai/baselines/.',
    _meta: requiresUserInteraction,
  },
  list_baselines: {
    title: 'List committed baselines',
    description: 'List the snapshot baselines committed under .testivai/baselines/.',
  },
  explain_snapshot: {
    title: 'Explain what changed in one snapshot',
    description:
      'Layered evidence for one snapshot: pixel regions with bounding boxes, element attribution ' +
      '(which selectors shifted vs changed, whole-page shift detection), the DOM/style signal, and ' +
      'interpretation guidance. Use this to explain WHY a diff happened — pair with get_diff for the images.',
  },
} satisfies Record<string, ToolMeta>;

/**
 * The `review-visual-changes` prompt. It tells the model how to sort each
 * diff, so it uses the same cases as the verdicts in lib.ts: likely render
 * noise only when the DOM and computed styles both match, and an identical
 * DOM whose styles were not compared is unknown, not noise.
 */
export const REVIEW_PROMPT = {
  name: 'review-visual-changes',
  title: 'Review visual changes',
  description: 'Walk the latest visual results and produce a human-quality review: what changed, why, and what to do.',
  text: [
    'Review the latest TestivAI visual regression results in this project:',
    '',
    '1. Call get_report for the summary. If nothing changed and nothing is new, say so and stop.',
    '2. For every changed snapshot, call explain_snapshot(name) and read its layers and guidance.',
    '   When the evidence is ambiguous, call get_diff(name) and inspect the images.',
    '3. For each snapshot, explain in one short paragraph WHAT changed (name the selectors),',
    '   WHY it likely happened (use pageShift/shift classifications — e.g. content injected above),',
    '   and which case it is:',
    '   - likely render noise (identical DOM and computed styles match; still not proof),',
    '   - a style-only change (identical DOM, computed styles differ: a real change),',
    '   - a structural change (the DOM changed), or',
    '   - styles not compared (identical DOM, style check unavailable):',
    '     could be render noise or a stylesheet-only change, so call get_diff(name)',
    '     and compare the images; do not call it noise.',
    '4. End with a recommendation per snapshot: approve (once the human confirms), investigate,',
    '   or likely noise (mention it, do not block on it; only for the likely-render-noise case).',
    '   Never call approve_snapshot/approve_all yourself unless the human has explicitly',
    '   confirmed the changes are intended — baseline approval is a human decision.',
  ].join('\n'),
};

/** The tool metadata for this server run, given the approval-prompt setting. */
export type ToolName = keyof typeof TOOL_META;

export function toolMetaFor({ approvalPrompt }: { approvalPrompt: boolean }): Record<ToolName, ToolMeta> {
  if (approvalPrompt) return TOOL_META;
  const { _meta: _snapshot, ...approveSnapshot } = TOOL_META.approve_snapshot;
  const { _meta: _all, ...approveAll } = TOOL_META.approve_all;
  return { ...TOOL_META, approve_snapshot: approveSnapshot, approve_all: approveAll };
}
