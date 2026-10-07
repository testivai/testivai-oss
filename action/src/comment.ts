/**
 * PR comment builder for TestivAI visual reports
 */

import type { ResultsData, SnapshotResult } from './types';
import { STATUS_CONTEXT } from './status';

export const UPSERT_MARKER = '<!-- testivai-visual-report -->';

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
 * Render the DOM noise hint inside the <details> body for a changed
 * snapshot. Mirrors the witness HTML report wording so reviewers see
 * the same signal in the PR comment.
 *
 * Returns empty string when the snapshot has no DOM data — better than
 * a confusing "no signal available" line.
 */
function renderDomHintMarkdown(snapshot: SnapshotResult): string {
  const lines: string[] = [];

  // Verdict priority mirrors the witness report: style-only change (real)
  // > page shift (injected content) > structural DOM change > render noise.
  if (snapshot.dom?.styleCheck === 'mismatch' && snapshot.dom.styleChanges) {
    const n = snapshot.dom.styleChanges.count;
    const first = snapshot.dom.styleChanges.elements[0];
    const el = first ? ` (\`${first.split(' > ').slice(-1)[0]}\`${n > 1 ? ', …' : ''})` : '';
    lines.push(`> **Style-only change — real, not noise** — ${n} element${n === 1 ? '' : 's'} restyled with identical DOM${el}.`);
  }

  if (snapshot.pageShift) {
    const p = snapshot.pageShift;
    lines.push(`> **Layout shift** — everything below y=${p.belowY} moved ${p.dy > 0 ? 'down' : 'up'} ${Math.abs(p.dy)}px (${p.count} elements together). Look *above* that line for inserted/removed content.`);
  }

  if (snapshot.dom && !(snapshot.dom.styleCheck === 'mismatch' && snapshot.dom.styleChanges)) {
    if (snapshot.dom.noiseHint) {
      // An identical DOM does not rule out a stylesheet-only change unless the
      // computed styles were compared too; say which, as the witness report does.
      const styleNote =
        snapshot.dom.styleCheck === 'match'
          ? ' Styles verified unchanged.'
          : snapshot.dom.styleCheck === 'unavailable'
            ? ' (Style check unavailable — no comparable style digests on both sides.)'
            : '';
      lines.push(`> **DOM unchanged** — pixel diff is likely render noise (anti-aliasing, font hinting).${styleNote}`);
    } else {
      const s = snapshot.dom.summary;
      if (s) {
        const parts: string[] = [];
        if (s.added > 0) parts.push(`${s.added} added`);
        if (s.removed > 0) parts.push(`${s.removed} removed`);
        if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute change${s.attributeChanges === 1 ? '' : 's'}`);
        if (s.textChanges) parts.push(`${s.textChanges} text change${s.textChanges === 1 ? '' : 's'}`);
        lines.push(`> **DOM changed** — ${parts.join(', ') || 'structural difference'}.`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
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
): string {
  const { summary, snapshots } = results;

  // Header summary line
  const summaryLine = [
    `**${summary.passed} passed**`,
    `**${summary.changed} changed**`,
    `**${summary.newSnapshots} new**`,
  ].join(' | ');

  let comment = `${marker}

### TestivAI Visual Report

${summaryLine} — **${summary.total} total**

`;

  // Artifact link — gives reviewers direct access to baseline/current/diff images
  if (artifactUrl) {
    comment += `> [Download visual report ZIP](${artifactUrl}) — contains baseline, current, and diff images\n\n`;
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
    for (const snapshot of changedSnapshots) {
      const diffPercent = formatDiffPercent(snapshot);
      const domHint = renderDomHintMarkdown(snapshot);

      comment += `<details>
<summary><code>${snapshot.name}</code> — ${diffPercent}% different</summary>

${domHint}
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
      comment += `- \`${snapshot.name}\`\n`;
    }
    comment += '\n';
  }

  comment += '---\n> Pixel-exact comparison — dynamic content (images, fonts, animations) may cause false positives. An identical DOM points to render noise, and rules out a stylesheet-only change only when the hint also says "Styles verified unchanged". Reviewing with an AI agent? [`@testivai/mcp`](https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md) serves this report as structured data (`explain_snapshot`).\n\n*Generated by [TestivAI](https://github.com/testivai/testivai-oss)*\n';

  return comment;
}

/**
 * Build simple message for empty results
 */
export function buildEmptyComment(
  artifactUrl?: string,
  marker: string = UPSERT_MARKER,
): string {
  const link = artifactUrl
    ? `\n> [Download visual report ZIP](${artifactUrl})\n`
    : '';

  return `${marker}

### TestivAI Visual Report

No visual snapshots were captured in this test run.
${link}
---
*Generated by [TestivAI](https://testiv.ai)*
`;
}
