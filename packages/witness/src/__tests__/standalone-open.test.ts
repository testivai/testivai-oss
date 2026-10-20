import * as vm from 'vm';
import { openPage } from '../standalone/run';

/**
 * A fake Chrome behind chrome-remote-interface. A new tab shows about:blank,
 * whose readyState is already 'complete', until the response for the URL it
 * was asked to load arrives: `responseAfter` polls of the page later, the
 * way a server that takes a moment to answer (or a freshly launched Chrome)
 * keeps the tab on about:blank. The page then loads for `loadingFor` polls.
 */
interface FakeTab {
  href: string;
  readyState: 'loading' | 'complete';
  /** The URL the tab was asked to load, once it was. */
  requested?: string;
  polls: number;
  /** What the tab showed when the viewport override arrived, if it did. */
  viewportAppliedAt?: { href: string; requested?: string };
}

const mockBrowser = {
  tabs: new Map<string, FakeTab>(),
  responseAfter: 3,
  loadingFor: 2,
  /** Make Page.enable fail, to test cleanup. */
  failEnable: false,
  closedTargets: [] as string[],
  closedClients: 0,
  viewports: [] as unknown[],

  reset() {
    this.tabs.clear();
    this.responseAfter = 3;
    this.loadingFor = 2;
    this.failEnable = false;
    this.closedTargets = [];
    this.closedClients = 0;
    this.viewports = [];
  },

  request(tab: FakeTab, url: string) {
    tab.requested = url;
    tab.polls = 0;
  },

  /** One poll of the page: time passes, the response may arrive, the page may finish loading. */
  tick(tab: FakeTab) {
    if (!tab.requested) return;
    tab.polls++;
    if (tab.polls === this.responseAfter) {
      tab.href = tab.requested;
      tab.readyState = 'loading';
    }
    if (tab.polls === this.responseAfter + this.loadingFor) tab.readyState = 'complete';
  },

  open({ url }: { port: number; url?: string }) {
    const id = `target-${this.tabs.size + 1}`;
    const tab: FakeTab = { href: 'about:blank', readyState: 'complete', polls: 0 };
    if (url && url !== 'about:blank') this.request(tab, url);
    this.tabs.set(id, tab);
    return { id };
  },

  client(targetId: string) {
    const tab = this.tabs.get(targetId);
    if (!tab) throw new Error(`no target ${targetId}`);
    return {
      Page: {
        enable: async () => {
          if (this.failEnable) throw new Error('Page.enable failed');
        },
        navigate: async ({ url }: { url: string }) => {
          this.request(tab, url);
          return { frameId: 'main', loaderId: 'loader-1' };
        },
      },
      Runtime: {
        enable: async () => undefined,
        evaluate: async ({ expression }: { expression: string }) => {
          this.tick(tab);
          try {
            const value = vm.runInNewContext(expression, {
              location: { href: tab.href },
              document: { readyState: tab.readyState },
            });
            return { result: { value } };
          } catch (err) {
            return { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: String(err) } };
          }
        },
      },
      Emulation: {
        setDeviceMetricsOverride: async (params: unknown) => {
          tab.viewportAppliedAt = { href: tab.href, requested: tab.requested };
          this.viewports.push(params);
        },
      },
      close: async () => {
        this.closedClients++;
      },
    };
  },
};

jest.mock('chrome-remote-interface', () => {
  const connect = jest.fn(async ({ target }: { target: string }) => mockBrowser.client(target));
  Object.assign(connect, {
    New: jest.fn(async (options: { port: number; url?: string }) => mockBrowser.open(options)),
    Close: jest.fn(async ({ id }: { id: string }) => {
      mockBrowser.closedTargets.push(id);
    }),
  });
  return { __esModule: true, default: connect };
});

const URL = 'http://localhost:3000/pricing';
const VIEWPORT = { width: 1280, height: 800 };

function tabOf(page: { targetId: string }): FakeTab {
  const tab = mockBrowser.tabs.get(page.targetId);
  if (!tab) throw new Error(`no tab ${page.targetId}`);
  return tab;
}

describe('openPage', () => {
  beforeEach(() => {
    mockBrowser.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns only once the tab shows the requested page, not the about:blank it opened on', async () => {
    // about:blank already reports readyState 'complete'; the page's response
    // has not arrived yet. Preparing and capturing now would style, hide
    // ignored elements in, and measure about:blank, then capture the real
    // page unprepared, its entry animations still running.
    const page = await openPage(9222, URL, VIEWPORT);

    expect(tabOf(page)).toMatchObject({ href: URL, readyState: 'complete' });
  });

  it('waits through the page loading as well', async () => {
    mockBrowser.responseAfter = 1;
    mockBrowser.loadingFor = 3;

    const page = await openPage(9222, URL, VIEWPORT);

    expect(tabOf(page)).toMatchObject({ href: URL, readyState: 'complete' });
  });

  it('applies the viewport before the page is requested, so it never loads at another size', async () => {
    const page = await openPage(9222, URL, VIEWPORT);

    expect(mockBrowser.viewports).toEqual([{ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }]);
    expect(tabOf(page).viewportAppliedAt).toEqual({ href: 'about:blank', requested: undefined });
  });

  it('leaves the viewport alone when none is given', async () => {
    const page = await openPage(9222, URL);

    expect(mockBrowser.viewports).toEqual([]);
    expect(tabOf(page)).toMatchObject({ href: URL, readyState: 'complete' });
  });

  it('stops waiting after a bounded time when the page never finishes loading, and returns the tab', async () => {
    jest.useFakeTimers();
    mockBrowser.responseAfter = Number.POSITIVE_INFINITY;
    let opened: { targetId: string } | undefined;
    const pending = openPage(9222, URL, VIEWPORT).then((page) => {
      opened = page;
    });

    await jest.advanceTimersByTimeAsync(5_000);
    expect(opened).toBeUndefined(); // still waiting: a slow page gets time to load
    await jest.advanceTimersByTimeAsync(15_000);
    await pending;

    expect(opened).toBeDefined();
    expect(tabOf(opened as { targetId: string }).href).toBe('about:blank');
  });

  it('runs the prepare hook before the page is requested, so it sees every request the page makes', async () => {
    const seen: Array<{ href: string; requested?: string }> = [];
    const page = await openPage(9222, URL, VIEWPORT, (client) => {
      const tab = [...mockBrowser.tabs.values()][0];
      expect(client).toBeDefined();
      seen.push({ href: tab.href, requested: tab.requested });
    });

    expect(seen).toEqual([{ href: 'about:blank', requested: undefined }]);
    expect(tabOf(page)).toMatchObject({ href: URL, readyState: 'complete' });
  });

  it('closes the tab again when it cannot be prepared', async () => {
    mockBrowser.failEnable = true;

    await expect(openPage(9222, URL, VIEWPORT)).rejects.toThrow('Page.enable failed');

    expect(mockBrowser.closedTargets).toEqual(['target-1']);
    expect(mockBrowser.closedClients).toBe(1);
  });
});
