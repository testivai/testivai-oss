/**
 * AGENTS.md and CLAUDE.md are read by different coding agents, so a rule
 * stated in both must say the same thing in both. The complexity rule is
 * applied one change at a time: an agent brings a function below the limit
 * when its change edits that function, and leaves the rest of the code alone.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The paragraph that starts with the rule's bold title, list marker removed, whitespace joined. */
function complexityRule(file: string): string {
  const lines = read(file).split('\n');
  const start = lines.findIndex((l) => /^\s*(?:\d+\.|-)\s+\*\*Keep cyclomatic complexity/.test(l));
  if (start < 0) throw new Error(`${file} has no complexity rule`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === '');
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join(' ')
    .replace(/^\s*(?:\d+\.|-)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the cyclomatic complexity rule in the agent guides', () => {
  const rule = complexityRule('AGENTS.md');

  test('AGENTS.md and CLAUDE.md state it the same way', () => {
    expect(complexityRule('CLAUDE.md')).toBe(rule);
  });

  test('it binds the code a change edits, not the whole codebase at once', () => {
    expect(rule).toMatch(/below 10 in the code you change/);
    expect(rule).toMatch(/New functions start below 10/);
    expect(rule).toMatch(/edits an existing function at 10 or more, bring it below 10 in the same PR/);
    expect(rule).toMatch(/Leave functions the change does not edit as they are/);
  });

  test('the split is test-first and kept apart from the behaviour change', () => {
    expect(rule).toMatch(/tests that pin today's behaviour first/);
    expect(rule).toMatch(/own commit, before the behaviour change/);
  });

  test('the functions it names as sent to the browser as text really are', () => {
    const named = /sent to the browser as text \(([^)]+)\)/.exec(rule)?.[1];
    const names = [...(named ?? '').matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const sources = ['element-map.ts', 'settle.ts'].map((f) => read(path.join('packages', 'witness', 'src', 'capture', f))).join('\n');
    for (const name of names) {
      expect({ name, serialized: sources.includes(`${name}.toString()`) }).toEqual({ name, serialized: true });
    }
  });
});
