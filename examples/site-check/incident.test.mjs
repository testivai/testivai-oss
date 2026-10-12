import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL, octokitClient, syncIncident } from './incident.mjs';

// In-memory issue tracker behind the four-method client interface.
function fakeClient() {
  const issues = [];
  const calls = [];
  return {
    issues,
    calls,
    async findOpenIssue(label) {
      calls.push(['findOpenIssue', label]);
      return issues.find((i) => i.state === 'open' && i.labels.includes(label)) ?? null;
    },
    async createIssue({ title, body, labels, assignees }) {
      calls.push(['createIssue', { title, body, labels, assignees }]);
      const issue = { number: issues.length + 1, title, body, labels, assignees, state: 'open', comments: [] };
      issues.push(issue);
      return issue;
    },
    async comment(number, body) {
      calls.push(['comment', number, body]);
      issues.find((i) => i.number === number).comments.push(body);
    },
    async closeIssue(number) {
      calls.push(['closeIssue', number]);
      issues.find((i) => i.number === number).state = 'closed';
    },
  };
}

const fail = (client, extra = {}) =>
  syncIncident({ client, failed: true, title: 'Site check failing', body: 'Run 1 failed', assignees: [], ...extra });
const pass = (client, extra = {}) =>
  syncIncident({ client, failed: false, title: 'Site check failing', body: 'Run 2 passed', assignees: [], ...extra });

test('the label is site-check', () => {
  assert.equal(LABEL, 'site-check');
});

test('first failure opens one issue labelled site-check', async () => {
  const client = fakeClient();
  const result = await fail(client, { title: 'Site down', body: 'details', assignees: ['octocat'] });
  assert.deepEqual(result, { action: 'opened', issue: 1 });
  assert.equal(client.issues.length, 1);
  assert.deepEqual(client.issues[0].labels, ['site-check']);
  assert.equal(client.issues[0].title, 'Site down');
  assert.equal(client.issues[0].body, 'details');
  assert.deepEqual(client.issues[0].assignees, ['octocat']);
  assert.equal(client.issues[0].state, 'open');
});

test('a failure while an issue is open only comments', async () => {
  const client = fakeClient();
  await fail(client);
  const result = await fail(client, { body: 'Run 2 failed' });
  assert.deepEqual(result, { action: 'still-open', issue: 1 });
  assert.equal(client.issues.length, 1, 'a second issue was opened');
  assert.deepEqual(client.issues[0].comments, ['Run 2 failed']);
  assert.equal(client.calls.filter(([name]) => name === 'createIssue').length, 1);
});

test('a day of hourly failures never opens a second issue', async () => {
  const client = fakeClient();
  const actions = [];
  for (let hour = 0; hour < 24; hour++) actions.push((await fail(client, { body: `hour ${hour}` })).action);
  assert.equal(actions[0], 'opened');
  assert.ok(actions.slice(1).every((a) => a === 'still-open'), actions.join(','));
  assert.equal(client.issues.length, 1, 'a second issue was opened');
  assert.equal(client.calls.filter(([name]) => name === 'createIssue').length, 1);
  assert.equal(client.issues[0].comments.length, 23);
});

test('the first success comments "Recovered" and closes the issue', async () => {
  const client = fakeClient();
  await fail(client);
  const result = await pass(client, { body: 'All pages healthy' });
  assert.deepEqual(result, { action: 'closed', issue: 1 });
  assert.equal(client.issues[0].state, 'closed');
  assert.equal(client.issues[0].comments.length, 1);
  assert.match(client.issues[0].comments[0], /^Recovered/);
  assert.match(client.issues[0].comments[0], /All pages healthy/);
  const order = client.calls.map(([name]) => name).filter((n) => n === 'comment' || n === 'closeIssue');
  assert.deepEqual(order, ['comment', 'closeIssue'], 'must comment before closing');
});

test('success with nothing open does nothing', async () => {
  const client = fakeClient();
  const result = await pass(client);
  assert.deepEqual(result, { action: 'none', issue: null });
  assert.deepEqual(client.calls, [['findOpenIssue', 'site-check']]);
});

test('a second success after recovery does nothing', async () => {
  const client = fakeClient();
  await fail(client);
  await pass(client);
  const result = await pass(client);
  assert.deepEqual(result, { action: 'none', issue: null });
  assert.equal(client.issues[0].comments.length, 1);
});

test('a new outage after recovery opens a new issue, never two open at once', async () => {
  const client = fakeClient();
  const actions = [];
  for (const failed of [true, true, false, false, true, true, false]) {
    actions.push((await syncIncident({ client, failed, title: 't', body: 'b', assignees: [] })).action);
    assert.ok(client.issues.filter((i) => i.state === 'open').length <= 1, 'two issues open at once');
  }
  assert.deepEqual(actions, ['opened', 'still-open', 'closed', 'none', 'opened', 'still-open', 'closed']);
  assert.equal(client.issues.length, 2);
});

test('assignees default to none', async () => {
  const client = fakeClient();
  await syncIncident({ client, failed: true, title: 't', body: 'b' });
  assert.deepEqual(client.issues[0].assignees, []);
});

test('client errors are not swallowed', async () => {
  const client = fakeClient();
  client.createIssue = async () => {
    throw new Error('API down');
  };
  await assert.rejects(fail(client), /API down/);
});

// --- octokitClient -------------------------------------------------------

const context = { repo: { owner: 'acme', repo: 'shop' } };

function httpError(status, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

// Fake of the github-script `github` object, simulating the issues REST API.
function fakeGithub({ labelExists = false, dropLabels = false } = {}) {
  const issues = [];
  const calls = [];
  let labelPresent = labelExists;
  const github = {
    rest: {
      issues: {
        async listForRepo(params) {
          calls.push(['listForRepo', params]);
          const data = issues
            .filter((i) => (params.state === 'open' ? i.state === 'open' : true))
            .filter((i) => !params.labels || i.labels.some((l) => l.name === params.labels));
          return { data };
        },
        async createLabel(params) {
          calls.push(['createLabel', params]);
          if (labelPresent) throw httpError(422, 'Validation Failed: already_exists');
          labelPresent = true;
          return { data: { name: params.name } };
        },
        async create(params) {
          calls.push(['create', params]);
          const labels = dropLabels ? [] : (params.labels ?? []).map((name) => ({ name }));
          const issue = { number: 100 + issues.length, title: params.title, body: params.body, labels, state: 'open' };
          issues.push(issue);
          return { data: issue };
        },
        async createComment(params) {
          calls.push(['createComment', params]);
          return { data: { id: 1 } };
        },
        async update(params) {
          calls.push(['update', params]);
          const issue = issues.find((i) => i.number === params.issue_number);
          if (params.state) issue.state = params.state;
          return { data: issue };
        },
      },
    },
  };
  return { github, issues, calls };
}

test('octokitClient.findOpenIssue lists open issues with the label and skips pull requests', async () => {
  const { github, issues, calls } = fakeGithub();
  issues.push({ number: 7, labels: [{ name: 'site-check' }], state: 'open', pull_request: { url: 'x' } });
  issues.push({ number: 8, labels: [{ name: 'site-check' }], state: 'open' });
  const client = octokitClient(github, context);
  const found = await client.findOpenIssue('site-check');
  assert.equal(found.number, 8);
  const [, params] = calls.find(([name]) => name === 'listForRepo');
  assert.equal(params.owner, 'acme');
  assert.equal(params.repo, 'shop');
  assert.equal(params.state, 'open');
  assert.equal(params.labels, 'site-check');
});

test('octokitClient.findOpenIssue returns null when nothing is open', async () => {
  const { github } = fakeGithub();
  assert.equal(await octokitClient(github, context).findOpenIssue('site-check'), null);
});

test('octokitClient.createIssue creates the label when missing, then the issue', async () => {
  const { github, calls } = fakeGithub({ labelExists: false });
  const issue = await octokitClient(github, context).createIssue({
    title: 'Down',
    body: 'b',
    labels: ['site-check'],
    assignees: ['octocat'],
  });
  assert.equal(issue.number, 100);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['createLabel', 'create'],
  );
  const [, params] = calls[1];
  assert.deepEqual(
    { owner: params.owner, repo: params.repo, title: params.title, body: params.body, labels: params.labels, assignees: params.assignees },
    { owner: 'acme', repo: 'shop', title: 'Down', body: 'b', labels: ['site-check'], assignees: ['octocat'] },
  );
});

test('octokitClient.createIssue treats "label already exists" (422) as fine', async () => {
  const { github, issues } = fakeGithub({ labelExists: true });
  await octokitClient(github, context).createIssue({ title: 't', body: 'b', labels: ['site-check'], assignees: [] });
  assert.equal(issues.length, 1);
});

test('octokitClient.createIssue omits empty assignees', async () => {
  const { github, calls } = fakeGithub();
  await octokitClient(github, context).createIssue({ title: 't', body: 'b', labels: ['site-check'], assignees: [] });
  const [, params] = calls.find(([name]) => name === 'create');
  assert.equal('assignees' in params, false);
});

test('octokitClient.createIssue rethrows label errors other than 422', async () => {
  const { github, issues } = fakeGithub();
  github.rest.issues.createLabel = async () => {
    throw httpError(403, 'Resource not accessible by integration');
  };
  await assert.rejects(
    octokitClient(github, context).createIssue({ title: 't', body: 'b', labels: ['site-check'], assignees: [] }),
    /not accessible/,
  );
  assert.equal(issues.length, 0);
});

test('octokitClient.createIssue fails loudly if GitHub dropped the label', async () => {
  // Without the label the next run would not find the issue and open another.
  const { github } = fakeGithub({ dropLabels: true });
  await assert.rejects(
    octokitClient(github, context).createIssue({ title: 't', body: 'b', labels: ['site-check'], assignees: [] }),
    /label/,
  );
});

test('octokitClient.comment and closeIssue call createComment and update', async () => {
  const { github, issues, calls } = fakeGithub();
  issues.push({ number: 5, labels: [{ name: 'site-check' }], state: 'open' });
  const client = octokitClient(github, context);
  await client.comment(5, 'hello');
  await client.closeIssue(5);
  assert.deepEqual(calls[0], ['createComment', { owner: 'acme', repo: 'shop', issue_number: 5, body: 'hello' }]);
  assert.deepEqual(calls[1], [
    'update',
    { owner: 'acme', repo: 'shop', issue_number: 5, state: 'closed', state_reason: 'completed' },
  ]);
  assert.equal(issues[0].state, 'closed');
});

test('syncIncident over octokitClient: a day of failures then recovery opens exactly one issue', async () => {
  const { github, issues, calls } = fakeGithub();
  const client = octokitClient(github, context);
  for (let hour = 0; hour < 24; hour++) {
    await syncIncident({ client, failed: true, title: 'Site check failing', body: `hour ${hour}`, assignees: [] });
  }
  const result = await syncIncident({ client, failed: false, title: 'Site check failing', body: 'ok', assignees: [] });
  assert.equal(result.action, 'closed');
  assert.equal(calls.filter(([name]) => name === 'create').length, 1, 'a second issue was opened');
  assert.equal(calls.filter(([name]) => name === 'createComment').length, 24);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].state, 'closed');
});
