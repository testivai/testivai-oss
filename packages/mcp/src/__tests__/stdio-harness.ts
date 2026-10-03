import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The BUILT server, launched the way an MCP client launches it: a child
 * process speaking JSON-RPC over stdio. Testing through it guards what the
 * model actually sees, not just the source constants.
 *
 * Requires `dist/` to be built first (CI builds before test).
 */
export const BUILT_SERVER = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

/** Spawn the built server against `root` and connect an MCP client to it. */
export async function connectBuiltServer(root: string): Promise<Client> {
  if (!fs.existsSync(BUILT_SERVER)) {
    throw new Error(`${BUILT_SERVER} does not exist. Run \`pnpm build\` before the tests (CI builds first).`);
  }
  const client = new Client({ name: 'testivai-mcp-tests', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [BUILT_SERVER, '--root', root] }),
  );
  return client;
}
