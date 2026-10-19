/**
 * Capture health — what failed to load when the page was captured.
 *
 * A web font that failed and fell back to a system font, or a stylesheet that
 * answered 404, can leave the DOM identical and the computed styles matching:
 * the style digest hashes the DECLARED font-family (STYLE_PROPS in
 * capture/element-map.ts), not the font that rendered. The pixel diff is then
 * a few glyphs spread over the page, the shape render noise takes, and used
 * to read "likely render noise" and pass under noiseAutoPass. Recording what
 * failed to load, per capture, lets the compare call it what it is: an
 * unhealthy capture (report/health.ts words it).
 *
 * The probe is evaluated in the page AFTER the capture, so it sees what
 * loaded. Adapters record its result as `health` in the capture's
 * metadata.json (approving freezes it into the baseline's). An adapter that
 * does not run the probe writes no `health`: that reads as "not checked",
 * never as healthy or unhealthy.
 *
 * No Node dependencies: the GitHub Action bundles the validator.
 */

/** The request groups, by what was requested. */
export const RESOURCE_TYPES = ['css', 'font', 'img', 'script', 'other'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Requests of one type that failed: how many, and the first few. */
export interface ResourceFailures {
  count: number;
  /** Host and path (never the query string), and the HTTP status: 0 when the request failed without one (`error` says why). */
  entries: Array<{ url: string; status: number; error?: string }>;
}

export interface CaptureHealth {
  fonts: {
    /** document.fonts.status after the capture; 'unavailable' without the Font Loading API. */
    status: 'loaded' | 'loading' | 'unavailable';
    /** Every FontFace whose status is 'error' (the first HEALTH_LIMITS.list). */
    failed: Array<{ family: string; weight: string; style: string }>;
  };
  /**
   * `<link rel=stylesheet>` elements that failed: no sheet (failed or blocked),
   * or a request that answered 400 or more (Chromium gives a failed
   * stylesheet an empty sheet, so a null sheet alone misses a 404).
   */
  stylesheets: { failed: number; urls: string[] };
  /** `<img>` elements that finished without an image (complete, naturalWidth 0). */
  images: { broken: number; urls: string[] };
  /**
   * Requests that answered 400 or more (Resource Timing responseStatus,
   * Chromium 109+), by type; 'unavailable' when the browser does not report
   * statuses. An adapter that watches the network adds what it saw
   * (mergeResourceFailures), cross-origin requests included.
   */
  resources: { status: 'checked' | 'unavailable'; failed: Partial<Record<ResourceType, ResourceFailures>> };
}

export const HEALTH_LIMITS = {
  /** Entries kept per list. */
  list: 10,
  /** Characters kept of a URL (host and path). */
  url: 200,
  /** Longest family, weight, style or error text accepted. */
  text: 200,
} as const;

/**
 * One self-contained in-page expression (no imports, no closures, ES5) that
 * reports what failed to load. Each part is read on its own, so one missing
 * API never loses the rest; a part whose API is missing says 'unavailable'
 * where it can, never "loaded". URLs are recorded as host and path only: a
 * query string can carry tokens.
 */
export const HEALTH_PROBE_EXPRESSION = `(function () {
  var LIMIT = ${HEALTH_LIMITS.list};
  var MAX = ${HEALTH_LIMITS.url};
  var out = {};
  var base;
  try { base = document.baseURI || undefined; } catch (e) {}
  function where(href) {
    try {
      var u = new URL(String(href), base);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return (u.host + u.pathname).slice(0, MAX);
      return u.protocol;
    } catch (e) { return ''; }
  }
  function kindOf(url, initiator) {
    var m = /\\.([a-z0-9]+)$/i.exec(url);
    var ext = m ? m[1].toLowerCase() : '';
    if (/^(woff2?|ttf|otf|eot)$/.test(ext)) return 'font';
    if (ext === 'css') return 'css';
    if (/^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(ext)) return 'img';
    if (/^m?js$/.test(ext)) return 'script';
    if (ext) return 'other';
    if (initiator === 'link') return 'css';
    if (initiator === 'img' || initiator === 'image' || initiator === 'input') return 'img';
    if (initiator === 'script') return 'script';
    return 'other';
  }
  try {
    var set = document.fonts;
    if (set && typeof set.status === 'string' && typeof set.forEach === 'function') {
      var faces = [];
      set.forEach(function (face) {
        if (face && face.status === 'error' && faces.length < LIMIT) {
          faces.push({
            family: String(face.family).replace(/^\\s*["']|["']\\s*$/g, '').slice(0, MAX),
            weight: String(face.weight).slice(0, MAX),
            style: String(face.style).slice(0, MAX)
          });
        }
      });
      out.fonts = { status: set.status === 'loaded' ? 'loaded' : 'loading', failed: faces };
    } else {
      out.fonts = { status: 'unavailable', failed: [] };
    }
  } catch (e) { out.fonts = { status: 'unavailable', failed: [] }; }
  var statusByUrl = {};
  try {
    var timed = typeof performance !== 'undefined' && performance && typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
    for (var t = 0; t < timed.length; t++) {
      if (typeof timed[t].responseStatus === 'number') statusByUrl[timed[t].name] = timed[t].responseStatus;
    }
  } catch (e) {}
  try {
    var links = document.querySelectorAll('link[rel]');
    var sheetsFailed = 0, sheetUrls = [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var rel = ' ' + String(link.getAttribute('rel') || '').toLowerCase().replace(/\\s+/g, ' ') + ' ';
      if (rel.indexOf(' stylesheet ') === -1 || rel.indexOf(' alternate ') !== -1) continue;
      if (link.disabled || !link.getAttribute('href')) continue;
      if (!link.sheet || statusByUrl[link.href] >= 400) {
        sheetsFailed++;
        if (sheetUrls.length < LIMIT) sheetUrls.push(where(link.href));
      }
    }
    out.stylesheets = { failed: sheetsFailed, urls: sheetUrls };
  } catch (e) {}
  try {
    var imgs = document.images, broken = 0, imageUrls = [];
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      var src = img.currentSrc || img.src || '';
      if (!src) continue;
      if (img.complete && img.naturalWidth === 0) {
        broken++;
        if (imageUrls.length < LIMIT) imageUrls.push(where(src));
      }
    }
    out.images = { broken: broken, urls: imageUrls };
  } catch (e) {}
  try {
    var timing = typeof PerformanceResourceTiming !== 'undefined' ? PerformanceResourceTiming : null;
    var perf = typeof performance !== 'undefined' ? performance : null;
    if (!timing || !timing.prototype || !('responseStatus' in timing.prototype) || !perf || typeof perf.getEntriesByType !== 'function') {
      out.resources = { status: 'unavailable', failed: {} };
    } else {
      var failed = {}, seen = {};
      var entries = perf.getEntriesByType('resource');
      for (var k = 0; k < entries.length; k++) {
        var entry = entries[k];
        var status = entry.responseStatus;
        if (typeof status !== 'number' || status < 400) continue;
        var url = where(entry.name);
        if (entry.initiatorType === 'other' && url.indexOf('/') === url.length - 12 && url.slice(-12) === '/favicon.ico') continue;
        var type = kindOf(url, entry.initiatorType);
        if (seen[type + ' ' + url]) continue;
        seen[type + ' ' + url] = true;
        var group = failed[type] || (failed[type] = { count: 0, entries: [] });
        group.count++;
        if (group.entries.length < LIMIT) group.entries.push({ url: url, status: status });
      }
      out.resources = { status: 'checked', failed: failed };
    }
  } catch (e) { out.resources = { status: 'unavailable', failed: {} }; }
  return out;
})()`;

/**
 * The favicon the browser asks the site root for by itself when the page
 * names none: not an asset of the page, so its 404 is not recorded.
 */
export function isBrowserFaviconRequest(url: string): boolean {
  try {
    return new URL(url).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

/**
 * A URL as health records it: host and path, no scheme, query or fragment (a
 * query string can carry tokens). A data: or blob: URL is named by its scheme
 * only; anything that is not a URL is ''. Same rule as the probe's.
 */
export function hostPath(href: string): string {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return (u.host + u.pathname).slice(0, HEALTH_LIMITS.url);
    return u.protocol;
  } catch {
    return '';
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

class Malformed extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function record(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Malformed();
  return v;
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Malformed();
  return v;
}

function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new Malformed();
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new Malformed();
  return v as T;
}

/** A list, capped at HEALTH_LIMITS.list (longer lists are cut, not rejected). */
function list<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Malformed();
  return v.slice(0, HEALTH_LIMITS.list).map(item);
}

function readFailures(v: unknown): ResourceFailures {
  const g = record(v);
  return {
    count: count(g.count),
    entries: list(g.entries, (e) => {
      const entry = record(e);
      const out: ResourceFailures['entries'][number] = { url: text(entry.url, HEALTH_LIMITS.url), status: count(entry.status) };
      if (entry.error !== undefined) out.error = text(entry.error, HEALTH_LIMITS.text);
      return out;
    }),
  };
}

function readHealthBlock(raw: unknown): CaptureHealth {
  const h = record(raw);
  const fonts = record(h.fonts);
  const stylesheets = record(h.stylesheets);
  const images = record(h.images);
  const resources = record(h.resources);
  const failed: CaptureHealth['resources']['failed'] = {};
  for (const [type, group] of Object.entries(record(resources.failed))) {
    failed[oneOf(type, RESOURCE_TYPES)] = readFailures(group);
  }
  return {
    fonts: {
      status: oneOf(fonts.status, ['loaded', 'loading', 'unavailable'] as const),
      failed: list(fonts.failed, (f) => {
        const face = record(f);
        return { family: text(face.family, HEALTH_LIMITS.text), weight: text(face.weight, HEALTH_LIMITS.text), style: text(face.style, HEALTH_LIMITS.text) };
      }),
    },
    stylesheets: { failed: count(stylesheets.failed), urls: list(stylesheets.urls, (u) => text(u, HEALTH_LIMITS.url)) },
    images: { broken: count(images.broken), urls: list(images.urls, (u) => text(u, HEALTH_LIMITS.url)) },
    resources: { status: oneOf(resources.status, ['checked', 'unavailable'] as const), failed },
  };
}

/**
 * Validate a health block: the probe's result, or `health` read back from a
 * metadata.json or a results.json. Returns a normalized copy (unknown fields
 * dropped, lists capped), or null for anything malformed: a block that cannot
 * be trusted is "not checked", never healthy. Never throws.
 */
export function parseHealth(raw: unknown): CaptureHealth | null {
  try {
    return readHealthBlock(raw);
  } catch {
    return null;
  }
}

// ── Network-side evidence ───────────────────────────────────────────────────

/** One failed request seen on the network: the full URL (recorded as host and path), its type and status (0 with `error` when there was no response). */
export interface ResourceFailure {
  url: string;
  type: ResourceType;
  status: number;
  error?: string;
}

/** A CDP Network resource type ("Stylesheet", "Font"…) as a probe group. */
export function resourceTypeFromCdp(type: string | undefined): ResourceType {
  switch (type) {
    case 'Stylesheet':
      return 'css';
    case 'Font':
      return 'font';
    case 'Image':
      return 'img';
    case 'Script':
      return 'script';
    default:
      return 'other';
  }
}

/**
 * Add what an adapter saw on the network (failed requests, cross-origin ones
 * included, which Resource Timing reports without a status) to a probe's
 * result, in the same shape. A request already recorded is not counted again;
 * a status replaces a failure recorded without one. Watching the network means
 * the requests were checked, so `resources.status` becomes 'checked'. Returns
 * a new block.
 */
export function mergeResourceFailures(health: CaptureHealth, failures: ResourceFailure[]): CaptureHealth {
  const failed: CaptureHealth['resources']['failed'] = {};
  for (const [type, group] of Object.entries(health.resources.failed) as Array<[ResourceType, ResourceFailures]>) {
    failed[type] = { count: group.count, entries: group.entries.map((e) => ({ ...e })) };
  }
  for (const failure of failures) {
    const url = hostPath(failure.url);
    if (!url) continue;
    const group = failed[failure.type] ?? { count: 0, entries: [] };
    failed[failure.type] = group;
    const entry: ResourceFailures['entries'][number] = { url, status: failure.status };
    if (failure.status === 0 && failure.error) entry.error = failure.error.slice(0, HEALTH_LIMITS.text);
    const known = group.entries.findIndex((e) => e.url === url);
    if (known !== -1) {
      if (group.entries[known].status === 0 && failure.status > 0) group.entries[known] = entry;
      continue;
    }
    group.count++;
    if (group.entries.length < HEALTH_LIMITS.list) group.entries.push(entry);
  }
  return { ...health, resources: { status: 'checked', failed } };
}
