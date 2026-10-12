// One GitHub issue per outage, so an hourly check that stays broken does not
// send 24 emails a day: open on the first failure, comment while it stays
// broken, comment "Recovered" and close on the first success.

export const LABEL = 'site-check';

// client: { findOpenIssue(label), createIssue({ title, body, labels, assignees }),
//           comment(number, body), closeIssue(number) }
// Returns { action: 'opened' | 'still-open' | 'closed' | 'none', issue: number | null }.
export async function syncIncident({ client, failed, title, body, assignees = [] }) {
  const open = await client.findOpenIssue(LABEL);

  if (failed) {
    if (open) {
      await client.comment(open.number, body);
      return { action: 'still-open', issue: open.number };
    }
    const created = await client.createIssue({ title, body, labels: [LABEL], assignees });
    return { action: 'opened', issue: created.number };
  }

  if (open) {
    await client.comment(open.number, `Recovered: the site check passes again.\n\n${body}`);
    await client.closeIssue(open.number);
    return { action: 'closed', issue: open.number };
  }
  return { action: 'none', issue: null };
}

// Adapts the `github` and `context` objects that actions/github-script provides.
export function octokitClient(github, context) {
  const { owner, repo } = context.repo;
  const issues = github.rest.issues;

  return {
    async findOpenIssue(label) {
      const { data } = await issues.listForRepo({
        owner,
        repo,
        state: 'open',
        labels: label,
        sort: 'created',
        direction: 'asc',
        per_page: 100,
      });
      // The issues API also returns pull requests; they are not incidents.
      return data.find((issue) => !issue.pull_request) ?? null;
    },

    async createIssue({ title, body, labels, assignees = [] }) {
      for (const name of labels) await ensureLabel(name);
      const params = { owner, repo, title, body, labels };
      if (assignees.length) params.assignees = assignees;
      const { data } = await issues.create(params);
      // If GitHub dropped the label, the next run would not find this issue
      // and would open another one every hour. Fail loudly instead.
      const got = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
      const missing = labels.filter((name) => !got.includes(name));
      if (missing.length) {
        throw new Error(
          `Issue #${data.number} was created without the label(s) ${missing.join(', ')}; ` +
            'the next run could not find it. Check that the workflow has "issues: write".',
        );
      }
      return data;
    },

    async comment(number, body) {
      await issues.createComment({ owner, repo, issue_number: number, body });
    },

    async closeIssue(number) {
      await issues.update({ owner, repo, issue_number: number, state: 'closed', state_reason: 'completed' });
    },
  };

  async function ensureLabel(name) {
    try {
      await issues.createLabel({ owner, repo, name, color: 'd73a4a', description: 'Opened by the site check workflow' });
    } catch (error) {
      if (error.status !== 422) throw error; // 422: the label already exists
    }
  }
}
