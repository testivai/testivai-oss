/**
 * Reading a `/testivai approve` comment (approve/action.yml's first step).
 *
 * testivai/testivai-site#26: `/testivai approve-all` was read as `approve`
 * with the target `-all`, so the action looked for a snapshot named `-all`
 * and replied with generic reasons that never named the typo. `approve` must
 * now be a word of its own: anything glued to it is an unknown command, and
 * the reply says so and shows the right spelling. There are no aliases:
 * `--all` is the only way to approve everything, and `approve all` (with a
 * space) still names a snapshot called `all`.
 */

import { buildUnknownCommandReply, parseApproveCommand } from '../approve';

describe('parseApproveCommand', () => {
  it.each([
    ['/testivai approve --all', '--all'],
    ['/testivai approve', '--all'],
    ['/testivai approve   ', '--all'],
    ['/testivai approve home', 'home'],
    ['/testivai approve home home-mobile', 'home home-mobile'],
    ['/testivai   approve   home   home-mobile  ', 'home home-mobile'],
    ['/TestivAI APPROVE home', 'home'],
    ['/testivai approve all', 'all'],
    ['/testivai approve nope', 'nope'],
    ['  /testivai approve home\n', 'home'],
  ])('%j approves %j', (body, target) => {
    expect(parseApproveCommand(body)).toEqual({ kind: 'approve', target });
  });

  it.each([
    ['/testivai approve-all', '/testivai approve-all', '/testivai approve --all'],
    ['/testivai approve--all', '/testivai approve--all', '/testivai approve --all'],
    ['/testivai approve_all', '/testivai approve_all', '/testivai approve --all'],
    ['/testivai approveall', '/testivai approveall', '/testivai approve --all'],
    ['/testivai Approve-All', '/testivai Approve-All', '/testivai approve --all'],
    ['/testivai approvefoo', '/testivai approvefoo', undefined],
    ['/testivai approved', '/testivai approved', undefined],
    ['/testivai approve-all home', '/testivai approve-all home', undefined],
  ])('%j is an unknown command, never a target', (body, command, suggestion) => {
    expect(parseApproveCommand(body)).toEqual({ kind: 'unknown', command, ...(suggestion ? { suggestion } : {}) });
  });

  it.each([
    ['not a command', 'looks good to me'],
    ['another /testivai command', '/testivai help'],
    ['no space after /testivai', '/testivaiapprove home'],
    ['a command in the middle of a comment', 'please /testivai approve home'],
    ['an empty comment', ''],
  ])('%s is not handled (no reply)', (_label, body) => {
    expect(parseApproveCommand(body)).toBeNull();
  });

  it('shows at most the first line of an unknown command, cut to a readable length', () => {
    const parsed = parseApproveCommand(`/testivai approve-${'x'.repeat(300)}`);
    expect(parsed?.kind).toBe('unknown');
    if (parsed?.kind !== 'unknown') return;
    expect(parsed.command.length).toBeLessThanOrEqual(81);
    expect(parsed.command.endsWith('…')).toBe(true);
  });
});

describe('buildUnknownCommandReply', () => {
  it('names the typo and the command it most likely meant', () => {
    const body = buildUnknownCommandReply({ kind: 'unknown', command: '/testivai approve-all', suggestion: '/testivai approve --all' });
    expect(body.split('\n')[0]).toBe('Unknown command `/testivai approve-all`. Did you mean `/testivai approve --all`?');
    expect(body).toContain('No baselines were updated.');
    expect(body).toContain('`/testivai approve --all`');
    expect(body).toContain('`/testivai approve <name> [<name> …]`');
  });

  it('shows the usage when there is no likely meaning', () => {
    const body = buildUnknownCommandReply({ kind: 'unknown', command: '/testivai approvefoo' });
    expect(body.split('\n')[0]).toBe('Unknown command `/testivai approvefoo`.');
    expect(body).not.toContain('Did you mean');
    expect(body).toContain('`/testivai approve <name> [<name> …]`');
  });

  it('a backtick in the command cannot end its code span early', () => {
    const body = buildUnknownCommandReply({ kind: 'unknown', command: '/testivai approve`[x](https://evil.example)`' });
    expect(body.split('\n')[0]).toBe('Unknown command `` /testivai approve`[x](https://evil.example)` ``.');
  });
});
