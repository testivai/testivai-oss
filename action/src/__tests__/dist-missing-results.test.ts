/**
 * The bundled action (dist/index.js, what `uses: testivai/testivai-oss@v1`
 * runs) on a run without results.json, run as GitHub runs it: a node process
 * with INPUT_* and GITHUB_* in its environment, talking to a GitHub REST API
 * (a local server here, which records every request). It checks what the
 * unit tests on src/ cannot: that the comparison bundled into dist/ (the
 * witness report code and pngjs) runs, and the exit code the step ends with.
 *
 * Needs dist/ built from the current src/ (`pnpm run build` in action/; CI
 * checks dist/ is up to date).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

const DIST = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const WHITE =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4AWP8DwQMSICJAQ0wMaABJgY0AAAGXQQEOHaWpAAAAABJRU5ErkJggg==';
const BLACK =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGklEQVR4AWNkYGD4z4AEmBjQABMDGmBiQAMAQRQBB4xFJUEAAAAASUVORK5CYII=';
const HEAD = 'c'.repeat(40);

interface Request {
  method: string;
  url: string;
  body: any;
}

let server: http.Server;
let requests: Request[];
let apiUrl: string;
let project: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && /\/issues\/\d+\/comments/.test(req.url ?? '')) {
        res.end(JSON.stringify([{ id: 7, body: '<!-- testivai-visual-report -->\n**22 passed** | **0 changed** | **0 new** — **22 total**' }]));
        return;
      }
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-dist-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

function writeSnapshot(dir: string, png: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(png, 'base64'));
  fs.writeFileSync(path.join(dir, 'dom.html'), '<html><body><p>page</p></body></html>');
}

/** Run dist/index.js on a pull_request event in `project`; resolves to its exit code and output. */
function runDist(inputs: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; summary: string }> {
  const eventPath = path.join(project, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 12, head: { sha: HEAD } } }));
  const summaryPath = path.join(project, 'step-summary.md');
  fs.writeFileSync(summaryPath, '');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_API_URL: apiUrl,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'acme/storefront',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '41264760111',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: summaryPath,
    NO_PROXY: '*',
    'INPUT_GITHUB-TOKEN': 'test-token',
    'INPUT_REPORT-DIR': 'visual-report',
    'INPUT_FAIL-ON-DIFF': 'false',
    'INPUT_UPLOAD-ARTIFACT': 'false',
    'INPUT_ARTIFACT-RETENTION-DAYS': '30',
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST], { cwd: project, env });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout, summary: fs.readFileSync(summaryPath, 'utf-8') }),
    );
  });
}

const find = (method: string, pattern: RegExp) => requests.find((r) => r.method === method && pattern.test(r.url));

describe('dist/index.js without results.json', () => {
  it('compares the captures in .testivai/temp/ and posts the report; the step passes', async () => {
    writeSnapshot(path.join(project, '.testivai', 'baselines', 'home'), WHITE);
    writeSnapshot(path.join(project, '.testivai', 'temp', 'home'), WHITE);
    writeSnapshot(path.join(project, '.testivai', 'baselines', 'pricing'), WHITE);
    writeSnapshot(path.join(project, '.testivai', 'temp', 'pricing'), BLACK);

    const { code, stdout, summary } = await runDist();

    expect(code).toBe(0);
    const results = JSON.parse(fs.readFileSync(path.join(project, 'visual-report', 'results.json'), 'utf-8'));
    expect(results.summary).toMatchObject({ total: 2, passed: 1, changed: 1 });
    expect(fs.existsSync(path.join(project, 'visual-report', 'images', 'pricing', 'diff.png'))).toBe(true);
    const comment = find('PATCH', /\/repos\/acme\/storefront\/issues\/comments\/7$/);
    expect(comment?.body.body).toContain('**1 passed** | **1 changed** | **0 new** — **2 total**');
    expect(comment?.body.body).toContain('Compared by the TestivAI action');
    expect(find('POST', /\/check-runs$/)?.body).toMatchObject({ head_sha: HEAD, conclusion: 'neutral' });
    expect(find('POST', new RegExp(`/statuses/${HEAD}$`))?.body).toMatchObject({ state: 'success' });
    expect(summary).toContain('Compared by the TestivAI action');
    expect(stdout).not.toContain('::error::');
  }, 30000);

  it('with no captures: posts "no visual report" to the comment, check, status and summary; the step exits 1', async () => {
    const { code, stdout, summary } = await runDist();

    expect(code).toBe(1);
    const comment = find('PATCH', /\/issues\/comments\/7$/);
    expect(comment?.body.body).toContain('No visual report for this run');
    expect(comment?.body.body).not.toContain('22 passed');
    expect(find('POST', /\/check-runs$/)?.body).toMatchObject({ head_sha: HEAD, conclusion: 'failure', output: { title: 'No visual report for this run' } });
    expect(find('POST', new RegExp(`/statuses/${HEAD}$`))?.body).toMatchObject({ state: 'error', context: 'TestivAI / visual' });
    expect(summary).toContain('No visual report for this run');
    expect(stdout).toContain('::error::No visual report for this run');
  }, 30000);

  it('with results.json: posts it as before, and does not compare again', async () => {
    writeSnapshot(path.join(project, '.testivai', 'baselines', 'home'), WHITE);
    writeSnapshot(path.join(project, '.testivai', 'temp', 'home'), BLACK);
    fs.mkdirSync(path.join(project, 'visual-report'), { recursive: true });
    const results = {
      timestamp: 0,
      summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0 },
      snapshots: [{ name: 'home', status: 'passed', diffPercent: 0 }],
    };
    fs.writeFileSync(path.join(project, 'visual-report', 'results.json'), JSON.stringify(results));

    const { code } = await runDist();

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(project, 'visual-report', 'results.json'), 'utf-8'))).toEqual(results);
    expect(find('PATCH', /\/issues\/comments\/7$/)?.body.body).not.toContain('Compared by the TestivAI action');
    expect(find('POST', /\/check-runs$/)?.body).toMatchObject({ conclusion: 'success' });
  }, 30000);
});
