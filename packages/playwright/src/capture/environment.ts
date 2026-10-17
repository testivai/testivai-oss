/**
 * Capture provenance for the Playwright adapter: the `environment` block
 * witness() records in the capture's metadata.json (see capture/environment.ts
 * in @testivai/witness for the shape and why it matters).
 *
 * Sources, in order of trust: the project's own `use` settings and Playwright's
 * browser.version(); the in-page render probe (what the page is actually
 * rendered with); the user agent as the fallback for a browser that cannot be
 * asked (a persistent context has no browser()). Nothing is guessed: what none
 * of them says is left out, or null for the version.
 */
import {
  browserFromUserAgent,
  buildCaptureEnvironment,
  collectHostEnvironment,
  parseRenderProbe,
  type CaptureEnvironment,
  type HostEnvironment,
} from '@testivai/witness';

/** The parts of Playwright's TestInfo this reads (structural, so tests need no runner). */
export interface TestInfoLike {
  config?: { version?: string };
  project?: { name?: string; use?: Record<string, unknown> };
  file?: string;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ADAPTER_VERSION: string = require('../../package.json').version;

/** The engine witness() runs in: the project's browserName, else the user agent, else Playwright's default. */
export function playwrightBrowserName(testInfo: TestInfoLike, userAgent: string | undefined): string {
  const configured = testInfo.project?.use?.browserName;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return browserFromUserAgent(userAgent ?? '')?.name ?? 'chromium';
}

export interface PlaywrightEnvironmentInput {
  testInfo: TestInfoLike;
  /** page.context().browser()?.version(), or null when there is no browser to ask. */
  browserVersion: string | null;
  /** The raw RENDER_PROBE_EXPRESSION result (null when the probe failed). */
  probe: unknown;
  captureMethod: string;
  /** Injected in tests; collected from this machine otherwise. */
  host?: HostEnvironment;
}

export function playwrightEnvironment(input: PlaywrightEnvironmentInput): CaptureEnvironment {
  const { testInfo } = input;
  const use = testInfo.project?.use ?? {};
  const probed = parseRenderProbe(input.probe);
  const fromUa = probed?.userAgent ? browserFromUserAgent(probed.userAgent) : null;

  const browser: CaptureEnvironment['browser'] = {
    name: playwrightBrowserName(testInfo, probed?.userAgent),
    version: input.browserVersion ?? fromUa?.version ?? null,
  };
  if (typeof use.channel === 'string' && use.channel.length > 0) browser.channel = use.channel;
  if (typeof use.headless === 'boolean') browser.headless = use.headless;
  else if (fromUa?.headless) browser.headless = true;

  const file = testInfo.file ?? '';
  const projectName = testInfo.project?.name;
  return buildCaptureEnvironment({
    host: input.host ?? collectHostEnvironment(),
    browser,
    framework: {
      name: 'playwright',
      version: testInfo.config?.version ?? null,
      language: /\.[cm]?tsx?$/.test(file) ? 'typescript' : 'javascript',
      runner: '@playwright/test',
    },
    adapter: { name: '@testivai/witness-playwright', version: ADAPTER_VERSION, captureMethod: input.captureMethod },
    render: probed?.render,
    project: typeof projectName === 'string' && projectName.length > 0 ? projectName : undefined,
  });
}
