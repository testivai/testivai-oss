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

// The crop numbers are CROP_LIMITS in diff-images.ts, written out because
// this file imports nothing (the review action bundles it); tests compare them.
const diffImages: ToolMeta = {
  title: 'View snapshot diff images',
  description:
    'Return the baseline, current, and diff images for one changed snapshot so you can see what changed visually: ' +
    'the full page downscaled to fit (it shows where the changes are), then, when it had to be downscaled, each changed region cropped at native scale with 32 px around it and as wide as the page (up to 1280 px), ' +
    'so you can read text, wrapping and clipping there (up to 3 crops, each at most 1280×1024 px and 2,000,000 px in all; ' +
    'nearby regions share a crop, changes come before shifts, a wider area is sampled at 1/2 scale or smaller, and a taller one shows its top rows). ' +
    'Pass `region` (an index the response lists) for another region, or `y` and `height` for any band of the page: those return only that crop; ' +
    'for a missing baseline (no capture this run), only the committed baseline image, since there is no current capture. ' +
    'Use get_report / get_visual_results first to find snapshot names.',
};

export const TOOL_META = {
  get_visual_results: {
    title: 'Get visual test results',
    description:
      'Read the latest TestivAI visual regression results (visual-report/results.json). ' +
      'Returns a per-snapshot verdict combining the pixel diff with the DOM and computed-style signals. ' +
      'A pixel diff is likely render noise when the DOM and the computed styles both match and the diff is small and scattered; ' +
      'a diff whose DOM and computed styles match but that is concentrated in one area or over 1% of pixels gets its own verdict, not noise: ' +
      'it is a bad capture or a change the style check does not cover (size, overflow, transform, images…), so look at the diff (get_diff) before approving; ' +
      'when the environment the snapshot was captured in changed since the baseline (a browser build, OS or distro, device scale, capture method…) ' +
      'and the DOM and computed styles match, the verdict is rendering drift: the machine changed, not the page, never noise; ' +
      'when a web font or stylesheet failed to load in the current capture or the baseline (captureHealth), the verdict is unhealthy capture, said before anything else: ' +
      'a glitch of the capture or a broken asset, never noise even when the DOM and computed styles match, and never to be approved as a baseline; ' +
      'a style-only change (identical DOM, different computed styles) is a real change, not noise, ' +
      'and so is any DOM change — both need human review. ' +
      'When the styles were not compared (style check unavailable), the verdict says so and does not call the diff noise: ' +
      'with an identical DOM it could be render noise or a stylesheet-only change, so look at the diff (get_diff) before approving. ' +
      'Missing baselines (committed baselines that got no capture this run: a test removed, renamed or skipped, or one that failed before it captured) ' +
      'get their own line: there is nothing to approve, and an intended removal deletes the baseline directory. ' +
      'Run the test suite first (e.g. `npx playwright test`) if results are stale or missing.',
  },
  // `get_diff` is the canonical name; `get_snapshot_diff` is kept as an alias.
  get_diff: diffImages,
  get_snapshot_diff: diffImages,
  get_report: {
    title: 'Get the raw visual report (results.json)',
    description:
      'Return the machine-readable results.json payload verbatim (summary + per-snapshot status, diff %, ' +
      'DOM signal, and region→selector attribution, plus missingBaselines: committed baselines with no capture this run). ' +
      'Parse this instead of scraping CLI output.',
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
      'interpretation guidance. Use this to explain WHY a diff happened — pair with get_diff for the images. ' +
      'For a missing baseline (no capture this run) it returns status "missing", the committed baseline files and what to check instead.',
  },
} satisfies Record<string, ToolMeta>;

/**
 * The `review-visual-changes` prompt. It tells the model how to sort each
 * diff, so it uses the same cases as the verdicts in lib.ts: likely render
 * noise only when the DOM and computed styles both match and the diff is
 * small and scattered, a matching-styles diff concentrated in one area or
 * large is a bad capture or a change the style check does not cover, and an
 * identical DOM whose styles were not compared is unknown, not noise.
 */
export const REVIEW_PROMPT = {
  name: 'review-visual-changes',
  title: 'Review visual changes',
  description: 'Walk the latest visual results and produce a human-quality review: what changed, why, and what to do.',
  text: [
    'Review the latest TestivAI visual regression results in this project:',
    '',
    '1. Call get_report for the summary. If nothing changed, nothing is new and no baseline is missing (missingBaselines), say so and stop.',
    '2. For every changed snapshot and every missing baseline, call explain_snapshot(name) and read its layers and guidance.',
    '   When the evidence is ambiguous, call get_diff(name) and inspect the images.',
    '3. For each snapshot, explain in one short paragraph WHAT changed (name the selectors),',
    '   WHY it likely happened (use pageShift/shift classifications — e.g. content injected above),',
    '   and which case it is:',
    '   - an unhealthy capture (the verdict says so: a web font or stylesheet failed to load in the current capture or the baseline):',
    '     never noise; fix what failed (the page, the server or the test) and re-run, and never approve it as a baseline,',
    '   - likely render noise (identical DOM and computed styles match, and the diff is small and scattered; still not proof),',
    '   - rendering drift (identical DOM and computed styles match, and the environment changed since the baseline:',
    '     a browser build, OS or distro, device scale or capture method; the verdict names it): the machine changed, not the page,',
    '     so compare the images (get_diff) and, if they match apart from rendering, re-baseline once the human agrees; never call it noise,',
    '   - concentrated in one area or large (identical DOM and computed styles match, but the diff sits in one area',
    '     or is over 1% of pixels): a bad capture or a change the style check does not cover, so call get_diff(name)',
    '     and compare the images; do not call it noise,',
    '   - a style-only change (identical DOM, computed styles differ: a real change),',
    '   - a missing baseline (in missingBaselines: no capture this run, so no current image): its test was removed, renamed,',
    '     skipped or failed before its capture; explain_snapshot(name) says what to check, and approving does nothing for it,',
    '   - a structural change (the DOM changed), or',
    '   - styles not compared (identical DOM, style check unavailable):',
    '     could be render noise or a stylesheet-only change, so call get_diff(name)',
    '     and compare the images; do not call it noise.',
    '4. End with a recommendation per snapshot: approve (once the human confirms), investigate,',
    '   or likely noise (mention it, do not block on it; only for the likely-render-noise case);',
    '   for a missing baseline: delete its baseline directory once the human confirms the removal',
    '   was intended, otherwise investigate (approving does nothing).',
    '   Never call approve_snapshot/approve_all yourself unless the human has explicitly',
    '   confirmed the changes are intended — baseline approval is a human decision.',
  ].join('\n'),
};

/** A path quoted for a shell when it holds anything but plain path characters (shared with lib.ts). */
export const shellArg = (s: string): string => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * What to recommend per verdict. The removal command for a missing baseline
 * names `baselinesDir` (the project's own, `{platform}` resolved), because a
 * copied default path fails where baselines live elsewhere; quoted when the
 * shell would split it, and `.` for the project root itself.
 */
function nextStepsFor(baselinesDir = '.testivai/baselines'): string {
  const dir = shellArg(baselinesDir.replace(/[`\r\n]/g, '') || '.');
  return (
    'for an intended change, approve it once the human agrees (`/testivai approve <name>` on the pull request, or `npx testivai approve <name>` locally); for a bug, what to fix; for a possible bug, what to check; for a glitch, re-run the tests or replace the baseline from a capture two runs agree on (for an unhealthy capture, fix what failed to load first; an unhealthy baseline is re-baselined from a healthy run); ' +
    `for a missing baseline, approving does nothing (it only promotes a new capture): an intended removal deletes its baseline directory (for example \`git rm -r ${dir}/<name>\`) in the same change, and a bug restores the test or its capture.`
  );
}

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
    snapshot: 'Snapshot or missing baseline to triage. Leave empty to triage every changed or new snapshot and every missing baseline.',
    intent: 'What the change under test was meant to do, for example the pull request description. Leave empty to have the model look for it.',
  },
  /** What to recommend per verdict, for the default baselines directory; shared with the CI review. */
  nextSteps: nextStepsFor(),
  /** The same, naming the project's own baselines directory in the removal command. */
  nextStepsFor,
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
      'Evidence: start with get_visual_results, then call explain_snapshot for each snapshot you triage and get_diff to look at its baseline, current and diff images (for a missing baseline, get_diff returns only its committed screenshot). The full-page images are downscaled to fit and show where the changes are; judge text, wrapping and clipping from the crops of the changed regions that follow them, at native scale (get_diff with `region` or `y` and `height` crops another area). The signals say whether the page changed; the images say whether it looks right and which capture is off. Weigh them together:',
      '',
      '| explain_snapshot shows | What it means |',
      '|---|---|',
      '| captureHealth.unhealthy set (the verdict says "unhealthy capture") | A web font or stylesheet failed to load, or fonts were still loading, in the current capture or the baseline (captureHealth.reasons says what), so that image does not show the page as built and its diff is never render noise: an unhealthy capture is a glitch of the capture or a broken asset; fix the page, the server or the test; never approve it as a baseline. It is a glitch unless the change under test touched the asset that failed (moved, renamed or removed a font or stylesheet, or changed its path): then it is a bug. When the baseline is the unhealthy side, the next step is to re-baseline from a healthy run. When captureHealth.sameOnBothSides is true, the baseline failed the same way: the diff compares like with like and the pass tolerances (maxDiffPercent, maxDiffPixels, shiftTolerance) applied, never noise auto-pass; judge the diff itself, and name the broken asset as something to fix. captureHealth.warnings (broken images, failed scripts) make no capture unhealthy: weigh a broken image where it sits in the diff. |',
      '| dom.changed true, or styleCheck "mismatch" | The page really changed, so this is never a glitch: decide between intended change, bug and possible bug. A DOM change can restyle elements too (a class change); judge the elements styleChanges lists. |',
      '| pageShift | Content was inserted or removed above pageShift.belowY and the moved elements are unchanged: triage what was inserted or removed, not what moved. |',
      '| environment.renderingDelta non-empty, DOM unchanged and styleCheck "match" (rendering drift) | The environment the snapshot was captured in changed since the baseline (the verdict names what: a browser build, OS or distro, device scale, capture method) and the page did not: a glitch of the environment, not render noise. If the change under test itself changed the environment (a Playwright or browser upgrade, a new CI image), it is an intended change. Either way the next step is to re-baseline from this environment once the images match apart from rendering; if they differ in more than rendering, judge that difference on its own. |',
      '| DOM unchanged and styleCheck "match" | Usually render noise, but only when the diff is small and scattered. A larger diff, or one confined to one area, is either a bad capture or a change the style check cannot see: it compares colors, fonts, borders, spacing, display, opacity, visibility and shadows, and does not cover size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets. See "Bad captures" below. |',
      '| DOM unchanged, styleCheck "unavailable" or missing | Styles not compared: it could be render noise or a stylesheet-only change, so it is not a glitch on the DOM evidence alone. Look at the images; a visible styling difference is a real change, and the signs of a bad capture listed below can also come from a stylesheet change here. |',
      '| status "new" | There is no baseline to compare with: check the capture itself for obvious defects. |',
      '| status "missing" (in missingBaselines) | A committed baseline got no capture this run: there is no current image, and the report cannot tell a removed or renamed test from a skipped or failing one. Read the change under test. It removed or renamed that test or snapshot on purpose (the intent covers it): intended change. It removed or renamed it without meaning to (the intent does not cover it; for a rename, a new snapshot under the other name is the other half), or broke what the test needs to reach its capture (the page, a selector it waits for): bug. Otherwise possible bug: tell a person to check the test run\'s log for a failed or skipped test. Never a glitch on this evidence: there is no capture to call bad. |',
      '',
      'Unchanged DOM: no element, attribute or text differs between the baseline and the current capture (the DOM diff compares text too). The baseline is the last approved capture, and it can already contain the change under test (a copy edit approved earlier on the same branch), so a text or markup edit in the change under test never explains an identical-DOM diff, even where its regions sit on text the change edited. Only something the DOM does not record can: a stylesheet change the style check does not cover, an image, a font or another asset, the environment it was captured in (rendering drift, above), or the capture itself. If the change under test touched none of those, it is not an intended change: call it a glitch or a possible bug.',
      '',
      'Bad captures: render noise is small and scattered (anti-aliasing and font hinting at the edges of glyphs). When the DOM is unchanged and styleCheck is "match" but the diff is larger or sits in one area, compare the two images. A block of content shifted with nothing inserted, text drawn at a different size in one place, content cut off, or background where content belongs can be a bad capture, or a change to something the style check does not cover. Look at what the change under test touched: if it changed CSS, an image, a font or another asset that could reach that area, judge it as a real change (intended change, bug or possible bug; an edit to text or markup cannot cause it, since the DOM is unchanged). Call it a glitch only when nothing in the change could have caused it, and say which image is wrong: if it is the baseline itself, it has to be replaced from a capture that two runs agree on; if it is the current capture, re-run the tests. If you cannot see what the change touched, say so, and call it a glitch only if the images clearly show a broken capture (a torn, half-drawn or partly blank render); otherwise a possible bug.',
      '',
      'Intent: judge intended change against bug by what the change under test was meant to do.',
      ...intentText,
      'Compare the elements that changed (the selectors in regions and styleChanges) with what the change touched: an element it did not touch, or a result that looks broken, is a bug even when the intent mentions the page.',
    ].join('\n');
  },
  textFor({ snapshot, intent, baselinesDir }: { snapshot?: string; intent?: string; baselinesDir?: string }): string {
    const name = snapshot?.replace(/[`\r\n]/g, '').trim();
    const target = name ? `snapshot \`${name}\`` : 'every changed or new snapshot and every missing baseline';
    return [
      `Triage ${target} in this project's latest TestivAI visual results: for each one, decide whether the diff is a glitch, an intended change, a bug or a possible bug, and say what to do next.${name ? ' If it is neither a snapshot nor a missing baseline in the results, or it passed without an auto-pass, say so and stop. If it auto-passed, say which criterion passed it, and triage it anyway when its verdict says the styles were not compared. If it is a missing baseline (listed in missingBaselines), triage it by the status "missing" row below: do not stop because it has no capture.' : ''}`,
      '',
      TRIAGE_PROMPT.rubric(intent),
      '',
      'Report, for each snapshot:',
      '',
      '### <snapshot>: <verdict>',
      '- Verdict: glitch, intended change, bug or possible bug',
      '- Confidence: high, medium or low, and what would raise it',
      '- Evidence: the signals and what you saw in the images that decided it',
      `- Next step: ${nextStepsFor(baselinesDir)}`,
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
