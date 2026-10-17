/**
 * Capture provenance — where a capture came from.
 *
 * When the same URL renders differently, the question a reviewer needs
 * answered first is whether the PAGE changed or the MACHINE did: a new
 * browser build, another OS or distro (another set of fonts), another device
 * scale, another way of taking the screenshot. Every adapter records the
 * same `environment` block in the capture's metadata.json; approving a
 * capture freezes it into the baseline's metadata.json, and the compare
 * reads the two side by side (report/environment.ts).
 *
 * The block is plain JSON, so non-JS adapters write the same shape
 * (docs/extension-api.md). Every part an adapter cannot observe is left out,
 * never guessed: an absent field reads as "not recorded", not as a change.
 */

import * as fs from 'fs';
import * as os from 'os';

/** What the page was rendered with, measured in the page (RENDER_PROBE_EXPRESSION). */
export interface RenderEnvironment {
  /** CSS viewport (window.innerWidth × innerHeight). */
  viewport?: { width: number; height: number };
  /** window.devicePixelRatio. */
  deviceScaleFactor?: number;
  colorScheme?: 'light' | 'dark';
  reducedMotion?: 'reduce' | 'no-preference';
  /** navigator.language. */
  locale?: string;
  /** Intl time zone. */
  timezone?: string;
}

export interface CaptureEnvironment {
  os: {
    /** process.platform: linux / darwin / win32. */
    platform: string;
    /** os.release(): the kernel on Linux, the OS version on macOS and Windows. */
    release: string;
    arch: string;
    /** Linux only: `<ID> <VERSION_ID>` from /etc/os-release, e.g. "ubuntu 24.04". */
    distro?: string;
  };
  browser: {
    /** chromium / firefox / webkit (the engine family). */
    name: string;
    /** Full build version; null when the adapter could not read it. */
    version: string | null;
    /** A branded build of the engine: chrome, msedge, chrome-beta… */
    channel?: string;
    headless?: boolean;
  };
  /** The test framework driving the browser, when there is one (language only when the adapter can tell). */
  framework?: { name: string; version: string | null; language?: string; runner?: string };
  adapter: {
    name: string;
    version: string;
    /** `<extent>:<mechanism>`, one of CAPTURE_METHODS. */
    captureMethod: string;
  };
  /** The WebDriver binary, when the adapter talks to one. */
  driver?: { name: string; version: string };
  render?: RenderEnvironment;
  ci?: { provider: string; runnerImage?: string };
  /** Running inside a container (/.dockerenv or /run/.containerenv). */
  container?: boolean;
  /** TESTIVAI_ENV_LABEL: a name the team gives this environment, e.g. its image tag. */
  label?: string;
  /** Playwright project (or another runner's variant) the capture ran under. */
  project?: string;
}

/** The machine-level part of the block: the same for every capture of a run. */
export type HostEnvironment = Pick<CaptureEnvironment, 'os' | 'ci' | 'container' | 'label'>;

/**
 * How the screenshot was taken, as `<extent>:<mechanism>`. The extent is what
 * the image covers (the full page or the viewport); the mechanism is what
 * took it. A change of method changes the image, and often its size.
 */
export const CAPTURE_METHODS = {
  /** CDP Page.captureScreenshot with captureBeyondViewport. */
  CDP_FULL_PAGE: 'full-page:cdp',
  /** Playwright page.screenshot({ fullPage: true }). */
  PLAYWRIGHT_FULL_PAGE: 'full-page:playwright',
  /** Viewport screenshots scrolled and stitched together. */
  STITCHED_FULL_PAGE: 'full-page:stitched',
  /** Firefox's own full-page screenshot (Selenium save_full_page_screenshot). */
  FIREFOX_FULL_PAGE: 'full-page:firefox',
  /** WebDriver takeScreenshot: the viewport only. */
  WEBDRIVER_VIEWPORT: 'viewport:webdriver',
} as const;

/** The `environmentPolicy` values in .testivai/config.json. */
export type EnvironmentPolicy = 'warn' | 'separate' | 'strict';
export const ENVIRONMENT_POLICIES: readonly EnvironmentPolicy[] = ['warn', 'separate', 'strict'];

// ── Host ────────────────────────────────────────────────────────────────────

/**
 * The distro from /etc/os-release, as `<ID> <VERSION_ID>` ("ubuntu 24.04",
 * "debian 12"; "arch" for a rolling release). That pair decides the fonts and
 * the FreeType build a Linux machine draws text with; the kernel does not.
 */
export function distroFromOsRelease(text: string): string | undefined {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (!fields.ID) return undefined;
  return fields.VERSION_ID ? `${fields.ID} ${fields.VERSION_ID}` : fields.ID;
}

/** The CI provider, and the runner image where the provider names one. */
export function detectCi(env: NodeJS.ProcessEnv): CaptureEnvironment['ci'] {
  if (env.GITHUB_ACTIONS === 'true') {
    const runnerImage = env.ImageOS && env.ImageVersion ? `${env.ImageOS}/${env.ImageVersion}` : undefined;
    return runnerImage ? { provider: 'github-actions', runnerImage } : { provider: 'github-actions' };
  }
  if (env.GITLAB_CI) return { provider: 'gitlab' };
  if (env.CIRCLECI) return { provider: 'circleci' };
  if (env.BUILDKITE) return { provider: 'buildkite' };
  if (env.JENKINS_URL) return { provider: 'jenkins' };
  if (env.TF_BUILD) return { provider: 'azure-pipelines' };
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return { provider: 'ci' };
  return undefined;
}

/** Where collectHostEnvironment reads from; every source is injectable for tests. */
export interface HostSources {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  release?: string;
  arch?: string;
  /** Returns a file's text, or null when it cannot be read. */
  readFile?: (filePath: string) => string | null;
  exists?: (filePath: string) => boolean;
}

const safely = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** The machine-level part of the block. Never throws. */
export function collectHostEnvironment(sources: HostSources = {}): HostEnvironment {
  const env = sources.env ?? process.env;
  const platform = sources.platform ?? process.platform;
  const readFile =
    sources.readFile ?? ((p: string) => safely(() => fs.readFileSync(p, 'utf-8'), null as string | null));
  const exists = sources.exists ?? ((p: string) => fs.existsSync(p));

  const host: HostEnvironment = {
    os: {
      platform,
      release: sources.release ?? safely(() => os.release(), ''),
      arch: sources.arch ?? process.arch,
    },
  };
  if (platform === 'linux') {
    const text = safely(() => readFile('/etc/os-release'), null);
    const distro = text ? distroFromOsRelease(text) : undefined;
    if (distro) host.os.distro = distro;
  }
  const ci = detectCi(env);
  if (ci) host.ci = ci;
  if (safely(() => exists('/.dockerenv') || exists('/run/.containerenv'), false)) host.container = true;
  const label = (env.TESTIVAI_ENV_LABEL ?? '').trim();
  if (label) host.label = label;
  return host;
}

// ── Browser ─────────────────────────────────────────────────────────────────

/**
 * The engine and its version from a user agent: the fallback for an adapter
 * whose driver does not say (a Playwright persistent context has no
 * browser() to ask). Edge is reported as chromium with channel msedge, the
 * way Playwright names it.
 */
export function browserFromUserAgent(ua: string): CaptureEnvironment['browser'] | null {
  if (!ua) return null;
  const edge = /\bEdg\/([\d.]+)/.exec(ua);
  const chrome = /\b(HeadlessChrome|Chrome|Chromium)\/([\d.]+)/.exec(ua);
  if (chrome) {
    const browser: CaptureEnvironment['browser'] = { name: 'chromium', version: chrome[2] };
    if (chrome[1] === 'HeadlessChrome') browser.headless = true;
    if (edge) browser.channel = 'msedge';
    return browser;
  }
  const firefox = /\bFirefox\/([\d.]+)/.exec(ua);
  if (firefox) return { name: 'firefox', version: firefox[1] };
  const safari = /\bVersion\/([\d.]+).*\bSafari\//.exec(ua);
  if (safari) return { name: 'webkit', version: safari[1] };
  return null;
}

/** WebDriver browserName values, normalized to the engine family and its branded channel. */
const WEBDRIVER_BROWSERS: Record<string, { name: string; channel?: string; driver?: string }> = {
  chrome: { name: 'chromium', channel: 'chrome', driver: 'chromedriver' },
  'chrome-headless-shell': { name: 'chromium', channel: 'chrome-headless-shell', driver: 'chromedriver' },
  chromium: { name: 'chromium', driver: 'chromedriver' },
  microsoftedge: { name: 'chromium', channel: 'msedge', driver: 'msedgedriver' },
  msedge: { name: 'chromium', channel: 'msedge', driver: 'msedgedriver' },
  firefox: { name: 'firefox', driver: 'geckodriver' },
  safari: { name: 'webkit', channel: 'safari' },
};

/** The first token of a driver version string ("141.0.7390.37 (hash-refs/…)" → "141.0.7390.37"). */
const firstToken = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().split(/\s+/)[0] : undefined);

/**
 * The browser (and the WebDriver binary) from W3C capabilities, as
 * WebdriverIO's `browser.capabilities` or selenium-webdriver's
 * `getCapabilities()` returns them (a plain object, or an object with
 * `get()`). Headless is read from the browser's own launch arguments, and
 * only said when they are there to say it. Null without a browser name.
 */
export function browserFromCapabilities(
  caps: unknown,
): { browser: CaptureEnvironment['browser']; driver?: CaptureEnvironment['driver'] } | null {
  if (!caps || typeof caps !== 'object') return null;
  const c = caps as Record<string, unknown> & { get?: (key: string) => unknown };
  const get = (key: string): unknown => (typeof c.get === 'function' ? c.get(key) : c[key]);
  const rawName = get('browserName');
  if (typeof rawName !== 'string' || rawName.length === 0) return null;
  const known = WEBDRIVER_BROWSERS[rawName.toLowerCase()];
  const version = get('browserVersion') ?? get('version');
  const browser: CaptureEnvironment['browser'] = {
    name: known?.name ?? rawName.toLowerCase(),
    version: typeof version === 'string' && version.length > 0 ? version : null,
  };
  if (known?.channel) browser.channel = known.channel;

  const options = (get('goog:chromeOptions') ?? get('ms:edgeOptions') ?? get('moz:firefoxOptions')) as { args?: unknown } | undefined;
  if (options && Array.isArray(options.args)) {
    browser.headless = options.args.some((a) => typeof a === 'string' && /^-{1,2}headless(=|$)/.test(a));
  }

  let driverVersion: string | undefined;
  if (known?.driver === 'chromedriver') driverVersion = firstToken((get('chrome') as { chromedriverVersion?: unknown } | undefined)?.chromedriverVersion);
  if (known?.driver === 'msedgedriver') driverVersion = firstToken((get('msedge') as { msedgedriverVersion?: unknown } | undefined)?.msedgedriverVersion);
  if (known?.driver === 'geckodriver') driverVersion = firstToken(get('moz:geckodriverVersion'));
  return driverVersion && known?.driver ? { browser, driver: { name: known.driver, version: driverVersion } } : { browser };
}

/**
 * The version of a package as the project at `root` resolves it (the user's
 * own webdriverio or selenium-webdriver, not one bundled here), or null.
 */
export function installedPackageVersion(name: string, root: string = process.cwd()): string | null {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, { paths: [root] });
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

// ── Render probe ────────────────────────────────────────────────────────────

/**
 * One self-contained in-page expression (no imports, no closures) that
 * measures what the page is actually rendered with. Measured, not taken from
 * configuration: a config can say 1280×720 at scale 1 while the browser
 * renders something else. Each field is read on its own, so one missing API
 * never loses the rest.
 */
export const RENDER_PROBE_EXPRESSION = `(function () {
  var out = {};
  try { out.viewport = { width: window.innerWidth, height: window.innerHeight }; } catch (e) {}
  try { out.deviceScaleFactor = window.devicePixelRatio; } catch (e) {}
  try { out.colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) {}
  try { out.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'; } catch (e) {}
  try { out.locale = navigator.language; } catch (e) {}
  try { out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  try { out.userAgent = navigator.userAgent; } catch (e) {}
  return out;
})()`;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Validate the probe's result. Mistyped fields are dropped, never trusted. */
export function parseRenderProbe(raw: unknown): { render: RenderEnvironment; userAgent?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const render: RenderEnvironment = {};
  const vp = r.viewport as Record<string, unknown> | undefined;
  if (vp && isNumber(vp.width) && isNumber(vp.height)) render.viewport = { width: vp.width, height: vp.height };
  if (isNumber(r.deviceScaleFactor)) render.deviceScaleFactor = r.deviceScaleFactor;
  if (r.colorScheme === 'light' || r.colorScheme === 'dark') render.colorScheme = r.colorScheme;
  if (r.reducedMotion === 'reduce' || r.reducedMotion === 'no-preference') render.reducedMotion = r.reducedMotion;
  if (isString(r.locale)) render.locale = r.locale;
  if (isString(r.timezone)) render.timezone = r.timezone;
  return isString(r.userAgent) ? { render, userAgent: r.userAgent } : { render };
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** Drop undefined members, so the block round-trips through JSON unchanged. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

export interface CaptureEnvironmentParts {
  host: HostEnvironment;
  browser: CaptureEnvironment['browser'];
  adapter: CaptureEnvironment['adapter'];
  framework?: CaptureEnvironment['framework'];
  driver?: CaptureEnvironment['driver'];
  render?: RenderEnvironment;
  project?: string;
}

/** Assemble the block from what one adapter observed. */
export function buildCaptureEnvironment(parts: CaptureEnvironmentParts): CaptureEnvironment {
  const { host } = parts;
  // Built in the documented order (docs/extension-api.md), so metadata.json reads the same everywhere.
  const env = {
    os: compact({ ...host.os }),
    browser: compact({ ...parts.browser }),
  } as CaptureEnvironment;
  if (parts.framework) env.framework = compact({ ...parts.framework });
  env.adapter = { ...parts.adapter };
  if (parts.driver) env.driver = { ...parts.driver };
  if (parts.render) {
    const render = compact({ ...parts.render });
    if (Object.keys(render).length > 0) env.render = render;
  }
  if (host.ci) env.ci = compact({ ...host.ci });
  if (host.container) env.container = true;
  if (host.label) env.label = host.label;
  if (parts.project) env.project = parts.project;
  return env;
}

export interface WebDriverEnvironmentInput {
  /** The session's capabilities (WebdriverIO browser.capabilities, Selenium getCapabilities()). */
  capabilities: unknown;
  /** The raw RENDER_PROBE_EXPRESSION result. */
  probe: unknown;
  adapter: CaptureEnvironment['adapter'];
  framework: { name: string; version: string | null };
  host?: HostEnvironment;
}

/**
 * The block for a WebDriver adapter: the browser and driver from the
 * capabilities (the user agent when they say nothing), the render settings
 * from the probe. Null when neither names the browser: never guessed.
 */
export function webDriverEnvironment(input: WebDriverEnvironmentInput): CaptureEnvironment | null {
  const probed = parseRenderProbe(input.probe);
  const fromCaps = browserFromCapabilities(input.capabilities);
  const browser = fromCaps?.browser ?? (probed?.userAgent ? browserFromUserAgent(probed.userAgent) : null);
  if (!browser) return null;
  return buildCaptureEnvironment({
    host: input.host ?? collectHostEnvironment(),
    browser,
    framework: { ...input.framework },
    adapter: input.adapter,
    driver: fromCaps?.driver,
    render: probed?.render,
  });
}

/**
 * The block as recorded in a metadata.json, or null when there is none:
 * captures from before provenance, or from an adapter that does not record
 * it. Only the three parts every recorder writes are required.
 */
export function readEnvironment(raw: unknown): CaptureEnvironment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, any>;
  const obj = (v: unknown) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (!obj(e.os) || typeof e.os.platform !== 'string') return null;
  if (!obj(e.browser) || typeof e.browser.name !== 'string') return null;
  if (!obj(e.adapter) || typeof e.adapter.captureMethod !== 'string') return null;
  return e as CaptureEnvironment;
}

// ── separate policy ─────────────────────────────────────────────────────────

const safeSegment = (s: string) => s.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();

/** Node's process.platform values: a suffix ending in one of them is an environment variant. */
const PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'];

/**
 * environmentPolicy "separate" keys each snapshot by environment:
 * `<name>__<browser>__<platform>`, the same in-the-name mechanism as the
 * Playwright multi-project variant, so the on-disk layout, results.json, the
 * report, approvals and the approve action all work unchanged. A browser the
 * name already ends with (a project named after it) is not repeated. Never
 * keyed by version: a browser upgrade should be seen, not hidden behind a
 * fresh baseline. Other policies return the name unchanged.
 */
export function applyEnvironmentPolicyToName(
  name: string,
  env: { browser: { name: string }; os: { platform: string } },
  policy: EnvironmentPolicy | undefined,
): string {
  if (policy !== 'separate') return name;
  const browser = safeSegment(env.browser.name);
  const platform = safeSegment(env.os.platform);
  const segments = name.split('__');
  const withBrowser = segments.length > 1 && segments[segments.length - 1] === browser ? name : `${name}__${browser}`;
  return `${withBrowser}__${platform}`;
}

/** The variant a separate-policy name carries, or null for a name without one. */
export function parseEnvironmentVariant(name: string): { base: string; browser: string; platform: string } | null {
  const segments = name.split('__');
  if (segments.length < 3) return null;
  const platform = segments[segments.length - 1];
  if (!PLATFORMS.includes(platform)) return null;
  return { base: segments.slice(0, -2).join('__'), browser: segments[segments.length - 2], platform };
}
