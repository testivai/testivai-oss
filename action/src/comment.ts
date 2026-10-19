/**
 * PR comment builder for TestivAI visual reports
 */

import { describeRegions, diffShape, STYLE_CHECK_DOES_NOT_COVER } from '../../packages/witness/src/report/diff-shape';
import { describeSizeChange, explainHeightChange, formatSizeMismatch, formatSizes, sizeMismatchKind } from '../../packages/witness/src/report/size-mismatch';
import { snapshotAnchorId } from '../../packages/witness/src/report/anchor';
import {
  describeCaptureMethod,
  environmentChangeGroups,
  environmentChangeLine,
  isRenderingDrift,
  snapshotEnvironmentChange,
} from '../../packages/witness/src/report/environment';
import type { ResultsData, SnapshotResult } from './types';
import { STATUS_CONTEXT } from './status';

export const UPSERT_MARKER = '<!-- testivai-visual-report -->';

/** Links from the comment into a published copy of the HTML report. */
export interface CommentLinks {
  /**
   * Where this run's HTML report is published (e.g. GitHub Pages). The
   * comment links it, and each changed or new snapshot's card in it. Only an
   * https URL that cannot break out of a Markdown link or an HTML attribute
   * is used; anything else is ignored.
   */
  reportUrl?: string;
  /**
   * The CI run the comment describes (`<run id>-<attempt>`), kept in a hidden
   * marker so a later update can check the comment is still about that run.
   */
  runKey?: string;
  /**
   * Published thumbnails (thumb.png: baseline | current | diff of the changed
   * area) of changed snapshots, by snapshot name. At most
   * MAX_COMMENT_THUMBNAILS are shown, only with `reportUrl`, and only an
   * https URL inside the report URL is used.
   */
  thumbnails?: Array<{ name: string; url: string }>;
}

/** The most thumbnails one comment shows. */
export const MAX_COMMENT_THUMBNAILS = 5;

/** How many of the snapshots with a thumbnail are expanded (`<details open>`), so the pictures show without a click. */
const OPEN_WITH_THUMBNAIL = 3;

const RUN_MARKER = /<!-- testivai-run:([A-Za-z0-9_-]+) -->/;

/** The run a comment describes, from its hidden marker; undefined for comments without one. */
export function readRunKey(body: string): string | undefined {
  return RUN_MARKER.exec(body)?.[1];
}

/** `<run id>-<attempt>` of the current GitHub Actions run, or undefined outside one. */
export function runKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const id = env.GITHUB_RUN_ID;
  if (!id) return undefined;
  return `${id}-${env.GITHUB_RUN_ATTEMPT || '1'}`;
}

/** The hidden run marker line, or '' when there is no usable run key. */
function runMarkerLine(runKey?: string): string {
  const safe = (runKey ?? '').replace(/[^A-Za-z0-9_-]/g, '').replace(/-{2,}/g, '-');
  return safe ? `\n<!-- testivai-run:${safe} -->` : '';
}

/**
 * The report URL without its #fragment, when it is safe to put in a Markdown
 * link and an HTML attribute: https, and no whitespace, quotes, angle
 * brackets, parentheses, backticks or backslashes. Otherwise undefined.
 */
export function safeReportUrl(url?: string): string | undefined {
  if (!url || /[\s"'<>()`\\]/.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  parsed.hash = '';
  return parsed.toString();
}

/** A snapshot's card in the published report. */
function snapshotUrl(reportUrl: string, name: string): string {
  return `${reportUrl}#${snapshotAnchorId(name)}`;
}

/** Escape a URL for an HTML attribute in the comment. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Escape text (a snapshot name, which comes from the pull request) for an HTML attribute: markup, quotes and control characters. */
function attrText(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The thumbnail URL for each snapshot name: only with a report URL, and only
 * an https URL that passes safeReportUrl and lies inside the report URL.
 */
function thumbnailUrls(reportUrl: string | undefined, thumbnails: CommentLinks['thumbnails']): Map<string, string> {
  const urls = new Map<string, string>();
  if (!reportUrl) return urls;
  for (const t of thumbnails ?? []) {
    const url = safeReportUrl(t.url);
    if (url?.startsWith(reportUrl) && !urls.has(t.name)) urls.set(t.name, url);
  }
  return urls;
}

/**
 * Resolve the PR comment upsert marker for a status context. The default
 * context keeps the legacy bare marker so comments on existing PRs keep
 * being updated in place; custom contexts get a namespaced marker so
 * multiple visual lanes in one repo don't overwrite each other's comments.
 * The context is sanitized because '--' or '>' inside an HTML comment
 * would terminate the marker early.
 */
export function resolveUpsertMarker(statusContext: string): string {
  if (statusContext === STATUS_CONTEXT) return UPSERT_MARKER;
  const safe = statusContext.replace(/-{2,}/g, '-').replace(/[<>]/g, '');
  return `<!-- testivai-visual-report:${safe} -->`;
}

/**
 * Format the diff percentage for a snapshot, accepting both the new
 * (`diffPercent`) and older (`diffPercentage`) field names.
 */
function formatDiffPercent(snapshot: SnapshotResult): string {
  const value = snapshot.diffPercent ?? snapshot.diffPercentage ?? 0;
  return value.toFixed(2);
}

/**
 * Render the DOM / style verdict inside the <details> body for a changed
 * snapshot, so reviewers see the same signal as the witness HTML report.
 *
 * When the pixels differ and the DOM is identical, the style check decides
 * what that means:
 *   - 'match': likely render noise (still not proof) when the diff is small
 *     and scattered; concentrated in one area or large (diffShape in
 *     @testivai/witness), a bad capture or a change the style check does not
 *     cover, never called noise;
 *   - 'mismatch': a real style-only change;
 *   - 'unavailable', or no styleCheck (older results.json): the styles were
 *     not compared, so render noise and a stylesheet-only change are both
 *     still possible. Never call this case noise.
 *
 * Returns empty string when the snapshot has no DOM data — better than
 * a confusing "no signal available" line.
 */
function renderDomHintMarkdown(
  snapshot: SnapshotResult,
  include: { size?: boolean; identicalDom?: boolean } = {},
): string {
  const lines: string[] = [];
  const { size: withSize = true, identicalDom: withIdenticalDom = true } = include;

  // A size change first: the diff is on a padded canvas (every padded pixel
  // counts as changed), so the identical-DOM readings below describe the
  // padding and are withheld. A height change is read with the DOM signal
  // and the page shift (explainHeightChange: the band at the bottom is the
  // new height, not where the change is); a width change is the viewport or
  // device scale, never the page.
  const size = withSize ? snapshot.sizeMismatch : undefined;
  const heightChange = Boolean(size && sizeMismatchKind(size) === 'height');
  if (size) {
    const change = `**Size changed — ${describeSizeChange(size)}** (${formatSizes(size)})`;
    if (!heightChange) {
      lines.push(`> ${change}, so this is not a page change; the diff is on a padded canvas and does not describe the page. Re-capture at the baseline's viewport and device scale, or re-baseline if the new size is intended.`);
    } else {
      const identical = Boolean(snapshot.dom && !snapshot.dom.changed);
      const closing = identical ? 'Compare the images before approving.' : 'Compare the images and confirm the change is intended before approving.';
      lines.push(`> ${change}: ${explainHeightChange(size, { dom: snapshot.dom, pageShift: snapshot.pageShift })}. ${closing}`);
    }
  }

  // Verdict priority mirrors the witness report: style-only change (real)
  // > page shift (injected content) > structural DOM change > identical DOM
  // (likely noise only when the styles were compared and matched).
  // Style-only only when the DOM is unchanged: a class or style attribute
  // change restyles elements too, and is reported as a DOM change below.
  const styleChanges = snapshot.dom?.styleCheck === 'mismatch' ? snapshot.dom.styleChanges : undefined;
  const styleOnly = Boolean(styleChanges && !snapshot.dom?.changed);
  if (styleOnly && styleChanges) {
    const n = styleChanges.count;
    const first = styleChanges.elements[0];
    const el = first ? ` (\`${first.split(' > ').slice(-1)[0]}\`${n > 1 ? ', …' : ''})` : '';
    lines.push(`> **Style-only change — real, not noise** — ${n} element${n === 1 ? '' : 's'} restyled with identical DOM${el}.`);
  }

  // A height change's line above already places a page shift.
  if (snapshot.pageShift && !(heightChange && snapshot.pageShift.dy !== 0)) {
    const p = snapshot.pageShift;
    lines.push(`> **Layout shift** — everything below y=${p.belowY} moved ${p.dy > 0 ? 'down' : 'up'} ${Math.abs(p.dy)}px (${p.count} elements together). Look *above* that line for inserted/removed content.`);
  }

  if (snapshot.dom && !styleOnly) {
    if (snapshot.dom.noiseHint && (size || !withIdenticalDom)) {
      // Identical DOM on a padded canvas: the size line above says it all.
    } else if (snapshot.dom.noiseHint) {
      // An identical DOM rules out a stylesheet-only change only when the
      // computed styles were compared too. 'unavailable' and a missing
      // styleCheck (older results.json) mean they were not: unknown, not noise.
      if (snapshot.dom.styleCheck === 'match') {
        const shape = diffShape({ ...snapshot, diffPercent: snapshot.diffPercent ?? snapshot.diffPercentage });
        if (shape.kind === 'concentrated') {
          lines.push(`> **DOM and styles unchanged, but the diff is concentrated in one area** — ${describeRegions(shape)}: a bad capture, or a change the style check does not cover (${STYLE_CHECK_DOES_NOT_COVER}). Compare the images before approving.`);
        } else if (shape.kind === 'large') {
          lines.push(`> **DOM and styles unchanged, but the diff is large** — ${formatDiffPercent(snapshot)}% of pixels differ, spread across the page: more than render noise usually changes (often fonts or rendering that differ between machines). Compare the images before approving.`);
        } else {
          lines.push('> **DOM unchanged** — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.');
        }
      } else {
        lines.push('> **DOM unchanged, styles not compared** — could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.');
      }
    } else {
      const s = snapshot.dom.summary;
      if (s) {
        const parts: string[] = [];
        if (s.added > 0) parts.push(`${s.added} added`);
        if (s.removed > 0) parts.push(`${s.removed} removed`);
        if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute change${s.attributeChanges === 1 ? '' : 's'}`);
        if (s.textChanges) parts.push(`${s.textChanges} text change${s.textChanges === 1 ? '' : 's'}`);
        const alsoRestyled = styleChanges
          ? ` Computed styles also changed on ${styleChanges.count} element${styleChanges.count === 1 ? '' : 's'} (${styleChanges.elements
              .slice(0, 3)
              .map((p) => `\`${p.split(' > ').slice(-1)[0]}\``)
              .join(', ')}${styleChanges.count > 3 ? ', …' : ''}).`
          : '';
        lines.push(`> **DOM changed** — ${parts.join(', ') || 'structural difference'}.${alsoRestyled}`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * The hints for one changed snapshot, environment first: environmentPolicy
 * "strict", a size change from another capture method, and rendering drift
 * (identical DOM, matching styles, a changed rendering environment) each
 * replace the reading they explain; any other reading gets the environment
 * change as context. Without a recorded environment, the page-side hints only.
 */
function renderSnapshotHints(snapshot: SnapshotResult): string {
  const change = snapshotEnvironmentChange(snapshot);
  if (!change) return renderDomHintMarkdown(snapshot);
  const env = snapshot.environment!;
  if (env.policy === 'strict') {
    return (
      `> **Environment changed (strict policy)** — ${change} since the baseline; environmentPolicy "strict" makes it changed whatever its pixels say. Approving re-baselines it in this environment.\n\n` +
      renderDomHintMarkdown(snapshot)
    );
  }
  if (snapshot.sizeMismatch && env.baseline && env.candidate && env.renderingDelta.includes('adapter.captureMethod')) {
    const from = describeCaptureMethod(env.baseline.adapter.captureMethod);
    const to = describeCaptureMethod(env.candidate.adapter.captureMethod);
    return (
      `> **Capture method changed** — ${from} → ${to} since the baseline (${formatSizes(snapshot.sizeMismatch)}): the size change comes from how the screenshot was taken, not from the page. Re-baseline with this capture method, or capture the way the baseline was.\n\n` +
      renderDomHintMarkdown(snapshot, { size: false, identicalDom: false })
    );
  }
  if (isRenderingDrift(snapshot)) {
    const size = snapshot.sizeMismatch ? ` That also explains the size change (${formatSizeMismatch(snapshot.sizeMismatch)}).` : '';
    return (
      `> **Rendering drift** — ${change} since the baseline, and the DOM and computed styles are identical: the machine changed, not the page. Re-baseline once the images are confirmed to match apart from rendering.${size}\n\n` +
      renderDomHintMarkdown(snapshot, { size: false, identicalDom: false })
    );
  }
  return (
    renderDomHintMarkdown(snapshot) +
    `> The environment also changed since the baseline (${change}), which can add rendering differences of its own.\n\n`
  );
}

/**
 * Build markdown PR comment from results.
 *
 * @param results      Parsed results.json
 * @param artifactUrl  Optional link to the workflow run where the
 *                     visual report artifact can be downloaded.
 * @param marker       Upsert marker identifying this lane's comment
 *                     (from resolveUpsertMarker).
 */
export function buildComment(
  results: ResultsData,
  artifactUrl?: string,
  marker: string = UPSERT_MARKER,
  links: CommentLinks = {},
): string {
  const { summary, snapshots } = results;
  const reportUrl = safeReportUrl(links.reportUrl);
  const thumbnails = thumbnailUrls(reportUrl, links.thumbnails);

  // Header summary line
  const summaryLine = [
    `**${summary.passed} passed**`,
    `**${summary.changed} changed**`,
    `**${summary.newSnapshots} new**`,
  ].join(' | ');

  let comment = `${marker}${runMarkerLine(links.runKey)}

### TestivAI Visual Report

${summaryLine} — **${summary.total} total**

`;

  // The published report opens in the browser; the ZIP stays as the fallback.
  if (reportUrl) {
    const zip = artifactUrl ? ` · or [download it as a ZIP](${artifactUrl})` : '';
    comment += `> **[Open the visual report](${reportUrl})** — baseline, current and diff side by side${zip}\n\n`;
  } else if (artifactUrl) {
    // Artifact link — gives reviewers direct access to baseline/current/diff images
    comment += `> [Download visual report ZIP](${artifactUrl}) — contains baseline, current, and diff images\n\n`;
  }

  // An environment change shared by two or more snapshots, said once here;
  // a single snapshot's own lines already say it.
  for (const group of environmentChangeGroups(snapshots).filter((g) => g.snapshots.length >= 2)) {
    const line = environmentChangeLine(group).replace(/^Environment changed since the baselines/, '**Environment changed since the baselines**');
    const names = group.snapshots.slice(0, 10).map((n) => `\`${n}\``).join(', ') + (group.snapshots.length > 10 ? ', …' : '');
    comment += `> ${line} Snapshots: ${names}.\n\n`;
  }

  // Coverage-loss warning: baselines that received no capture this run.
  // A deleted/renamed test silently stops guarding its page — surface it
  // where the reviewer is looking.
  const missing = results.missingBaselines ?? [];
  if (missing.length > 0) {
    comment += `> **${missing.length} baseline${missing.length === 1 ? '' : 's'} received no capture this run** — ${missing.slice(0, 5).map(n => `\`${n}\``).join(', ')}${missing.length > 5 ? ', …' : ''}. If a test was removed intentionally, delete its baseline; otherwise coverage just shrank.\n\n`;
  }

  // Changed snapshots — approve commands + DOM hints
  const changedSnapshots = snapshots.filter(s => s.status === 'changed');
  if (changedSnapshots.length > 0) {
    comment += '#### Changed Snapshots\n\n';
    let shown = 0;
    for (const snapshot of changedSnapshots) {
      const diffPercent = formatDiffPercent(snapshot);
      const domHint = renderSnapshotHints(snapshot);
      const size = snapshot.sizeMismatch ? ` · ${formatSizeMismatch(snapshot.sizeMismatch)}` : '';
      // On the row itself, so it works without expanding the details.
      const open = reportUrl ? ` · <a href="${attr(snapshotUrl(reportUrl, snapshot.name))}">open in report</a>` : '';
      // The published thumbnail (baseline | current | diff of the changed
      // area) leads the details, linked to the snapshot's card; the first
      // few with one are expanded so the pictures show without a click.
      const thumb = reportUrl && shown < MAX_COMMENT_THUMBNAILS ? thumbnails.get(snapshot.name) : undefined;
      if (thumb) shown++;
      const picture = thumb && reportUrl
        ? `<a href="${attr(snapshotUrl(reportUrl, snapshot.name))}"><img src="${attr(thumb)}" alt="${attrText(`${snapshot.name}: baseline, current, diff`)}"></a>\n\n`
        : '';
      const expanded = thumb && shown <= OPEN_WITH_THUMBNAIL ? ' open' : '';

      comment += `<details${expanded}>
<summary><code>${snapshot.name}</code> — ${diffPercent}% different${size}${open}</summary>

${picture}${domHint}
\`\`\`
/testivai approve ${snapshot.name}
\`\`\`

</details>

`;
    }

    // Bulk approve shortcut
    comment += `> To approve all at once: comment \`/testivai approve --all\` on this PR\n\n`;
  }

  // New snapshots
  const newSnapshots = snapshots.filter(s => s.status === 'new');
  if (newSnapshots.length > 0) {
    comment += '#### New Snapshots\n\n';
    for (const snapshot of newSnapshots) {
      const open = reportUrl ? ` — [open](${snapshotUrl(reportUrl, snapshot.name)})` : '';
      comment += `- \`${snapshot.name}\`${open}\n`;
    }
    comment += '\n';
  }

  comment += '---\n> Content that changes between runs (timestamps, ads, rotating images) can show up as a pixel diff unless you hide it with `ignoreSelectors` or exclude it with `mask`. An identical DOM points to render noise only when the styles are verified unchanged and the diff is small and scattered, as the hint then says; otherwise a stylesheet-only change, a bad capture, or a change the style check does not cover is not ruled out. Reviewing with an AI agent? [`@testivai/mcp`](https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md) serves this report as structured data (`explain_snapshot`).\n\n*Generated by [TestivAI](https://github.com/testivai/testivai-oss)*\n';

  return comment;
}

/**
 * Build simple message for empty results
 */
export function buildEmptyComment(
  artifactUrl?: string,
  marker: string = UPSERT_MARKER,
  links: CommentLinks = {},
): string {
  const reportUrl = safeReportUrl(links.reportUrl);
  const link = reportUrl
    ? `\n> **[Open the visual report](${reportUrl})**${artifactUrl ? ` · or [download it as a ZIP](${artifactUrl})` : ''}\n`
    : artifactUrl
      ? `\n> [Download visual report ZIP](${artifactUrl})\n`
      : '';

  return `${marker}${runMarkerLine(links.runKey)}

### TestivAI Visual Report

No visual snapshots were captured in this test run.
${link}
---
*Generated by [TestivAI](https://testiv.ai)*
`;
}
