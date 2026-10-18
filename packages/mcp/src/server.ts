#!/usr/bin/env node
import { z, } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadLocalConfig } from '@testivai/witness/config';
import { resolvePaths, readResults, verdictFor, listBaselines, approveSnapshot, approveAll, explainSnapshot, describeMissingResults, resolveApprovalPrompt, reportLinks, changeGroupLines, withPromptArguments, summaryLine, environmentLines, missingBaselineLines, missingBaselineDiff, baselinesDirFor } from './lib';
import { CROP_LIMITS, snapshotDiffContent, type DiffRequest } from './diff-images';
import { REVIEW_PROMPT, TRIAGE_PROMPT, toolMetaFor } from './tool-meta';

const packageJson = require('../package.json');

// Project root: --root <path> flag or cwd (MCP clients set cwd to the workspace).
const rootFlag = process.argv.indexOf('--root');
const projectRoot = rootFlag !== -1 && process.argv[rootFlag + 1] ? process.argv[rootFlag + 1] : process.cwd();

// Approve tools force a per-call permission prompt unless the user turned it
// off: --approval-prompt / --no-approval-prompt, then mcpApprovalPrompt in
// .testivai/config.json, then on.
const approvalPrompt = resolveApprovalPrompt(process.argv.slice(2), loadLocalConfig(projectRoot).mcpApprovalPrompt);
const TOOL_META = toolMetaFor({ approvalPrompt });

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
      summaryLine(results),
      // An environment change several snapshots share, said once up front.
      ...environmentLines(results.snapshots),
      '',
      ...withBlankAfter(changeGroupLines(results.snapshots)),
      ...results.snapshots.map((s) => `- ${s.name}: ${verdictFor(s)}`),
      // Committed baselines that got no capture this run: nothing to approve.
      ...missingBaselineLines(projectRoot, results),
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

// Shared handler for the diff-image tools (registered under two names): the
// full page downscaled, then native-scale crops of the changed regions, or
// only the region or band asked for (diff-images.ts).
const snapshotDiffHandler = async ({ name, region, y, height }: { name: string } & DiffRequest) => {
  const paths = resolvePaths(projectRoot);
  const results = readResults(paths);
  const snapshot = results?.snapshots.find((s) => s.name === name);
  if (!results || !snapshot) {
    // A missing baseline has no current capture: its committed screenshot only.
    const missing = results ? missingBaselineDiff(projectRoot, results, name) : null;
    if (missing) {
      const asked = region !== undefined || y !== undefined || height !== undefined;
      const note = 'region, y and height crop a snapshot in the results; a missing baseline has no regions, so its committed screenshot is shown whole.';
      return { content: asked ? [...missing, { type: 'text', text: note }] : missing };
    }
    return { content: [{ type: 'text', text: `No snapshot named "${name}" in the latest results.` }] };
  }
  return { content: snapshotDiffContent(paths, snapshot, { region, y, height }) };
};

const diffInputSchema = {
  name: z.string().describe('Snapshot name from the results'),
  region: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Index of one of the snapshot's regions, as get_diff lists them (results.json order): returns only that region, cropped at native scale"),
  y: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Top of a full-width band of the page, in pixels: returns only that band, at native scale'),
  height: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Rows of the band from y (default: what one crop shows, ${CROP_LIMITS.maxHeight} at native scale); a taller band shows its top rows and says where to continue`,
    ),
};

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

// A reusable prompt that turns the evidence into a review narrative. Its text
// lives in tool-meta.ts so tests can read it without starting the server.
server.registerPrompt(
  REVIEW_PROMPT.name,
  {
    title: REVIEW_PROMPT.title,
    description: REVIEW_PROMPT.description,
  },
  async () => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: REVIEW_PROMPT.text,
        },
      },
    ],
  })
);

// Glitch, intended change, bug or possible bug for one snapshot or all of
// them. The arguments are optional; the text quotes them (tool-meta.ts).
server.registerPrompt(
  TRIAGE_PROMPT.name,
  {
    title: TRIAGE_PROMPT.title,
    description: TRIAGE_PROMPT.description,
    argsSchema: {
      snapshot: z.string().optional().describe(TRIAGE_PROMPT.args.snapshot),
      intent: z.string().optional().describe(TRIAGE_PROMPT.args.intent),
    },
  },
  async ({ snapshot, intent }) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: TRIAGE_PROMPT.textFor({ snapshot, intent, baselinesDir: baselinesDirFor(projectRoot) }) },
      },
    ],
  })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // After connect, which installs the server's handler: see withPromptArguments.
  const handle = transport.onmessage;
  transport.onmessage = (message) => handle?.(withPromptArguments(message));
}

main().catch((err) => {
  console.error('testivai-mcp failed to start:', err);
  process.exit(1);
});
