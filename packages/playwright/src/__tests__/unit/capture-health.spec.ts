/**
 * Capture health for the Playwright adapter: witness() runs the shared probe
 * in the page right after the screenshot (capture-health-order.spec.ts pins
 * when) and merges its result into the capture's metadata.json as `health`. Best-effort: a probe that fails or returns
 * something malformed records nothing (not checked), never a guess.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaselineStore, HEALTH_PROBE_EXPRESSION } from '@testivai/witness';
import { probeCaptureHealth, recordCaptureHealth } from '../../capture/health';

const HEALTH = {
  fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};

describe('probeCaptureHealth + recordCaptureHealth', () => {
  let root: string;
  let store: BaselineStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-pw-health-'));
    store = new BaselineStore(root);
    store.writeTempMetadata('home', { name: 'home', environment: { kept: true } });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('evaluates the shared probe and merges its result into metadata.json, keeping what is there', async () => {
    const evaluate = jest.fn(async () => HEALTH);
    recordCaptureHealth(store, 'home', await probeCaptureHealth({ evaluate }));
    expect(evaluate).toHaveBeenCalledWith(HEALTH_PROBE_EXPRESSION);
    expect(store.readTempMetadata('home')).toEqual({ name: 'home', environment: { kept: true }, health: HEALTH });
  });

  it('records nothing when the probe throws (a page that navigated away)', async () => {
    const health = await probeCaptureHealth({ evaluate: async () => Promise.reject(new Error('Execution context was destroyed')) });
    expect(health).toBeNull();
    recordCaptureHealth(store, 'home', health);
    expect(store.readTempMetadata('home')).toEqual({ name: 'home', environment: { kept: true } });
  });

  it('records nothing for a malformed result: not checked, never healthy', async () => {
    const health = await probeCaptureHealth({ evaluate: async () => ({ fonts: 'loaded' }) });
    expect(health).toBeNull();
    recordCaptureHealth(store, 'home', health);
    expect(store.readTempMetadata('home')?.health).toBeUndefined();
  });
});
