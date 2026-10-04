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
      'When the styles could not be compared, the verdict says so. ' +
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
