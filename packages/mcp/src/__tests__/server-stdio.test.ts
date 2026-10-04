import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { TOOL_META } from '../tool-meta';
import { connectBuiltServer } from './stdio-harness';

/**
 * The tool descriptions are unit-tested in tool-meta.test.ts; this guards the
 * wiring: the built server must advertise exactly those constants, because
 * the advertised text is what the model reads before calling a tool.
 */
describe('built server over stdio', () => {
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-stdio-'));
    client = await connectBuiltServer(root);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

  it('advertises the get_visual_results description from tool-meta', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_visual_results');
    expect(tool?.description).toBe(TOOL_META.get_visual_results.description);
  });

  it('advertises every tool, and only those, with its tool-meta title, description and _meta', async () => {
    const { tools } = await client.listTools();
    const advertised = Object.fromEntries(
      tools.map((t) => [t.name, { title: t.title, description: t.description, ...(t._meta ? { _meta: t._meta } : {}) }]),
    );
    expect(advertised).toEqual(TOOL_META);
  });

  // Claude Code reads this from tools/list and then prompts the user on every
  // approve call: the approval happens in their terminal or UI.
  it('the approve tools reach the client marked as requiring user interaction', async () => {
    const { tools } = await client.listTools();
    const marked = tools
      .filter((t) => t._meta?.['anthropic/requiresUserInteraction'] === true)
      .map((t) => t.name)
      .sort();
    expect(marked).toEqual(['approve_all', 'approve_snapshot']);
  });

  it('approve_snapshot promotes the pending capture to the committed baseline', async () => {
    const temp = path.join(root, '.testivai', 'temp', 'home');
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'screenshot.png'), PNG.sync.write(new PNG({ width: 2, height: 2 })));
    fs.writeFileSync(path.join(temp, 'dom.html'), '<html></html>');

    const result = await client.callTool({ name: 'approve_snapshot', arguments: { name: 'home' } });

    expect(JSON.parse(textOf(result))).toEqual({ approved: ['home'], failed: [] });
    expect(fs.existsSync(path.join(root, '.testivai', 'baselines', 'home', 'screenshot.png'))).toBe(true);
  });

  // The footer is what the agent reads right after the verdicts: it must still
  // forbid approving on its own, and offer the in-conversation path for when
  // the human confirms (the client then asks them to allow the call).
  it('get_visual_results offers in-conversation approval once the human confirms', async () => {
    const report = path.join(root, 'visual-report');
    fs.mkdirSync(report, { recursive: true });
    fs.writeFileSync(
      path.join(report, 'results.json'),
      JSON.stringify({
        version: '2.3.0',
        timestamp: 't',
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [
          {
            name: 'home',
            status: 'changed',
            diffPercent: 5,
            dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
          },
        ],
      }),
    );

    const text = textOf(await client.callTool({ name: 'get_visual_results', arguments: {} }));

    expect(text).toContain('- home: changed (5.00% pixels differ) and the DOM changed');
    expect(text).toMatch(/do not approve (on your own|autonomously)/i);
    expect(text).toMatch(/human confirms[^.;]*approve_snapshot/i);
  });
});

// The per-call approval prompt is on by default; a user can turn it off with
// the server flag or with mcpApprovalPrompt in .testivai/config.json, and the
// flag wins. Off means the approve tools follow the client's own permission
// settings (allow rules, "don't ask again", auto modes).
describe('approval prompt setting (built server over stdio)', () => {
  const roots: string[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  const start = async (config: Record<string, unknown> | null, args: string[] = []) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-prompt-'));
    roots.push(root);
    if (config) {
      fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
      fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify(config));
    }
    const client = await connectBuiltServer(root, args);
    clients.push(client);
    return client;
  };

  const marked = async (client: Client) =>
    (await client.listTools()).tools
      .filter((t) => t._meta?.['anthropic/requiresUserInteraction'] === true)
      .map((t) => t.name)
      .sort();

  it('--no-approval-prompt: no tool forces the prompt', async () => {
    expect(await marked(await start(null, ['--no-approval-prompt']))).toEqual([]);
  }, 30_000);

  it('mcpApprovalPrompt: false in config.json: no tool forces the prompt', async () => {
    expect(await marked(await start({ mcpApprovalPrompt: false }))).toEqual([]);
  }, 30_000);

  it('--approval-prompt wins over mcpApprovalPrompt: false', async () => {
    expect(await marked(await start({ mcpApprovalPrompt: false }, ['--approval-prompt']))).toEqual([
      'approve_all',
      'approve_snapshot',
    ]);
  }, 30_000);
});
