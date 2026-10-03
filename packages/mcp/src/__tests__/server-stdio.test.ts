import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  it('advertises the get_visual_results description from tool-meta', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_visual_results');
    expect(tool?.description).toBe(TOOL_META.get_visual_results.description);
  });

  it('advertises every tool, and only those, with its tool-meta title and description', async () => {
    const { tools } = await client.listTools();
    const advertised = Object.fromEntries(
      tools.map((t) => [t.name, { title: t.title, description: t.description }]),
    );
    expect(advertised).toEqual(TOOL_META);
  });
});
