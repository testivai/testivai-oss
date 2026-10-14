import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { REVIEW_PROMPT, TOOL_META, TRIAGE_PROMPT } from '../tool-meta';
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
  // A person reading the conversation may not see images the client gives the
  // model, so the output ends with paths they can open. The verdict lines are
  // untouched; the paths come after them, before the closing instruction.
  it('get_visual_results lists the report and diff image paths after the verdicts', async () => {
    const report = path.join(root, 'visual-report');
    fs.mkdirSync(path.join(report, 'images', 'card'), { recursive: true });
    fs.writeFileSync(path.join(report, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(report, 'images', 'card', 'diff.png'), 'x');
    fs.writeFileSync(
      path.join(report, 'results.json'),
      JSON.stringify({
        version: '2.3.0',
        timestamp: 't',
        summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
        snapshots: [
          {
            name: 'card',
            status: 'changed',
            diffPercent: 2,
            diffPath: 'images/card/diff.png',
            dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
          },
        ],
      }),
    );

    const lines = textOf(await client.callTool({ name: 'get_visual_results', arguments: {} })).split('\n');

    const verdict = lines.indexOf(
      '- card: changed (2.00% pixels differ) and the DOM changed (1 added, 0 removed, 0 attribute changes) — a real structural change; confirm it is intended before approving',
    );
    const header = lines.indexOf('Open on this machine:');
    const closing = lines.findIndex((l) => l.startsWith('Baseline approval is a human decision'));
    expect(verdict).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(verdict);
    expect(closing).toBeGreaterThan(header);
    expect(lines).toContain(`- report: ${path.join(report, 'index.html')}`);
    expect(lines).toContain(`- card (diff): ${path.join(report, 'images', 'card', 'diff.png')}`);
  });

  // The prompt the client fetches is the one the model follows: it must not
  // sort an identical-DOM diff whose styles were not compared into noise.
  it('serves the review-visual-changes prompt with the styles-not-compared case', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['review-visual-changes', 'triage-visual-diff']);
    const prompt = await client.getPrompt({ name: 'review-visual-changes' });
    const text = (prompt.messages[0].content as { type: string; text: string }).text;
    expect(text).toMatch(/styles not compared[^.]*could be render noise or a stylesheet-only change/i);
    expect(text).not.toMatch(/ignore-as-noise/i);
    expect(text).toBe(REVIEW_PROMPT.text);
  });

  it('serves triage-visual-diff with optional snapshot and intent arguments', async () => {
    const { prompts } = await client.listPrompts();
    const triage = prompts.find((p) => p.name === 'triage-visual-diff');
    expect(triage?.arguments?.map((a) => [a.name, a.required ?? false]).sort()).toEqual([
      ['intent', false],
      ['snapshot', false],
    ]);
    // Clients send an arguments object even when nothing was filled in: empty,
    // or with empty strings. (The SDK rejects a request with no object at all.)
    const all = await client.getPrompt({ name: 'triage-visual-diff', arguments: {} });
    expect((all.messages[0].content as { text: string }).text).toBe(TRIAGE_PROMPT.textFor({}));
    const blank = await client.getPrompt({ name: 'triage-visual-diff', arguments: { snapshot: '', intent: '' } });
    expect((blank.messages[0].content as { text: string }).text).toBe(TRIAGE_PROMPT.textFor({}));
    const one = await client.getPrompt({ name: 'triage-visual-diff', arguments: { snapshot: 'home', intent: 'Add a promo banner.' } });
    const text = (one.messages[0].content as { text: string }).text;
    expect(text).toBe(TRIAGE_PROMPT.textFor({ snapshot: 'home', intent: 'Add a promo banner.' }));
    expect(text).toMatch(/snapshot `home`/);
  });

  it('get_visual_results never calls identical-DOM diffs whose styles were not compared noise', async () => {
    const report = path.join(root, 'visual-report');
    fs.mkdirSync(report, { recursive: true });
    const notCompared = (name: string) => ({
      name,
      status: 'changed',
      diffPercent: 0.5,
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
    });
    fs.writeFileSync(
      path.join(report, 'results.json'),
      JSON.stringify({
        version: '2.3.0',
        timestamp: 't',
        summary: { total: 2, passed: 0, changed: 2, newSnapshots: 0 },
        snapshots: [notCompared('home'), notCompared('about')],
      }),
    );

    const text = textOf(await client.callTool({ name: 'get_visual_results', arguments: {} }));

    expect(text).toContain(
      '- about, home (2): identical DOM, styles not compared (style check unavailable): render noise or a stylesheet-only change, not ruled out',
    );
    expect(text).toContain(
      '- home: changed (0.50% pixels differ) but the DOM is structurally identical and styles were not compared (style check unavailable) — could be render noise or a stylesheet-only change; look at the diff before approving',
    );
    expect(text).not.toMatch(/likely render noise|don't block/i);
  });

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

// get_visual_results with real results.json (fixtures/README.md): the groups
// section comes first, and every per-snapshot line is exactly what it was.
describe('change groups in get_visual_results (built server over stdio)', () => {
  const { verdictFor } = require('../lib') as typeof import('../lib');
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-groups-'));
    client = await connectBuiltServer(root);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = async (fixture: string) => {
    const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8'));
    fs.mkdirSync(path.join(root, 'visual-report'), { recursive: true });
    fs.writeFileSync(path.join(root, 'visual-report', 'results.json'), JSON.stringify(results));
    const result = await client.callTool({ name: 'get_visual_results', arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    return { results, lines: text.split('\n') };
  };

  it('lists the group before the per-snapshot lines, which are unchanged', async () => {
    const { results, lines } = await run('example-brand-synthetic-pages.results.json');
    const verdictLines = results.snapshots.map((s: import('../lib').SnapshotResult) => `- ${s.name}: ${verdictFor(s)}`);

    const header = lines.findIndex((l) => l.startsWith('Grouped by identical signal'));
    const firstVerdict = lines.indexOf(verdictLines[0]);
    expect(header).toBeGreaterThan(-1);
    expect(firstVerdict).toBeGreaterThan(header);
    expect(lines[header + 1]).toMatch(/^- buttons, home, products \(3\): style-only change that restyled the same 6 elements/);
    expect(lines.slice(firstVerdict, firstVerdict + verdictLines.length)).toEqual(verdictLines);
  });

  it('prints no groups section when nothing shares a signal', async () => {
    const results = {
      version: '2.3.0',
      timestamp: 't',
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [{ name: 'solo', status: 'changed', diffPercent: 1, dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' } }],
    };
    fs.writeFileSync(path.join(root, 'visual-report', 'results.json'), JSON.stringify(results));
    const result = await client.callTool({ name: 'get_visual_results', arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).not.toMatch(/Grouped by identical signal/);
    expect(text).toContain(`- solo: ${verdictFor(results.snapshots[0] as import('../lib').SnapshotResult)}`);
  });
});
