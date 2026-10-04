/**
 * Tests for `.testivai/config.json` validation — unknown keys get a
 * did-you-mean warning, mistyped values are dropped so defaults apply,
 * and nothing ever throws.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateLocalConfig, levenshtein } from '../config/validate-config';
import { loadLocalConfig } from '../config/local-config';

describe('levenshtein', () => {
  it('computes classic distances', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('a', '')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('threshold', 'thresold')).toBe(1);
  });
});

describe('validateLocalConfig', () => {
  it('returns no warnings for a clean config', () => {
    const result = validateLocalConfig({
      threshold: 0.1,
      autoOpen: false,
      ignoreSelectors: ['.ad'],
      mask: ['#banner', { top: 24 }],
      diffRegions: { minSize: 10 },
      viewport: { width: 1280, height: 800 },
    });
    expect(result.warnings).toEqual([]);
    expect(result.invalidKeys).toEqual([]);
  });

  // Read by @testivai/mcp: false stops the approve tools from forcing a
  // permission prompt on every call (they follow the client's own settings).
  it('accepts mcpApprovalPrompt as a boolean', () => {
    expect(validateLocalConfig({ mcpApprovalPrompt: false })).toEqual({ warnings: [], invalidKeys: [] });
  });

  it('flags a non-boolean mcpApprovalPrompt so the default (prompt) applies', () => {
    const result = validateLocalConfig({ mcpApprovalPrompt: 'off' });
    expect(result.invalidKeys).toEqual(['mcpApprovalPrompt']);
    expect(result.warnings[0]).toContain('"mcpApprovalPrompt" should be a boolean');
  });

  it('suggests the closest known key for a typo', () => {
    const result = validateLocalConfig({ thresold: 0.2 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"thresold"');
    expect(result.warnings[0]).toContain('did you mean "threshold"');
  });

  it('suggests case-insensitively', () => {
    const result = validateLocalConfig({ maxdiffpercent: 1 });
    expect(result.warnings[0]).toContain('did you mean "maxDiffPercent"');
  });

  it('lists known keys when nothing is close', () => {
    const result = validateLocalConfig({ zzzTotallyUnknown: true });
    expect(result.warnings[0]).toContain('unknown config key "zzzTotallyUnknown"');
    expect(result.warnings[0]).toContain('Known keys:');
    expect(result.warnings[0]).not.toContain('did you mean');
  });

  it('flags a mistyped value and marks the key invalid', () => {
    const result = validateLocalConfig({ threshold: '0.1' });
    expect(result.warnings[0]).toContain('"threshold" should be a number, got string');
    expect(result.invalidKeys).toEqual(['threshold']);
  });

  it('distinguishes arrays from objects', () => {
    const bad = validateLocalConfig({ ignoreSelectors: { selector: '.x' } });
    expect(bad.warnings[0]).toContain('should be a array, got object');
    const good = validateLocalConfig({ ignoreSelectors: [] });
    expect(good.warnings).toEqual([]);
  });

  it('gives the retired mode key a targeted notice, not a typo suggestion', () => {
    const result = validateLocalConfig({ mode: 'local' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('retired');
    expect(result.warnings[0]).not.toContain('did you mean');
    // Retired keys are ignored, not treated as type errors.
    expect(result.invalidKeys).toEqual([]);
  });

  it('warns when the config root is not an object', () => {
    expect(validateLocalConfig([1, 2]).warnings[0]).toContain('got array');
    expect(validateLocalConfig('local').warnings[0]).toContain('got string');
    expect(validateLocalConfig(null).warnings[0]).toContain('got null');
  });
});

describe('loadLocalConfig integration', () => {
  let tmpDir: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-validate-'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  function writeConfig(content: string): void {
    const dir = path.join(tmpDir, '.testivai');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), content);
  }

  it('drops mistyped values so defaults apply', () => {
    writeConfig(JSON.stringify({ threshold: '0.5', failOnDiff: true }));
    const config = loadLocalConfig(tmpDir);
    expect(config.threshold).toBe(0.1); // default, not the string
    expect(config.failOnDiff).toBe(true); // valid key untouched
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('should be a number'));
  });

  it('keeps unknown keys (forward compatibility) but warns', () => {
    writeConfig(JSON.stringify({ futureKnob: 42 }));
    const config = loadLocalConfig(tmpDir) as unknown as Record<string, unknown>;
    expect(config.futureKnob).toBe(42);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('futureKnob'));
  });

  it('warns once per config path, not once per load', () => {
    writeConfig(JSON.stringify({ thresold: 0.2 }));
    loadLocalConfig(tmpDir);
    loadLocalConfig(tmpDir);
    const typoWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('thresold'));
    expect(typoWarnings).toHaveLength(1);
  });

  it('warns when the file is not valid JSON and returns defaults', () => {
    writeConfig('{ not json');
    const config = loadLocalConfig(tmpDir);
    expect(config.threshold).toBe(0.1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });
});
