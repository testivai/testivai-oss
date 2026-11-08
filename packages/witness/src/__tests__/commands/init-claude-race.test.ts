/**
 * installClaudeSkill never overwrites a file that appears after it looked
 * and found none (CodeQL js/file-system-race). fs is wrapped so a test can
 * make the read miss a file that is in fact there.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLAUDE_SKILL_PATH, installClaudeSkill, TESTIVAI_SKILL } from '../../claude/skill';

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return { ...real, existsSync: jest.fn(real.existsSync), readFileSync: jest.fn(real.readFileSync), openSync: jest.fn(real.openSync) };
});

describe('installClaudeSkill and a file created meanwhile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-init-claude-race-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('keeps it and reports a conflict', () => {
    const target = path.join(tmp, CLAUDE_SKILL_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'theirs\n');
    // Every look at the path (an exists check, a read or an open) sees no
    // file, once; the file is there by the time the skill writes.
    const real = jest.requireActual('fs');
    const missing = () => {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    };
    (fs.existsSync as jest.Mock).mockImplementationOnce((p: fs.PathLike) => p !== target && real.existsSync(p));
    (fs.readFileSync as jest.Mock).mockImplementationOnce((p: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
      p === target ? missing() : real.readFileSync(p, ...rest),
    );
    (fs.openSync as jest.Mock).mockImplementationOnce((p: fs.PathLike, ...rest: unknown[]) =>
      p === target ? missing() : real.openSync(p, ...rest),
    );

    expect(installClaudeSkill(tmp)).toEqual({ status: 'conflict', path: target });
    // The real fs: a stub the skill did not use is still waiting.
    expect(real.readFileSync(target, 'utf8')).toBe('theirs\n');
    expect(real.readFileSync(target, 'utf8')).not.toBe(TESTIVAI_SKILL);
  });
});
