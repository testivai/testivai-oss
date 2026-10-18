/**
 * Link targets for snapshots in the HTML report.
 *
 * Its own module (no template code) so the GitHub Action can bundle it for
 * the PR comment's per-snapshot links without the whole report template.
 */

/** A name that is already a readable, safe id (and short enough to keep). */
const PLAIN_SNAPSHOT_NAME = /^[A-Za-z0-9_-]{1,60}$/;

/**
 * The id of a snapshot's card in the report, for links straight to it
 * (`index.html#snap-home`). Exported so the PR comment builds the same id.
 *
 * A plain name (letters, digits, `_`, `-`) is kept as is. Any other name is
 * reduced to those characters and suffixed with a hash of the full name, so
 * names that differ only in other characters (`home page`, `home/page`)
 * still get different ids. Always matches `snap-[A-Za-z0-9_-]+`, at most 74
 * characters.
 */
export function snapshotAnchorId(name: string): string {
  if (PLAIN_SNAPSHOT_NAME.test(name)) return `snap-${name}`;
  const readable = trimDashes(name.replace(/[^A-Za-z0-9_-]+/g, '-')).slice(0, 60);
  return `snap-${readable ? `${readable}-` : ''}${fnv1a(name)}`;
}

/**
 * Drop leading and trailing dashes. A loop, not /^-+|-+$/: that regex is
 * quadratic on a run of dashes between two other characters, and a snapshot
 * name can come from a results.json someone else wrote.
 */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

/** 32-bit FNV-1a of a string's UTF-16 code units, as 8 hex digits. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
