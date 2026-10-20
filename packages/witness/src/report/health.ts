/**
 * TestivAI Report — capture health: when a capture is unhealthy, and the words
 *
 * A capture is UNHEALTHY when what it shows is not the page as built: web
 * fonts were still loading, a web font failed to load (the page rendered with
 * a fallback font), a stylesheet failed to load, or a stylesheet request
 * answered 400 or more. Such a diff is a glitch of the capture or a broken
 * asset, never render noise: the DOM can be identical and the computed styles
 * match (the style digest hashes the declared font-family, not the font that
 * rendered), so without this the diff read "likely render noise".
 *
 * A font request that answered 400 or more makes the capture unhealthy only
 * with a web font that failed, or with no Font Loading API to say none did: a
 * face whose first `src` 404s and whose next one loads rendered as built.
 *
 * Broken images, failed scripts and other requests, and a failed font request
 * while no web font failed, are WARNINGS: recorded and shown, but they do not
 * make a capture unhealthy on their own. A broken image shows as a changed
 * region where it sits, which the pixel and DOM layers already read; telling a
 * broken image that matters from a tracking pixel needs its position compared
 * with the diff's regions (a follow-up).
 *
 * Deterministic and read from results.json fields only (`captureHealth`), so
 * the report, @testivai/mcp and the GitHub Action agree. No Node dependencies.
 */

import type { CaptureHealth, ResourceFailures } from '../capture/health';
import type { SnapshotCaptureHealth } from './results';

export interface HealthAssessment {
  /** True when the capture does not show the page as built (see the module comment). */
  unhealthy: boolean;
  /** What made it unhealthy, short: "a failed web font", "a failed stylesheet", "web fonts still loading". */
  problems: string[];
  /** Why it is unhealthy, in plain words, most important first. */
  reasons: string[];
  /** What else failed to load (images, scripts, other requests, a font file a face fell back from): shown, not unhealthy. */
  warnings: string[];
}

/** Items named per kind before the rest are counted. */
const NAMED = 3;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "stylesheet example.com/a.css returned 404", or "… failed to load (net::ERR_…)" without a status. */
function requestLine(noun: string, entry: ResourceFailures['entries'][number]): string {
  const url = entry.url || '(no URL)';
  if (entry.status > 0) return `${noun} ${url} returned ${entry.status}`;
  return `${noun} ${url} failed to load${entry.error ? ` (${entry.error})` : ''}`;
}

/** One line per named request, then the count of the rest. */
function requestLines(noun: string, entries: ResourceFailures['entries'], total: number): string[] {
  const shown = entries.slice(0, NAMED);
  const lines = shown.map((e) => requestLine(noun, e));
  const rest = total - shown.length;
  if (rest > 0) lines.push(`${plural(rest, `more ${noun}`)} failed to load`);
  return lines;
}

/** Elements that failed (stylesheets, images), named with their request's status when it is known. */
function elementLines(noun: string, urls: string[], total: number, requests: ResourceFailures['entries']): string[] {
  const byUrl = new Map(requests.map((e) => [e.url, e]));
  const shown = urls.slice(0, NAMED);
  const lines = shown.map((url) => {
    const request = byUrl.get(url);
    return request ? requestLine(noun, request) : `${noun} ${url || '(no URL)'} did not load`;
  });
  const rest = total - shown.length;
  if (rest > 0) lines.push(`${plural(rest, `more ${noun}`)} did not load`);
  return lines;
}

function fontLine(families: string[]): string {
  const quoted = families.map((f) => `'${f}'`);
  if (quoted.length === 1) return `web font ${quoted[0]} failed to load, so the page rendered with a fallback font`;
  const names = quoted.length === 2 ? `${quoted[0]} and ${quoted[1]}` : `${quoted.slice(0, 2).join(', ')} and ${quoted.length - 2} more`;
  return `web fonts ${names} failed to load, so the page rendered with fallback fonts`;
}

/** Judge one capture's health: unhealthy or not, why, and what else failed. */
export function assessHealth(health: CaptureHealth): HealthAssessment {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const problems = new Set<string>();
  const failed = health.resources.failed;

  if (health.fonts.status === 'loading') {
    reasons.push('web fonts were still loading when the page was captured');
    problems.add('web fonts still loading');
  }
  const families = [...new Set(health.fonts.failed.map((f) => f.family))];
  if (families.length > 0) {
    reasons.push(fontLine(families));
    problems.add('a failed web font');
  }
  // A failed font request on its own is not a fallback font: the face can
  // load from its next `src`. Unhealthy with a face that failed, or when the
  // page had no Font Loading API to say whether one did.
  if (failed.font && failed.font.count > 0) {
    const lines = requestLines('font file', failed.font.entries, failed.font.count);
    if (families.length > 0 || health.fonts.status === 'unavailable') {
      reasons.push(...lines);
      problems.add('a failed web font');
    } else {
      warnings.push(...lines);
    }
  }

  // A failed <link> stylesheet is named once, with its request's status when
  // the request is known; a failed stylesheet request with no <link> (an
  // @import) gets its own line.
  const css = failed.css ?? { count: 0, entries: [] };
  if (health.stylesheets.failed > 0) {
    reasons.push(...elementLines('stylesheet', health.stylesheets.urls, health.stylesheets.failed, css.entries));
    problems.add('a failed stylesheet');
  }
  const linked = new Set(health.stylesheets.urls);
  const unlinked = css.entries.filter((e) => !linked.has(e.url));
  const unlinkedCount = css.count - (css.entries.length - unlinked.length);
  if (unlinkedCount > 0) {
    reasons.push(...requestLines('stylesheet', unlinked, unlinkedCount));
    problems.add('a failed stylesheet');
  }

  const img = failed.img ?? { count: 0, entries: [] };
  if (health.images.broken > 0) warnings.push(...elementLines('image', health.images.urls, health.images.broken, img.entries));
  const shownImages = new Set(health.images.urls);
  const otherImages = img.entries.filter((e) => !shownImages.has(e.url));
  const otherImageCount = img.count - (img.entries.length - otherImages.length);
  if (otherImageCount > 0) warnings.push(...requestLines('image', otherImages, otherImageCount));
  if (failed.script && failed.script.count > 0) warnings.push(...requestLines('script', failed.script.entries, failed.script.count));
  if (failed.other && failed.other.count > 0) warnings.push(...requestLines('request', failed.other.entries, failed.other.count));

  return { unhealthy: problems.size > 0, problems: [...problems], reasons, warnings };
}

/** Prefix of a reason or warning that is the baseline's, in results.json. */
export const BASELINE_HEALTH_PREFIX = 'baseline: ';

/**
 * The per-snapshot `captureHealth` (schema 2.7.0): both recorded blocks, which
 * side is unhealthy, and the reasons and warnings (the baseline's marked
 * "baseline: "), the current capture's first. Undefined when neither side
 * recorded health: not checked, which is neither healthy nor unhealthy.
 */
export function snapshotCaptureHealth(baseline: CaptureHealth | null, candidate: CaptureHealth | null): SnapshotCaptureHealth | undefined {
  if (!baseline && !candidate) return undefined;
  const c = candidate ? assessHealth(candidate) : null;
  const b = baseline ? assessHealth(baseline) : null;
  const unhealthy = c?.unhealthy && b?.unhealthy ? 'both' : c?.unhealthy ? 'candidate' : b?.unhealthy ? 'baseline' : null;
  const fromBaseline = (lines: string[]) => lines.map((l) => `${BASELINE_HEALTH_PREFIX}${l}`);
  return {
    ...(candidate ? { candidate } : {}),
    ...(baseline ? { baseline } : {}),
    unhealthy,
    reasons: [...(c?.reasons ?? []), ...fromBaseline(b?.reasons ?? [])],
    warnings: [...(c?.warnings ?? []), ...fromBaseline(b?.warnings ?? [])],
  };
}

/** The fields of a snapshot result the health rules read. */
export interface HealthSnapshotInput {
  captureHealth?: Pick<SnapshotCaptureHealth, 'unhealthy'> | null;
}

/** Whether either side of the snapshot was captured unhealthy. */
export function isUnhealthyCapture(snapshot: HealthSnapshotInput): boolean {
  return Boolean(snapshot.captureHealth?.unhealthy);
}

/** What to do about an unhealthy current capture. */
export const UNHEALTHY_CAPTURE_NEXT =
  'an unhealthy capture is a glitch of the capture or a broken asset, not render noise: fix the page, the server or the test and re-run; never approve it as a baseline';

/** What to do about an unhealthy baseline. */
export const UNHEALTHY_BASELINE_NEXT = 're-baseline from a healthy run';

export interface CaptureHealthReading {
  side: 'candidate' | 'baseline' | 'both';
  /** The reasons, in plain words: the current capture's, then the baseline called out. */
  detail: string;
  /** What to do next. */
  next: string;
}

const joinAnd = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** One side's assessment: from its recorded block, else from the reasons (results written by another tool). */
function sideAssessment(health: SnapshotCaptureHealth, side: 'candidate' | 'baseline'): Pick<HealthAssessment, 'problems' | 'reasons'> {
  const block = side === 'candidate' ? health.candidate : health.baseline;
  if (block) return assessHealth(block);
  const isBaseline = (r: string) => r.startsWith(BASELINE_HEALTH_PREFIX);
  const reasons =
    side === 'baseline'
      ? health.reasons.filter(isBaseline).map((r) => r.slice(BASELINE_HEALTH_PREFIX.length))
      : health.reasons.filter((r) => !isBaseline(r));
  return { problems: [], reasons };
}

/**
 * The "Unhealthy capture" reading every surface shows, or null when neither
 * side is unhealthy. An unhealthy current capture names what failed and says
 * it is a glitch or a broken asset to fix, never to approve; an unhealthy
 * baseline is called out on every compare against it, with "re-baseline from
 * a healthy run".
 */
export function captureHealthReading(health: SnapshotCaptureHealth | null | undefined): CaptureHealthReading | null {
  if (!health?.unhealthy) return null;
  const side = health.unhealthy;
  const parts: string[] = [];
  if (side !== 'baseline') parts.push(sideAssessment(health, 'candidate').reasons.join('; '));
  if (side !== 'candidate') {
    const b = sideAssessment(health, 'baseline');
    const what = b.problems.length > 0 ? `with ${joinAnd(b.problems)}` : 'unhealthy';
    parts.push(`the baseline was captured ${what}${side === 'both' ? ' too' : ''} (${b.reasons.join('; ')})`);
  }
  const next =
    side === 'candidate' ? UNHEALTHY_CAPTURE_NEXT : side === 'baseline' ? UNHEALTHY_BASELINE_NEXT : `${UNHEALTHY_CAPTURE_NEXT}, and ${UNHEALTHY_BASELINE_NEXT}`;
  return { side, detail: parts.filter(Boolean).join('; '), next };
}

/**
 * The warning for approving a capture that is unhealthy (`testivai approve`,
 * the approve action's reply), or null for a healthy capture or one that
 * recorded no health. Approving still happens: the human decides.
 */
export function approveHealthWarning(health: CaptureHealth | null | undefined): string | null {
  if (!health) return null;
  const assessment = assessHealth(health);
  if (!assessment.unhealthy) return null;
  return (
    `approving an unhealthy capture as the baseline — ${assessment.reasons.join('; ')}. ` +
    'Every compare against it will say so: fix the page, the server or the test, re-run and approve a healthy capture'
  );
}
