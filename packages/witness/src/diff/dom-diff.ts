/**
 * TestivAI DOM Diff — lightweight noise-hint comparison
 *
 * Compares two HTML strings (typically `document.documentElement.outerHTML`
 * captured at snapshot time) and returns a small structural-change summary.
 *
 * This is intentionally NOT a full DOM tree differ — those bring 30 KB+ of
 * dependencies and complex semantics we don't need. The job here is to
 * answer one question per snapshot:
 *
 *   "When pixels differ, is the underlying DOM also different?"
 *
 * If pixels differ but the DOM is unchanged, the cause is either render
 * noise (font rendering, anti-aliasing, sub-pixel layout) or a
 * stylesheet-only change, which this differ cannot see (style bodies are
 * opaque). The report pairs it with the computed-style check: only an
 * unchanged DOM with styleCheck 'match' reads as likely render noise; with
 * 'unavailable' a stylesheet-only change is not ruled out.
 *
 * Approach (zero-dep, ~120 LOC of tokenizer):
 *   1. Stream-tokenize each HTML into a flat list of open events
 *      (`{ tag, attrs: Record<string, string> }`).
 *   2. Compare via multiset operations:
 *        - tags only in candidate → added
 *        - tags only in baseline  → removed
 *        - same tag pairs that differ in attributes → attributeChanges
 *
 * Tradeoffs:
 *   - We treat element ORDER as soft. Two pages with the same elements in
 *     a different order register as zero diff in tag counts but may show up
 *     as attribute changes if reordering changes attributes (uncommon).
 *     This is acceptable because the SAME page captured twice should
 *     normally produce identical token lists.
 *   - Visible text nodes ARE tokenized (normalized whitespace) — a text
 *     edit is the most common real UI change and must never read as
 *     "structurally identical". Script/style bodies stay opaque, so a
 *     stylesheet-only change is invisible here (the computed-style check
 *     covers that). Dynamic text such as a timestamp DOES count as a text
 *     change; exclude it with ignoreSelectors (the adapters strip those
 *     elements from dom.html). A pixel mask does not hide it from this diff.
 *   - Comments and processing instructions are ignored.
 *
 * Self-closing void elements per HTML spec are handled.
 */

const _VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Result of a DOM diff comparison. */
export interface DomDiffResult {
  /** True if the two HTML strings are structurally different. */
  domChanged: boolean;
  /** Per-bucket counts; null when domChanged is false. */
  summary: DomDiffSummary | null;
}

export interface DomDiffSummary {
  /** Tag occurrences present in candidate but not baseline. */
  added: number;
  /** Tag occurrences present in baseline but not candidate. */
  removed: number;
  /** Tag pairs present in both but with different attributes. */
  attributeChanges: number;
  /**
   * Visible text tokens that differ (edited, added, or removed). Text
   * matters: with noiseAutoPass a text-blind DOM diff would silently
   * auto-pass wording changes — the most common real UI change.
   */
  textChanges: number;
}

interface OpenEvent {
  tag: string;
  /** Attributes serialized as `key=value` pairs, sorted, joined by '\0'. */
  attrSig: string;
}

/**
 * Compare two HTML strings.
 *
 * Returns `{ domChanged: false, summary: null }` for fast paths:
 *   - Both inputs identical bytes
 *   - Both inputs missing/empty (e.g., DOM capture wasn't enabled)
 *
 * Otherwise tokenizes both and produces a summary.
 */
export interface DomDiffOptions {
  /**
   * Attribute names whose VALUES are ignored in the comparison (the
   * attribute's presence still counts). For pages where `src`/`srcset`
   * carry per-run URLs (CDN hashes, signed URLs) that would otherwise
   * poison the noise hint with `attributeChanges: 1`.
   *
   * Note: `blob:` URLs are always normalized regardless of this list —
   * object URLs are per-session by construction and can never match.
   */
  volatileAttributes?: string[];
}

export function domDiff(
  baselineHtml: string | null | undefined,
  candidateHtml: string | null | undefined,
  options: DomDiffOptions = {},
): DomDiffResult {
  // Fast path: missing data on either side → no signal
  if (!baselineHtml || !candidateHtml) {
    return { domChanged: false, summary: null };
  }

  // Fast path: byte-identical
  if (baselineHtml === candidateHtml) {
    return { domChanged: false, summary: null };
  }

  const volatile = new Set((options.volatileAttributes ?? []).map((a) => a.toLowerCase()));
  const baselineTok = tokenize(baselineHtml, volatile);
  const candidateTok = tokenize(candidateHtml, volatile);

  // Bucket by tag name; within each bucket, count attrSig multisets
  const baselineBuckets = bucketize(baselineTok.events);
  const candidateBuckets = bucketize(candidateTok.events);

  // Text multiset comparison: matched pairs drop out; every unmatched
  // token on either side counts once (an edit surfaces as old+new pair,
  // reported as 1 change).
  let textUnmatched = 0;
  const textKeys = new Set<string>([...baselineTok.texts.keys(), ...candidateTok.texts.keys()]);
  for (const key of textKeys) {
    textUnmatched += Math.abs((baselineTok.texts.get(key) ?? 0) - (candidateTok.texts.get(key) ?? 0));
  }
  const textChanges = Math.ceil(textUnmatched / 2);

  let added = 0;
  let removed = 0;
  let attributeChanges = 0;

  const allTags = new Set<string>([...baselineBuckets.keys(), ...candidateBuckets.keys()]);

  for (const tag of allTags) {
    const baselineForTag = baselineBuckets.get(tag) ?? new Map<string, number>();
    const candidateForTag = candidateBuckets.get(tag) ?? new Map<string, number>();

    const baselineCount = sumValues(baselineForTag);
    const candidateCount = sumValues(candidateForTag);

    if (candidateCount > baselineCount) {
      added += candidateCount - baselineCount;
    } else if (baselineCount > candidateCount) {
      removed += baselineCount - candidateCount;
    }

    // Attribute changes = matching tag pairs whose attrSig differs.
    // We compute by intersecting the two attrSig multisets and counting
    // anything that doesn't match. Each unmatched-but-paired pair counts
    // once toward attributeChanges; raw added/removed of the tag itself
    // is already counted above, so we subtract that delta.
    const overlap = Math.min(baselineCount, candidateCount);
    let matchingPairs = 0;
    for (const [sig, candCount] of candidateForTag) {
      const baseCount = baselineForTag.get(sig) ?? 0;
      matchingPairs += Math.min(baseCount, candCount);
    }
    attributeChanges += overlap - matchingPairs;
  }

  const domChanged = added > 0 || removed > 0 || attributeChanges > 0 || textChanges > 0;

  return {
    domChanged,
    summary: domChanged ? { added, removed, attributeChanges, textChanges } : null,
  };
}

// ── internals ──────────────────────────────────────────────────────────────

function bucketize(events: OpenEvent[]): Map<string, Map<string, number>> {
  const buckets = new Map<string, Map<string, number>>();
  for (const ev of events) {
    let inner = buckets.get(ev.tag);
    if (!inner) {
      inner = new Map<string, number>();
      buckets.set(ev.tag, inner);
    }
    inner.set(ev.attrSig, (inner.get(ev.attrSig) ?? 0) + 1);
  }
  return buckets;
}

function sumValues(m: Map<string, number>): number {
  let total = 0;
  for (const v of m.values()) total += v;
  return total;
}

/**
 * Stream-tokenize HTML into open events.
 *
 * Skips: doctype, comments, processing instructions, CDATA, text nodes,
 * script/style content (handled as opaque). Close tags are dropped.
 *
 * Robust against malformed HTML — we never throw; on weird input we
 * just stop emitting events. Worst case = false "no DOM signal".
 */
function tokenize(html: string, volatile: Set<string> = new Set()): { events: OpenEvent[]; texts: Map<string, number> } {
  const events: OpenEvent[] = [];
  const texts = new Map<string, number>();
  const len = html.length;
  let i = 0;

  const collectText = (from: number, to: number): void => {
    if (to <= from) return;
    const normalized = html.slice(from, to).replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    texts.set(normalized, (texts.get(normalized) ?? 0) + 1);
  };

  while (i < len) {
    // Find next '<'
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      collectText(i, len);
      break;
    }
    collectText(i, lt);
    i = lt + 1;
    if (i >= len) break;

    const c = html[i];

    // Comment <!-- ... -->
    if (c === '!' && html.startsWith('!--', i)) {
      const end = html.indexOf('-->', i + 3);
      if (end < 0) break;
      i = end + 3;
      continue;
    }

    // Doctype <!doctype ...>
    if (c === '!') {
      const end = html.indexOf('>', i + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>  (rare in HTML; skip)
    // Already handled by the c === '!' branch above.

    // Processing instruction <? ... ?>
    if (c === '?') {
      const end = html.indexOf('?>', i + 1);
      if (end < 0) break;
      i = end + 2;
      continue;
    }

    // Close tag </tagname>
    if (c === '/') {
      const end = html.indexOf('>', i + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    // Open tag <tagname ...>
    const tagEnd = findTagEnd(html, i);
    if (tagEnd < 0) break;

    const raw = html.slice(i, tagEnd);
    const ev = parseOpenTag(raw, volatile);
    if (ev) {
      events.push(ev);
      // For script/style, skip body opaquely until matching close
      if (ev.tag === 'script' || ev.tag === 'style') {
        const closeNeedle = `</${ev.tag}`;
        const closeIdx = indexOfCaseInsensitive(html, closeNeedle, tagEnd + 1);
        if (closeIdx < 0) break;
        const gtAfter = html.indexOf('>', closeIdx);
        i = gtAfter < 0 ? len : gtAfter + 1;
        continue;
      }
    }

    i = tagEnd + 1;
  }

  return { events, texts };
}

/**
 * Find the index of '>' that closes the open tag starting at `start`,
 * handling quoted attribute values which may contain '>'.
 */
function findTagEnd(html: string, start: number): number {
  let i = start;
  let inQuote: '"' | "'" | null = null;
  const len = html.length;
  while (i < len) {
    const c = html[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === '>') return i;
    }
    i++;
  }
  return -1;
}

/**
 * Parse the raw inside of a `<...>` (excluding the angle brackets) into
 * an OpenEvent. Returns null for the empty / malformed case.
 */
function parseOpenTag(raw: string, volatile: Set<string> = new Set()): OpenEvent | null {
  // Strip trailing '/' for self-closing forms <br/>
  const trimmed = raw.trim().replace(/\/$/, '').trim();
  if (!trimmed) return null;

  // First whitespace-or-end → tag name
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  let rest = trimmed.slice(m[0].length).trim();

  const attrs: Record<string, string> = {};
  while (rest.length > 0) {
    const am = /^([a-zA-Z_:][a-zA-Z0-9_:.-]*)/.exec(rest);
    if (!am) break;
    const name = am[1].toLowerCase();
    rest = rest.slice(am[0].length);

    let value = '';
    if (rest.startsWith('=')) {
      rest = rest.slice(1).trimStart();
      if (rest.startsWith('"') || rest.startsWith("'")) {
        const quote = rest[0];
        const end = rest.indexOf(quote, 1);
        if (end < 0) break;
        value = rest.slice(1, end);
        rest = rest.slice(end + 1);
      } else {
        const ws = rest.search(/\s/);
        if (ws < 0) {
          value = rest;
          rest = '';
        } else {
          value = rest.slice(0, ws);
          rest = rest.slice(ws);
        }
      }
    }
    attrs[name] = value;
    rest = rest.trimStart();
  }

  // Build a stable, sorted attribute signature.
  // Two volatility escapes keep per-run URL churn from poisoning the
  // noise hint:
  //   - `blob:` values are ALWAYS normalized (object URLs are per-session
  //     by construction — they can never match across runs). `data:` URIs
  //     stay significant: they encode content, so a change is a change.
  //   - names in the configured volatileAttributes list keep their
  //     presence but drop their value.
  const keys = Object.keys(attrs).sort();
  const attrSig = keys
    .map((k) => {
      if (volatile.has(k)) return `${k}=*`;
      const v = attrs[k];
      return v.startsWith('blob:') ? `${k}=blob:*` : `${k}=${v}`;
    })
    .join('\0');

  return { tag, attrSig };
}

function indexOfCaseInsensitive(haystack: string, needle: string, fromIndex: number): number {
  // Cheap case-insensitive search; needle is short ('</script' or '</style')
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  return h.indexOf(n, fromIndex);
}

/**
 * Internal export only used in tests; exposes the tokenizer for white-box
 * verification. Not part of the package public API.
 */
export const __internals__ = { tokenize };
