/**
 * Capture health in `testivai witness <url>`: the in-page probe, plus what
 * the crawler saw on the network (CDP Network events), merged in the same
 * shape. The network sees statuses the page cannot (cross-origin requests
 * without Timing-Allow-Origin) and requests that never got a response.
 */
import { EventEmitter } from 'events';
import type { CaptureHealth } from '../capture/health';
import { standaloneHealth, watchNetwork } from '../standalone/run';

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'unavailable', failed: {} },
};

function fakeClient() {
  const events = new EventEmitter();
  const enable = jest.fn(async () => undefined);
  return { client: { on: (event: string, handler: (e: unknown) => void) => events.on(event, handler), Network: { enable } }, events, enable };
}

describe('watchNetwork', () => {
  it('collects requests that answered 400 or more, or failed without a response, by type', async () => {
    const { client, events, enable } = fakeClient();
    const watch = await watchNetwork(client);
    expect(enable).toHaveBeenCalled();

    const send = (id: string, url: string, type: string) => events.emit('Network.requestWillBeSent', { requestId: id, request: { url }, type });
    send('1', 'https://cdn.example.net/fonts/fancy.woff2?k=1', 'Font');
    events.emit('Network.responseReceived', { requestId: '1', type: 'Font', response: { url: 'https://cdn.example.net/fonts/fancy.woff2?k=1', status: 404 } });
    send('2', 'https://example.com/css/site.css', 'Stylesheet');
    events.emit('Network.loadingFailed', { requestId: '2', type: 'Stylesheet', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false });
    send('3', 'https://example.com/ok.css', 'Stylesheet');
    events.emit('Network.responseReceived', { requestId: '3', type: 'Stylesheet', response: { url: 'https://example.com/ok.css', status: 200 } });
    // The page itself, a cancelled request, and Chrome's ERR_ABORTED without a status: not failures of the capture.
    send('4', 'https://example.com/missing-page', 'Document');
    events.emit('Network.responseReceived', { requestId: '4', type: 'Document', response: { url: 'https://example.com/missing-page', status: 404 } });
    send('5', 'https://example.com/a.png', 'Image');
    events.emit('Network.loadingFailed', { requestId: '5', type: 'Image', errorText: 'net::ERR_ABORTED', canceled: true });
    send('6', 'https://example.com/b.png', 'Image');
    events.emit('Network.loadingFailed', { requestId: '6', type: 'Image', errorText: 'net::ERR_ABORTED', canceled: false });
    // The favicon Chrome asks for by itself.
    send('8', 'https://example.com/favicon.ico', 'Other');
    events.emit('Network.responseReceived', { requestId: '8', type: 'Other', response: { url: 'https://example.com/favicon.ico', status: 404 } });
    // A 404 that Chrome also reports as failed: the status wins.
    send('7', 'https://example.com/app.js', 'Script');
    events.emit('Network.responseReceived', { requestId: '7', type: 'Script', response: { url: 'https://example.com/app.js', status: 500 } });
    events.emit('Network.loadingFailed', { requestId: '7', type: 'Script', errorText: 'net::ERR_ABORTED', canceled: false });

    expect(watch.failures()).toEqual([
      { url: 'https://cdn.example.net/fonts/fancy.woff2?k=1', type: 'font', status: 404 },
      { url: 'https://example.com/css/site.css', type: 'css', status: 0, error: 'net::ERR_CONNECTION_REFUSED' },
      { url: 'https://example.com/app.js', type: 'script', status: 500 },
    ]);
  });
});

describe('standaloneHealth', () => {
  it('the probe and the network evidence, merged; URLs as host and path', () => {
    const health = standaloneHealth(HEALTHY, [{ url: 'https://cdn.example.net/fonts/fancy.woff2?k=1', type: 'font', status: 404 }]);
    expect(health?.resources).toEqual({
      status: 'checked',
      failed: { font: { count: 1, entries: [{ url: 'cdn.example.net/fonts/fancy.woff2', status: 404 }] } },
    });
  });

  it('the probe alone when the network was not watched', () => {
    expect(standaloneHealth(HEALTHY, null)).toEqual(HEALTHY);
  });

  it('no health without a valid probe result: not checked, whatever the network saw', () => {
    expect(standaloneHealth(undefined, [{ url: 'https://example.com/a.css', type: 'css', status: 404 }])).toBeNull();
    expect(standaloneHealth({ fonts: 'x' }, [])).toBeNull();
  });
});
