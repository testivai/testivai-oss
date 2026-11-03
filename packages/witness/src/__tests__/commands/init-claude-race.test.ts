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
  return { ...real, existsSync: jest.fn(real.existsSync), readFileSync: jest.fn(real.readFileSync) };
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
    // The skill's look (an exists check or a read) sees no file; it lands before the write.
    (fs.existsSync as jest.Mock).mockImplementationOnce((p: fs.PathLike) => p !== target && jest.requireActual('fs').existsSync(p));
    (fs.readFileSync as jest.Mock).mockImplementationOnce(() => {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    });

    expect(installClaudeSkill(tmp)).toEqual({ status: 'conflict', path: target });
    expect(fs.readFileSync(target, 'utf8')).toBe('theirs\n');
    expect(fs.readFileSync(target, 'utf8')).not.toBe(TESTIVAI_SKILL);
  });
});
