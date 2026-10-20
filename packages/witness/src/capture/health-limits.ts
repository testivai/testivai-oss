/**
 * The caps on what a capture's health record keeps. On their own so the
 * report side (report/health.ts, bundled by the GitHub Action) can read them
 * without pulling in the in-page probe.
 */
export const HEALTH_LIMITS = {
  /** Entries kept per list. */
  list: 10,
  /** Characters kept of a URL (host and path). */
  url: 200,
  /** Longest family, weight, style or error text accepted. */
  text: 200,
} as const;
