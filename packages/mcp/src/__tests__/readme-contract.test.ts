import * as fs from 'fs';
import * as path from 'path';
import { TOOL_META } from '../tool-meta';

/**
 * Guards against README ↔ server drift. The package README is what npm shows
 * and what people (and agents) read to learn the tool surface, so it must
 * document every tool the server registers and must not contradict it.
 */
const PKG_DIR = path.join(__dirname, '..', '..');
const REPO_ROOT = path.join(PKG_DIR, '..', '..');
const README = path.join(PKG_DIR, 'README.md');
const read = (file: string) => fs.readFileSync(file, 'utf-8');

describe('@testivai/mcp README', () => {
  const readme = read(README);

  it('documents every tool the server registers', () => {
    const undocumented = Object.keys(TOOL_META).filter((name) => !readme.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });

  it('describes the style-only verdict, not just DOM-identical noise', () => {
    expect(readme).toMatch(/style-only/i);
  });
});

// approve_snapshot / approve_all exist so a human can approve in conversation;
// a guide that says there is no approve tool sends readers to the wrong flow.
describe('agent guides describe the approve tools that exist', () => {
  const GUIDES = [README, path.join(REPO_ROOT, 'CLAUDE.md'), path.join(REPO_ROOT, 'AGENTS.md')];

  it.each(GUIDES.map((file) => [path.relative(REPO_ROOT, file), file]))(
    '%s does not claim the MCP server has no approve tool',
    (_rel, file) => {
      expect(read(file)).not.toMatch(/no approve tool/i);
    },
  );
});
