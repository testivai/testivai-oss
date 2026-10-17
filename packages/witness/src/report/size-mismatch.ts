/**
 * TestivAI Report — a capture whose dimensions differ from its baseline
 *
 * compareAll pads the two captures to max width × max height and counts
 * every padded pixel as changed, then records the two sizes on the result
 * as `sizeMismatch`. These helpers are the one wording for it, shared by the
 * HTML report, @testivai/mcp and the GitHub Action:
 *
 * - a HEIGHT change is the page growing or shrinking: content was added or
 *   removed (the DOM signal says what), the common case for a full-page
 *   capture;
 * - a WIDTH change is almost always the viewport or the device scale factor
 *   differing between the two captures, not the page. It is said that way,
 *   and never described as content.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** The two sizes of a compared pair, as results.json records them. */
export interface SizeMismatchInfo {
  baseline: Dimensions;
  candidate: Dimensions;
}

/**
 * Which axis changed: 'width' whenever the widths differ (with or without
 * the height), 'height' when only the heights differ, null for equal sizes.
 */
export function sizeMismatchKind(sm: SizeMismatchInfo): 'width' | 'height' | null {
  if (sm.baseline.width !== sm.candidate.width) return 'width';
  if (sm.baseline.height !== sm.candidate.height) return 'height';
  return null;
}

const signed = (px: number): string => `${px > 0 ? '+' : '-'}${Math.abs(px)} px`;

/** The two sizes side by side: "baseline 1280×2348 → current 1280×2538". */
export function formatSizes(sm: SizeMismatchInfo): string {
  const { baseline: b, candidate: c } = sm;
  return `baseline ${b.width}×${b.height} → current ${c.width}×${c.height}`;
}

/**
 * The two sizes with the pixel delta, for a snapshot row:
 * "baseline 1280×2348 → current 1280×2538 (+190 px)". A width change names
 * its axis ("+160 px wide"); both axes are listed when both changed.
 */
export function formatSizeMismatch(sm: SizeMismatchInfo): string {
  const { baseline: b, candidate: c } = sm;
  const dw = c.width - b.width;
  const dh = c.height - b.height;
  if (dw === 0 && dh === 0) return formatSizes(sm);
  const delta = dw !== 0 && dh !== 0 ? `${signed(dw)} wide, ${signed(dh)} tall` : dw !== 0 ? `${signed(dw)} wide` : signed(dh);
  return `${formatSizes(sm)} (${delta})`;
}

/**
 * What the size change means, in one clause: "page grew 190 px" / "page
 * shrank 190 px" for a height change; "width changed 1280 → 1440: viewport
 * or device scale differs" for a width change (with the height change in
 * parentheses when both changed). Pair it with formatSizes for the numbers.
 */
export function describeSizeChange(sm: SizeMismatchInfo): string {
  const { baseline: b, candidate: c } = sm;
  const kind = sizeMismatchKind(sm);
  if (kind === 'width') {
    const height = b.height !== c.height ? ` (and height ${b.height} → ${c.height})` : '';
    return `width changed ${b.width} → ${c.width}${height}: viewport or device scale differs`;
  }
  if (kind === 'height') {
    const dh = c.height - b.height;
    return `page ${dh > 0 ? 'grew' : 'shrank'} ${Math.abs(dh)} px`;
  }
  return 'dimensions unchanged';
}
