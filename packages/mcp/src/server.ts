#!/usr/bin/env node
import * as fs from 'fs';
import { z, } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolvePaths, readResults, verdictFor, resolveImage, listBaselines, downscalePng, approveSnapshot, approveAll, explainSnapshot, describeMissingResults, reportLinks } from './lib';
import { TOOL_META } from './tool-meta';

const packageJson = require('../package.json');

// Project root: --root <path> flag or cwd (MCP clients set cwd to the workspace).
const rootFlag = process.argv.indexOf('--root');
const projectRoot = rootFlag !== -1 && process.argv[rootFlag + 1] ? process.argv[rootFlag + 1] : process.cwd();

const server = new McpServer({ name: 'testivai', version: packageJson.version });

server.registerTool(
  'get_visual_results',
  {
    ...TOOL_META.get_visual_results,
    inputSchema: {},
  },
  async () => {
    const paths = resolvePaths(projectRoot);
    const results = readResults(paths);
    if (!results) {
      return {
        content: [
          {
            type: 'text',
            text: describeMissingResults(projectRoot),
          },
        ],
      };
    }
    const lines = [
      `Run: ${results.timestamp} — ${results.summary.total} snapshots: ${results.summary.passed} passed, ${results.summary.changed} changed, ${results.summary.newSnapshots} new.`,
      '',
      ...results.snapshots.map((s) => `- ${s.name}: ${verdictFor(s)}`),
      '',
      ...withBlankAfter(reportLinks(paths, results)),
      'Baseline approval is a human decision: do not approve on your own. When the human confirms a change in this conversation, ' +
        'call approve_snapshot with its name (approve_all only after they have reviewed every change); ' +
        'otherwise suggest `npx testivai approve <name>` locally or `/testivai approve <name>` on the PR.',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// A section of lines followed by a blank separator, or nothing when empty.
function withBlankAfter(section: string[]): string[] {
  return section.length > 0 ? [...section, ''] : [];
}

// Shared handler for the diff-image tools (registered under two names).
const snapshotDiffHandler = async ({ name }: { name: string }) => {
  const paths = resolvePaths(projectRoot);
  const results = readResults(paths);
  const snapshot = results?.snapshots.find((s) => s.name === name);
  if (!results || !snapshot) {
    return { content: [{ type: 'text', text: `No snapshot named "${name}" in the latest results.` }] };
  }
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
    { type: 'text', text: `${snapshot.name}: ${verdictFor(snapshot)}` },
  ];
  for (const [label, rel] of [
    ['baseline', snapshot.baselinePath],
    ['current', snapshot.currentPath],
    ['diff', snapshot.diffPath],
  ] as const) {
    const abs = rel ? resolveImage(paths, rel) : null;
    if (abs) {
      const raw = fs.readFileSync(abs);
      const downscaled = downscalePng(raw);
      const wasDownscaled =
        downscaled.originalWidth !== downscaled.width ||
        downscaled.originalHeight !== downscaled.height;
      const textLabel = wasDownscaled
        ? `${label} (downscaled from ${downscaled.originalWidth}x${downscaled.originalHeight}):`
        : `${label}:`;
      content.push({ type: 'text', text: textLabel });
      content.push({ type: 'image', data: downscaled.data.toString('base64'), mimeType: 'image/png' });
    }
  }
  return { content };
};

const diffInputSchema = { name: z.string().describe('Snapshot name from the results') };

// registerTool is called through an untyped alias: zod@3.25 + TS 6 blow the
// type-depth limit (TS2589) when inferring the schema generics. Runtime
// validation of the input schema is unaffected.
// `get_diff` is the canonical name; `get_snapshot_diff` is kept as an alias.
(server.registerTool as Function)('get_diff', { ...TOOL_META.get_diff, inputSchema: diffInputSchema }, snapshotDiffHandler);
(server.registerTool as Function)('get_snapshot_diff', { ...TOOL_META.get_snapshot_diff, inputSchema: diffInputSchema }, snapshotDiffHandler);

// get_report — the raw results.json payload (the public schema) for agents
// that want to parse structured data rather than the human summary.
server.registerTool(
  'get_report',
  {
    ...TOOL_META.get_report,
    inputSchema: {},
  },
  async () => {
    const results = readResults(resolvePaths(projectRoot));
    if (!results) {
      return { content: [{ type: 'text', text: describeMissingResults(projectRoot) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

// approve_snapshot / approve_all — promote current captures to committed
// baselines. Approval accepts a new visual truth, so only call these once a
// reviewer has confirmed the change is intended (not a regression).
(server.registerTool as Function)(
  'approve_snapshot',
  {
    ...TOOL_META.approve_snapshot,
    inputSchema: { name: z.string().describe('Snapshot name to approve') },
  },
  async ({ name }: { name: string }) => {
    const result = approveSnapshot(projectRoot, name);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'approve_all',
  {
    ...TOOL_META.approve_all,
    inputSchema: {},
  },
  async () => {
    const result = approveAll(projectRoot);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'list_baselines',
  {
    ...TOOL_META.list_baselines,
    inputSchema: {},
  },
  async () => {
    const names = listBaselines(projectRoot);
    return {
      content: [
        {
          type: 'text',
          text: names.length ? `Baselines (${names.length}):\n${names.map((n) => `- ${n}`).join('\n')}` : 'No baselines yet — the first test run creates them.',
        },
      ],
    };
  }
);

// explain_snapshot — the layered evidence bundle (pixel regions → element
// attribution → DOM/style signals → guidance). The client's own model turns
// this into the narrative; the server ships evidence, not an LLM.
(server.registerTool as Function)(
  'explain_snapshot',
  {
    ...TOOL_META.explain_snapshot,
    inputSchema: { name: z.string().describe('Snapshot name from the results') },
  },
  async ({ name }: { name: string }) => {
    const explanation = explainSnapshot(projectRoot, name);
    if (!explanation) {
      return { content: [{ type: 'text', text: `No snapshot named "${name}" in the latest results. Run the visual tests first.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(explanation, null, 2) }] };
  }
);

// A reusable prompt that turns the evidence into a review narrative.
server.registerPrompt(
  'review-visual-changes',
  {
    title: 'Review visual changes',
    description:
      'Walk the latest visual results and produce a human-quality review: what changed, why, and what to do.',
  },
  async () => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            'Review the latest TestivAI visual regression results in this project:',
            '',
            '1. Call get_report for the summary. If nothing changed and nothing is new, say so and stop.',
            '2. For every changed snapshot, call explain_snapshot(name) and read its layers and guidance.',
            '   When the evidence is ambiguous, call get_diff(name) and inspect the images.',
            '3. For each snapshot, explain in one short paragraph WHAT changed (name the selectors),',
            '   WHY it likely happened (use pageShift/shift classifications — e.g. content injected above),',
            '   and whether it is render noise, a style-only change, or a structural change.',
            '4. End with a recommendation per snapshot: approve, investigate, or ignore-as-noise.',
            '   Never call approve_snapshot/approve_all yourself unless the human has explicitly',
            '   confirmed the changes are intended — baseline approval is a human decision.',
          ].join('\n'),
        },
      },
    ],
  })
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('testivai-mcp failed to start:', err);
  process.exit(1);
});
