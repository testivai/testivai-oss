/**
 * Validation for `.testivai/config.json`.
 *
 * The config file is plain JSON with no schema enforcement, so a typo'd key
 * (`maxDiffPercnet`) or a mistyped value (`"threshold": "0.1"`) was silently
 * ignored — the user concludes the tolerance dial is broken. This module
 * turns those mistakes into warnings with a did-you-mean suggestion.
 *
 * Warnings never throw and never block a run: an unknown key might come from
 * a NEWER TestivAI version's config being read by an older CLI, and a visual
 * test run should degrade, not die, on a config nit.
 */

/** Expected JSON type for every known LocalConfig field. */
const KNOWN_FIELDS: Record<string, 'number' | 'boolean' | 'string' | 'array' | 'object'> = {
  threshold: 'number',
  autoOpen: 'boolean',
  failOnDiff: 'boolean',
  failOnMissing: 'boolean',
  shiftTolerance: 'number',
  volatileAttributes: 'array',
  shareUploadCommand: 'string',
  baselinesDir: 'string',
  reportDir: 'string',
  ignoreSelectors: 'array',
  mask: 'array',
  diffRegions: 'object',
  maxDiffPercent: 'number',
  maxDiffPixels: 'number',
  noiseAutoPass: 'boolean',
  noiseMaxDiffPercent: 'number',
  stabilize: 'boolean',
  pages: 'array',
  maxPages: 'number',
  viewport: 'object',
  mcpApprovalPrompt: 'boolean',
};

/**
 * Keys earlier versions understood. They get a targeted retirement notice
 * instead of an unknown-key warning, and are never "did you mean"-matched.
 */
const RETIRED_FIELDS: Record<string, string> = {
  mode: 'the `mode` field is retired and ignored — TestivAI always runs locally. Remove it from .testivai/config.json.',
};

/** Result of validating a parsed config object. */
export interface ConfigValidation {
  /** Human-readable warnings, one per problem. Empty when the config is clean. */
  warnings: string[];
  /**
   * Keys whose values had the wrong JSON type. Callers should drop these so
   * the documented defaults apply instead of propagating a string into
   * arithmetic.
   */
  invalidKeys: string[];
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** Classic Levenshtein distance — inputs are short config keys, so O(n*m) is fine. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Find the closest known key, case-insensitively, within an edit-distance
 * budget that scales with key length (1 for short keys, 2 for longer ones).
 */
function closestKnownKey(key: string): string | null {
  const budget = key.length <= 5 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = budget + 1;
  for (const candidate of Object.keys(KNOWN_FIELDS)) {
    const distance = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= budget ? best : null;
}

/**
 * Validate a parsed `.testivai/config.json` object.
 *
 * Pure — no I/O, no logging — so it is trivially unit-testable. The caller
 * decides how to surface `warnings` and what to do with `invalidKeys`.
 */
export function validateLocalConfig(parsed: unknown): ConfigValidation {
  const warnings: string[] = [];
  const invalidKeys: string[] = [];

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`.testivai/config.json should be a JSON object, got ${jsonType(parsed)} — using defaults.`);
    return { warnings, invalidKeys };
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const retirement = RETIRED_FIELDS[key];
    if (retirement) {
      warnings.push(retirement);
      continue;
    }

    const expected = KNOWN_FIELDS[key];
    if (!expected) {
      const suggestion = closestKnownKey(key);
      warnings.push(
        suggestion
          ? `unknown config key "${key}" — did you mean "${suggestion}"? It is being ignored.`
          : `unknown config key "${key}" — it is being ignored. Known keys: ${Object.keys(KNOWN_FIELDS).join(', ')}.`,
      );
      continue;
    }

    const actual = jsonType(value);
    if (actual !== expected) {
      warnings.push(
        `config key "${key}" should be a ${expected}, got ${actual} (${JSON.stringify(value)}) — using the default instead.`,
      );
      invalidKeys.push(key);
    }
  }

  return { warnings, invalidKeys };
}
