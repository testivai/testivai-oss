/**
 * `testivai init-claude`: writes the /testivai skill for Claude Code into
 * the project, and the skill's own rules (who may run it, what approve does).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLAUDE_SKILL_PATH, installClaudeSkill, TESTIVAI_SKILL } from '../../claude/skill';
import { initClaudeCommand } from '../../commands/init-claude';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

describe('the /testivai skill', () => {
  const frontmatter = (TESTIVAI_SKILL.match(/^---\n([\s\S]*?)\n---\n/) ?? [])[1] ?? '';

  it('is a skill named testivai', () => {
    expect(frontmatter).toMatch(/^name: testivai$/m);
    expect(frontmatter).toMatch(/^description: .+/m);
    expect(frontmatter).toMatch(/^argument-hint: .+/m);
  });

  it('only runs when a person types it: the model cannot invoke it on its own', () => {
    expect(frontmatter).toMatch(/^disable-model-invocation: true$/m);
  });

  it('pre-approves no tool that posts or pushes', () => {
    const allowed = (frontmatter.match(/^allowed-tools: (.*)$/m) ?? [])[1] ?? '';
    expect(allowed).not.toMatch(/gh|git|curl/);
    expect(allowed).toContain('Bash(npx testivai approve:*)');
  });

  it('receives what the person typed', () => {
    expect(TESTIVAI_SKILL).toContain('$ARGUMENTS');
  });

  it('never runs a bare `npx testivai approve` (it opens an interactive list)', () => {
    expect(TESTIVAI_SKILL).toMatch(/never run a bare `npx testivai approve`/i);
  });

  // Found dogfooding 2.7.0: a page with an added <style> read only as a DOM
  // change, so the restyled button (dom.styleChanges) went unmentioned.
  it('status names style changes even when the DOM also changed', () => {
    expect(TESTIVAI_SKILL.replace(/\s+/g, ' ')).toMatch(/also name the elements in `dom\.styleChanges`/);
  });

  // Found dogfooding 2.7.0: index.html loads its screenshots from images/,
  // which the app's side panel cannot show, so the report had no images.
  it('report shows the page with its images inlined (report --share, share.html)', () => {
    expect(TESTIVAI_SKILL).toContain('npx testivai report --share');
    expect(TESTIVAI_SKILL).toContain('share.html');
    const allowed = (frontmatter.match(/^allowed-tools: (.*)$/m) ?? [])[1] ?? '';
    expect(allowed).toContain('Bash(npx testivai report --share)');
  });

  it('report never uploads: no --share when the config sets shareUploadCommand', () => {
    const text = TESTIVAI_SKILL.replace(/\s+/g, ' ');
    expect(text).toMatch(/sets `shareUploadCommand`, never run it with `--share`/);
  });

  it('puts the PR comment command alone on the first line', () => {
    expect(TESTIVAI_SKILL).toContain('`/testivai approve <target>`');
    expect(TESTIVAI_SKILL).toMatch(/first line/i);
  });

  it('is the same file as the copy in docs/', () => {
    const docsCopy = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'claude-code', 'testivai', 'SKILL.md'), 'utf8');
    expect(docsCopy).toBe(TESTIVAI_SKILL);
  });
});

describe('installClaudeSkill', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-init-claude-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const target = () => path.join(tmp, CLAUDE_SKILL_PATH);

  it('writes .claude/skills/testivai/SKILL.md, creating the folders', () => {
    expect(CLAUDE_SKILL_PATH).toBe(path.join('.claude', 'skills', 'testivai', 'SKILL.md'));
    expect(installClaudeSkill(tmp)).toEqual({ status: 'created', path: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe(TESTIVAI_SKILL);
  });

  it('changes nothing when the file is already this version', () => {
    installClaudeSkill(tmp);
    const before = fs.statSync(target()).mtimeMs;
    expect(installClaudeSkill(tmp)).toEqual({ status: 'unchanged', path: target() });
    expect(fs.statSync(target()).mtimeMs).toBe(before);
  });

  it('keeps a file someone changed, unless forced', () => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'my own skill\n');
    expect(installClaudeSkill(tmp)).toEqual({ status: 'conflict', path: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe('my own skill\n');

    expect(installClaudeSkill(tmp, { force: true })).toEqual({ status: 'updated', path: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe(TESTIVAI_SKILL);
  });

  it('--force replaces a longer file whole, leaving none of its bytes behind', () => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'x'.repeat(TESTIVAI_SKILL.length * 2));
    expect(installClaudeSkill(tmp, { force: true })).toEqual({ status: 'updated', path: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe(TESTIVAI_SKILL);
  });

  it('--force on a file that is already this version changes nothing', () => {
    installClaudeSkill(tmp);
    const before = fs.statSync(target()).mtimeMs;
    expect(installClaudeSkill(tmp, { force: true })).toEqual({ status: 'unchanged', path: target() });
    expect(fs.statSync(target()).mtimeMs).toBe(before);
  });

  it('touches nothing else under .claude/', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'other'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(tmp, '.claude', 'skills', 'other', 'SKILL.md'), 'x');
    installClaudeSkill(tmp);
    expect(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8')).toBe('{}');
    expect(fs.readFileSync(path.join(tmp, '.claude', 'skills', 'other', 'SKILL.md'), 'utf8')).toBe('x');
  });
});

describe('testivai init-claude', () => {
  let tmp: string;
  let out: string[];
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-init-claude-cmd-'));
    out = [];
    jest.spyOn(process, 'cwd').mockReturnValue(tmp);
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    process.exitCode = undefined;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (...args: string[]) => initClaudeCommand.parseAsync(['node', 'init-claude', ...args]);

  it('writes the skill and says how to use it', async () => {
    await run();
    expect(fs.readFileSync(path.join(tmp, CLAUDE_SKILL_PATH), 'utf8')).toBe(TESTIVAI_SKILL);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.join('\n')).toContain('/testivai');
  });

  it('fails without overwriting a changed file, and names --force', async () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'testivai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, CLAUDE_SKILL_PATH), 'mine\n');
    await run();
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(path.join(tmp, CLAUDE_SKILL_PATH), 'utf8')).toBe('mine\n');
    expect(out.join('\n')).toContain('--force');
  });

  it('--force replaces it', async () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'testivai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, CLAUDE_SKILL_PATH), 'mine\n');
    await run('--force');
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(path.join(tmp, CLAUDE_SKILL_PATH), 'utf8')).toBe(TESTIVAI_SKILL);
  });

  it('--json prints the result', async () => {
    const writes: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    await run('--json');
    expect(JSON.parse(writes.join(''))).toEqual({ status: 'created', path: path.join(tmp, CLAUDE_SKILL_PATH) });
  });
});

describe('the testivai CLI', () => {
  it('has the init-claude command', () => {
    const bin = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'testivai.ts'), 'utf8');
    expect(bin).toMatch(/program\.addCommand\(initClaudeCommand\)/);
  });
});
