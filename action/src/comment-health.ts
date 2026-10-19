/**
 * Capture health in the PR comment (results.json 2.6.0 `captureHealth`):
 * the "Unhealthy capture" reading, said before any environment reading, an
 * unhealthy passed or new snapshot, and the warnings. The words come from
 * @testivai/witness report/health.ts, so the comment, the HTML report and
 * @testivai/mcp agree.
 */
import { captureHealthReading } from '../../packages/witness/src/report/health';
import type { SnapshotResult } from './types';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The Unhealthy capture line for a changed snapshot, or '' when neither side is unhealthy. */
export function unhealthyCaptureHint(snapshot: SnapshotResult): string {
  const reading = captureHealthReading(snapshot.captureHealth);
  if (!reading) return '';
  return `> **Unhealthy capture** — ${reading.detail}. ${capitalize(reading.next)}.\n\n`;
}

/** What else failed to load (broken images, failed scripts): shown with the snapshot, never a reading. */
export function captureWarningsHint(snapshot: SnapshotResult): string {
  const warnings = snapshot.captureHealth?.warnings ?? [];
  if (warnings.length === 0) return '';
  const shown = warnings.slice(0, 5).join('; ') + (warnings.length > 5 ? '; …' : '');
  return `> Capture warnings — ${shown}.\n\n`;
}

/** One line per passed snapshot with an unhealthy capture: nothing changed visibly, but the capture is not the page as built. */
export function unhealthyPassedLines(snapshots: SnapshotResult[]): string {
  const lines: string[] = [];
  for (const snapshot of snapshots.filter((s) => s.status === 'passed')) {
    const reading = captureHealthReading(snapshot.captureHealth);
    if (!reading) continue;
    const who = reading.side === 'both' ? 'neither image shows' : reading.side === 'baseline' ? 'the baseline does not show' : 'the current capture does not show';
    lines.push(`> **Unhealthy capture** — \`${snapshot.name}\` passed, but ${who} the page as built: ${reading.detail}. ${capitalize(reading.next)}.\n\n`);
  }
  return lines.slice(0, 10).join('');
}

/** The suffix on a new snapshot's line when its first capture is unhealthy, or ''. */
export function unhealthyNewSuffix(snapshot: SnapshotResult): string {
  const reading = captureHealthReading(snapshot.captureHealth);
  if (!reading) return '';
  return ` — **unhealthy capture**: ${reading.detail}; do not approve it as the baseline`;
}
