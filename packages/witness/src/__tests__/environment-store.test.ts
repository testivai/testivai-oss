/**
 * Capture provenance on disk: adapters merge the environment into the
 * capture's temp metadata.json, and approving a capture freezes it into the
 * baseline's metadata.json. A capture without one leaves the baseline
 * without one: an environment from an older approval would describe a
 * screenshot it did not take.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaselineStore } from '../baselines/store';
import type { CaptureEnvironment } from '../capture/environment';
import { loadLocalConfig } from '../config/local-config';
import { validateLocalConfig } from '../config/validate-config';

const ENV: CaptureEnvironment = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
  browser: { name: 'chromium', version: '141.0.7390.37', headless: true },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.7', captureMethod: 'full-page:cdp' },
};

describe('BaselineStore and the environment', () => {
  let root: string;
  let store: BaselineStore;
  const tempMeta = (name: string) => JSON.parse(fs.readFileSync(path.join(root, '.testivai', 'temp', name, 'metadata.json'), 'utf-8'));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-env-store-'));
    store = new BaselineStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writeTempMetadata creates the temp metadata.json', () => {
    store.writeTemp('home', Buffer.from('png'));
    store.writeTempMetadata('home', { name: 'home', environment: ENV });
    expect(tempMeta('home')).toEqual({ name: 'home', environment: ENV });
  });

  it('writeTempMetadata merges into what the adapter already wrote (masks stay)', () => {
    store.writeTemp('home', Buffer.from('png'));
    store.writeTempMetadata('home', { name: 'home', masks: [{ x: 0, y: 0, width: 10, height: 10 }] });
    store.writeTempMetadata('home', { environment: ENV });
    expect(tempMeta('home')).toEqual({ name: 'home', masks: [{ x: 0, y: 0, width: 10, height: 10 }], environment: ENV });
  });

  it('writeTempMetadata replaces a malformed file instead of throwing', () => {
    store.writeTemp('home', Buffer.from('png'));
    fs.writeFileSync(path.join(root, '.testivai', 'temp', 'home', 'metadata.json'), '{not json');
    store.writeTempMetadata('home', { environment: ENV });
    expect(tempMeta('home')).toEqual({ environment: ENV });
  });

  it('readTempMetadata reads it back, null when there is none', () => {
    store.writeTemp('home', Buffer.from('png'));
    expect(store.readTempMetadata('home')).toBeNull();
    store.writeTempMetadata('home', { environment: ENV });
    expect(store.readTempMetadata('home')).toEqual({ environment: ENV });
  });

  it('approve freezes the capture environment into the baseline metadata', () => {
    store.writeTemp('home', Buffer.from('png'));
    store.writeTempMetadata('home', { name: 'home', environment: ENV });
    store.approve('home');
    expect(store.readMetadata('home')).toMatchObject({ name: 'home', approvedBy: 'local', environment: ENV });
  });

  it('approving a capture without one drops the environment of the previous baseline', () => {
    store.writeTemp('home', Buffer.from('png'));
    store.writeTempMetadata('home', { environment: ENV });
    store.approve('home');

    store.writeTemp('home', Buffer.from('png2'));
    fs.rmSync(path.join(root, '.testivai', 'temp', 'home', 'metadata.json'));
    store.approve('home');
    expect(store.readMetadata('home')?.environment).toBeUndefined();
    // The previous baseline, kept for undo, still has it.
    const previous = JSON.parse(fs.readFileSync(path.join(store.getBaselineDir('home'), '.previous', 'metadata.json'), 'utf-8'));
    expect(previous.environment).toEqual(ENV);
  });

  it('a malformed environment in the capture is not frozen', () => {
    store.writeTemp('home', Buffer.from('png'));
    store.writeTempMetadata('home', { environment: { os: 'linux' } });
    store.approve('home');
    expect(store.readMetadata('home')?.environment).toBeUndefined();
  });
});

describe('environmentPolicy config', () => {
  it('accepts warn, separate and strict', () => {
    for (const environmentPolicy of ['warn', 'separate', 'strict']) {
      expect(validateLocalConfig({ environmentPolicy })).toEqual({ warnings: [], invalidKeys: [] });
    }
  });

  it('rejects another value with the allowed ones, so the default applies', () => {
    expect(validateLocalConfig({ environmentPolicy: 'stric' })).toEqual({
      warnings: ['config key "environmentPolicy" should be one of "warn", "separate", "strict", got "stric" — using the default ("warn") instead.'],
      invalidKeys: ['environmentPolicy'],
    });
    expect(validateLocalConfig({ environmentPolicy: true }).invalidKeys).toEqual(['environmentPolicy']);
  });

  it('defaults to warn', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-env-config-'));
    try {
      expect(loadLocalConfig(root).environmentPolicy).toBe('warn');
      fs.mkdirSync(path.join(root, '.testivai'));
      fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ environmentPolicy: 'strict' }));
      expect(loadLocalConfig(root).environmentPolicy).toBe('strict');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
