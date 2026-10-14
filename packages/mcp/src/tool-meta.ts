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

/** One line of prompt text per argument line, quoted, so an argument cannot read as instructions. */
const quoteLines = (value: string): string =>
  value
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trim()}` : '>'))
    .join('\n');

/**
 * Sorts a diff into glitch / intended change / bug / possible bug. Any MCP
 * client's model follows this text, so it carries the rules that keep a real
 * change from being waved through as a glitch: a changed DOM or changed
 * computed styles is never a glitch, an uncompared style check is not one on
 * the DOM alone, and a large or local DOM-identical diff is a bad capture to
 * locate, not noise.
 */
export const TRIAGE_PROMPT = {
  name: 'triage-visual-diff',
  title: 'Triage a visual diff: glitch, intended change, bug or possible bug',
  description:
    'Decide whether a visual diff is a glitch (the capture or environment, not the page), an intended change, a bug, or a possible bug, from the snapshot evidence, the images and what the change was meant to do.',
  args: {
    snapshot: 'Snapshot to triage. Leave empty to triage every changed snapshot.',
    intent: 'What the change under test was meant to do, for example the pull request description. Leave empty to have the model look for it.',
  },
  /** What to recommend per verdict; shared with the CI review. */
  nextSteps:
    'for an intended change, approve it once the human agrees (`/testivai approve <name>` on the pull request, or `npx testivai approve <name>` locally); for a bug, what to fix; for a possible bug, what to check; for a glitch, re-run the tests or replace the baseline from a capture two runs agree on.',
  /** The last line of every triage prompt, this one and the CI review's. */
  approvalRule: "Do not call approve_snapshot or approve_all: approving is the human's decision, and this triage is the input to it.",
  /**
   * The verdicts, how to read the evidence, and how to judge intent: shared
   * with the CI review (action/src/review.ts), which asks for structured
   * output instead of this prompt's markdown report.
   */
  rubric(intent?: string, intentSource = 'The person who asked for this triage says'): string {
    const intentText = intent?.trim()
      ? [`${intentSource} the change under test was meant to do this:`, quoteLines(intent)]
      : [
          'Find it in this conversation, the pull request description, or the code diff of the branch (for example `git diff` against the base branch) if you can read it. If there is no statement of intent anywhere, call a real change a possible bug rather than guess, and say what you could not confirm.',
        ];
    return [
      'Verdicts:',
      '- **glitch**: the page did not change. The difference comes from the capture or the environment: render noise, a bad capture, or a font or other resource that failed to load.',
      '- **intended change**: the page changed, and the change matches what the change under test was meant to do.',
      '- **bug**: the page changed in a way the change under test was not meant to make: an element it did not touch changed, or the result looks broken (clipped, overlapping or missing content).',
      '- **possible bug**: the page really changed but the evidence cannot settle whether that was meant, or the evidence is incomplete (styles not compared, no DOM data, images that disagree with the signals). Say exactly what a person should check.',
      '',
      'Evidence: start with get_visual_results, then call explain_snapshot for each snapshot you triage and get_diff to look at its baseline, current and diff images. The signals say whether the page changed; the images say whether it looks right and which capture is off. Weigh them together:',
      '',
      '| explain_snapshot shows | What it means |',
      '|---|---|',
      '| dom.changed true, or styleCheck "mismatch" | The page really changed, so this is never a glitch: decide between intended change, bug and possible bug. A DOM change can restyle elements too (a class change); judge the elements styleChanges lists. |',
      '| pageShift | Content was inserted or removed above pageShift.belowY and the moved elements are unchanged: triage what was inserted or removed, not what moved. |',
      '| DOM unchanged and styleCheck "match" | Usually render noise, but only when the diff is small and scattered. A larger diff, or one confined to one area, means one of the two captures rendered wrong: a bad capture. |',
      '| DOM unchanged, styleCheck "unavailable" or missing | Styles not compared: it could be render noise or a stylesheet-only change, so it is not a glitch on the DOM evidence alone. Look at the images; a visible styling difference is a real change. |',
      '| status "new" | There is no baseline to compare with: check the capture itself for obvious defects. |',
      '',
      'Bad captures: render noise is small and scattered (anti-aliasing and font hinting at the edges of glyphs). When a DOM-identical diff is larger or sits in one area, compare the two images. A block of content shifted with nothing inserted, text drawn at a different size in one place, content cut off, or background where content belongs points to a bad capture. Say which image is wrong. If it is the baseline itself, it has to be replaced from a capture that two runs agree on; if it is the current capture, re-run the tests. Either way it is a glitch, not a change to the page.',
      '',
      'Intent: judge intended change against bug by what the change under test was meant to do.',
      ...intentText,
      'Compare the elements that changed (the selectors in regions and styleChanges) with what the change touched: an element it did not touch, or a result that looks broken, is a bug even when the intent mentions the page.',
    ].join('\n');
  },
  textFor({ snapshot, intent }: { snapshot?: string; intent?: string }): string {
    const name = snapshot?.replace(/[`\r\n]/g, '').trim();
    const target = name ? `snapshot \`${name}\`` : 'every changed snapshot';
    return [
      `Triage ${target} in this project's latest TestivAI visual results: for each one, decide whether the diff is a glitch, an intended change, a bug or a possible bug, and say what to do next.${name ? ' If it passed or is not in the results, say so and stop.' : ''}`,
      '',
      TRIAGE_PROMPT.rubric(intent),
      '',
      'Report, for each snapshot:',
      '',
      '### <snapshot>: <verdict>',
      '- Verdict: glitch, intended change, bug or possible bug',
      '- Confidence: high, medium or low, and what would raise it',
      '- Evidence: the signals and what you saw in the images that decided it',
      `- Next step: ${TRIAGE_PROMPT.nextSteps}`,
      '',
      'End with one line that counts each verdict.',
      '',
      TRIAGE_PROMPT.approvalRule,
    ].join('\n');
  },
};

/** The tool metadata for this server run, given the approval-prompt setting. */
export type ToolName = keyof typeof TOOL_META;

export function toolMetaFor({ approvalPrompt }: { approvalPrompt: boolean }): Record<ToolName, ToolMeta> {
  if (approvalPrompt) return TOOL_META;
  const { _meta: _snapshot, ...approveSnapshot } = TOOL_META.approve_snapshot;
  const { _meta: _all, ...approveAll } = TOOL_META.approve_all;
  return { ...TOOL_META, approve_snapshot: approveSnapshot, approve_all: approveAll };
}
