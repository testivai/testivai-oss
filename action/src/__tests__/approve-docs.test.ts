/**
 * Contract between the approve action and the docs that tell people how to
 * set it up.
 *
 * The approve action calls the Actions API (`gh run list`, `gh run download`),
 * so its token needs `actions: read`. A workflow with an explicit
 * `permissions:` block that leaves it out fails with HTTP 403. And a push
 * made with GITHUB_TOKEN starts no workflow run, so the docs must not promise
 * that CI re-runs after an approve without saying which token makes it so.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Fenced code blocks that set up the approve action. */
function approveWorkflows(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.filter((b) => b.includes('testivai/testivai-oss/approve@'));
}

/** The `permissions:` block that applies to the approve job in a workflow. */
function approvePermissions(workflow: string): string {
  const lines = workflow.split('\n');
  const uses = lines.findIndex((l) => l.includes('testivai/testivai-oss/approve@'));
  // Nearest permissions block above the step: the job's own, else the workflow's.
  for (let i = uses; i >= 0; i--) {
    if (/^\s*permissions:\s*$/.test(lines[i])) {
      const indent = lines[i].match(/^\s*/)![0].length;
      const body: string[] = [];
      for (const line of lines.slice(i + 1)) {
        if (line.trim() && line.match(/^\s*/)![0].length <= indent) break;
        body.push(line);
      }
      return body.join('\n');
    }
  }
  return '';
}

const DOCS_WITH_WORKFLOWS = ['README.md', 'docs/github-action.md'];

describe('approve setup docs', () => {
  it('at least one doc shows a full approve workflow', () => {
    const found = DOCS_WITH_WORKFLOWS.flatMap((f) => approveWorkflows(read(f)));
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(DOCS_WITH_WORKFLOWS)('%s: every approve workflow grants actions: read', (file) => {
    for (const workflow of approveWorkflows(read(file))) {
      const permissions = approvePermissions(workflow);
      expect(permissions).toMatch(/^\s*actions:\s*read\b/m);
      expect(permissions).toMatch(/^\s*contents:\s*write\b/m);
      expect(permissions).toMatch(/^\s*pull-requests:\s*write\b/m);
    }
  });

  it("approve/action.yml's github-token input lists actions: read", () => {
    const action = read('approve/action.yml');
    const description = action.match(/github-token:\n\s+description: >\n([\s\S]*?)\n\s+required:/)?.[1] ?? '';
    expect(description).toMatch(/actions:\s*read/);
  });

  it('docs/github-action.md explains that a GITHUB_TOKEN push starts no run, and the token workaround', () => {
    const doc = read('docs/github-action.md');
    // Either word order: "GITHUB_TOKEN ... starts no run" or "starts no run ... GITHUB_TOKEN".
    expect(doc).toMatch(/GITHUB_TOKEN[^\n]*starts no (workflow )?run|starts no (workflow )?run[^\n]*GITHUB_TOKEN/i);
    expect(doc).toMatch(/fine-grained personal access token/i);
  });

  it('docs/github-action.md says the approve token also lets the Pages publish follow the approve', () => {
    const doc = read('docs/github-action.md');
    const start = doc.indexOf('### Approve with a token that re-runs CI');
    const section = doc.slice(start, doc.indexOf('\n### ', start + 1));
    expect(section).toMatch(/publish@v1|Pages/);
    expect(section).toContain('#reports-on-github-pages');
  });

  it.each(['README.md', 'SKILLS.md', 'AGENTS.md', 'CLAUDE.md', 'approve/action.yml'])(
    '%s does not promise an unconditional CI re-run after approve',
    (file) => {
      expect(read(file)).not.toMatch(/CI re-runs automatically|CI will re-run automatically|CI re-runs → passes/);
    },
  );
});
