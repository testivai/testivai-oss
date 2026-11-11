---
title: "Advisory: approve action, snapshot names (2026-10)"
---

# Security advisory: snapshot names could run code in, or escape the baselines of, `testivai/testivai-oss/approve`

This is the text of the GitHub Security Advisory for the fix in
[#179](https://github.com/testivai/testivai-oss/pull/179). Each section below is one
field of the form at **Security → Advisories → New draft security advisory**;
paste them in order. [Fixed in v1.1.0, released 2026-10-16](https://github.com/testivai/testivai-oss/releases/tag/v1.1.0).
Workflows on `@v1` have run the fixed action since then.

## Title

Snapshot names in `testivai/testivai-oss/approve` could run code with the approve token, or copy files from outside `pending-baselines`

## Affected product

| Field | Value |
|---|---|
| Ecosystem | GitHub Actions |
| Package name | `testivai/testivai-oss/approve` |
| Affected versions | `>= 1.0.3, < 1.1.0` |
| Patched versions | `1.1.0` |

The approve action was added on 2026-05-14
([6e7ecf0](https://github.com/testivai/testivai-oss/commit/6e7ecf0)) and first tagged in
v1.0.3; v1.0.0 to v1.0.2 do not contain it. Every tag from v1.0.3 to v1.0.14 is affected,
and so was `@v1` from 2026-05-15, when v1.0.3 was released, until the release workflow
moved it to v1.1.0 on 2026-10-16 at 14:34 UTC. `@main` has had the fix since
[865faf1](https://github.com/testivai/testivai-oss/commit/865faf168965c5d35e77456cc1008a034f9da162)
was merged (2026-10-12 03:48 UTC, 2026-10-11 in US Eastern time).

## Severity

**High: 7.1**, `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:L`

The score is for issue 1 below; issue 2 alone would be Low. Each metric, and why:

| Metric | Value | Reasoning |
|---|---|---|
| Attack Vector | Network | The attacker opens a pull request on GitHub. |
| Attack Complexity | High | The attacker controls the snapshot names, but not every condition the attack needs: their CI run has to run at all (a repository can hold a first-time contributor's workflow run for approval), and its report artifact has to be the one the approve action downloads for the pull request it is asked to approve. The attacker can influence both, not guarantee them. |
| Privileges Required | None | Any GitHub account can fork a public repository and open a pull request. It needs no role in the target repository. |
| User Interaction | Required | Nothing happens until someone with write access comments `/testivai approve --all`, or a bare `/testivai approve`, which meant `--all` in the affected versions. |
| Scope | Unchanged | The injected code runs with the approve job's own token and reaches what that job is allowed to reach. A personal access token that also covers other repositories would take the impact beyond this one, and `S:C` (8.2) would then be defensible. |
| Confidentiality | High | The code holds the token the action was given. For a private repository it can read all the code and download every Actions artifact (`actions: read`); a personal access token stays valid until it is revoked. |
| Integrity | High | With `contents: write` it can push commits to any branch that is not protected, and create or move tags and releases; with `pull-requests: write` it can write and edit comments. Branch protection still applies, and `GITHUB_TOKEN` cannot change files in `.github/workflows/`. |
| Availability | Low | `contents: write` can delete branches, tags and releases that are not protected. The repository itself and its protected branches stay. |

If you rate the attack complexity Low (opening a pull request and waiting for the
comment is easy), the vector is `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:L`, **8.3, High**.
Either way the rating is High.

## Weaknesses

- **CWE-94: Improper Control of Generation of Code ('Code Injection')**, for issue 1:
  untrusted text was placed inside JavaScript source that `actions/github-script` then
  evaluated. CWE-95 (Eval Injection) is the narrower child, if you prefer the most
  specific entry.
- **CWE-22: Improper Limitation of a Pathname to a Restricted Directory ('Path Traversal')**,
  for issue 2.

## Description

### Summary

`testivai/testivai-oss/approve` copies a pull request's pending visual baselines into the
committed baselines when a collaborator with write access comments `/testivai approve`.
The snapshot names it works with come from two places: the comment, and the directory
names in `pending-baselines/` inside the report artifact, which the pull request's own CI
run uploaded. On a pull request from a fork, the fork's author controls that CI run and so
those directory names. Versions 1.0.3 to 1.0.14 trusted those names in two places.

### Issue 1: a snapshot name could run code in the approve job

The step that posts the confirmation comment built its `actions/github-script` source by
placing the approved and skipped names inside single-quoted JavaScript strings with
`${{ steps.apply.outputs.approved }}` and `${{ steps.apply.outputs.skipped }}`. GitHub
expands those expressions as text before the script runs, so a name containing a single
quote ended the string, and whatever followed ran as JavaScript. A directory name such as
`x'+require('child_process').execSync(...)+'` is a valid file name. When someone with
write access commented `/testivai approve --all` (or a bare `/testivai approve`), every
directory name in `pending-baselines/` went into that script, and the code ran on the
runner with the token the action was given.

The fix passes the values through `env:` and reads them from `process.env`, so a name is
only ever data.

### Issue 2: a snapshot name could reach outside `pending-baselines`

The step that applies the approval copied `pending-baselines/<name>` to
`<baselines-dir>/<name>` for any name, without checking it:

- `../x` copied the folder `x` from beside `pending-baselines` (the root of the downloaded
  report) into `.testivai/x` in the checkout. The commit step stages only the baselines
  folder, so that copy stayed on the runner and was not committed.
- `.` copied everything at the top of `pending-baselines`, loose files included, into the
  baselines folder itself, and that was committed.
- `..` copied the whole downloaded report into `.testivai/`.

Names typed in the comment come from someone with write access. Names from the artifact
were listed with `ls`, so they could not contain `/` and did not include `.` or `..`, but
a directory name containing a line break split into separate words, so a hand-built
artifact could still produce `..`. The name loop also left globbing on, so a name such as
`*` expanded against the checkout.

The fix approves a name only when it is a real directory directly inside
`pending-baselines`: never `.`, `..`, a name containing `/`, or a symbolic link. Globbing
is off for the name loop, and `--all` lists directories with `find`. The report is now
downloaded to `$RUNNER_TEMP` instead of `/tmp`.

### Preconditions

All of these must hold:

1. A workflow runs `testivai/testivai-oss/approve` at an affected version on `issue_comment`.
2. The attacker can get a CI run whose report artifact the approve action downloads for the
   pull request it is asked to approve. A pull request from a fork whose CI run is allowed
   to run is the expected way.
3. Someone with write access comments `/testivai approve --all` or a bare
   `/testivai approve` on that pull request. A comment that names snapshots
   (`/testivai approve home about`) does not put the artifact's directory names into the
   script; it puts only the names typed in the comment there.

## Impact

Code chosen by the author of a pull request runs in the approve job with the token passed
to the action (`github-token`, by default the job's `GITHUB_TOKEN`). The documented setup
gives it `contents: write`, `pull-requests: write` and `actions: read`. A workflow with no
`permissions:` block gets the repository's default token permissions, which on older
repositories and organisations is write access to most scopes. The docs also suggest a
fine-grained personal access token or a GitHub App token so CI runs again after an
approve; such a token outlives the job and may reach other repositories.

With that token the code can push to unprotected branches, create or move tags and
releases, comment on and edit pull requests and issues, and, in a private repository,
read the code and download artifacts. It also runs as the runner's user, so anything else
the approve job holds is exposed. The job ends with the confirmation step, but the code
can keep it running, and so keep a `GITHUB_TOKEN` valid, until the job's time limit.

Issue 2 on its own let a comment move files around the runner's checkout and put files
from the top of `pending-baselines` into the baselines folder; given issue 1, it adds
little.

## Who is affected

You are affected if a workflow in your repository uses `testivai/testivai-oss/approve`
at v1.0.3 to v1.0.14, or at a commit SHA from before the fix. You were exposed in the past
if such a workflow ran on `@v1` before 2026-10-16, or on `@main` before 2026-10-12.

To check your workflows, run this from the root of your repository (it needs `git` and
access to github.com):

```bash
FIX=865faf168965c5d35e77456cc1008a034f9da162
USES=$(grep -rhoE "testivai/testivai-oss/approve@[^[:space:]\"'#]+" .github/workflows/ 2>/dev/null | sort -u)
if [ -z "$USES" ]; then
  echo "No workflow here uses testivai/testivai-oss/approve: not affected."
else
  SRC=$(mktemp -d)
  git clone --quiet --filter=blob:none --no-checkout https://github.com/testivai/testivai-oss.git "$SRC"
  for USE in $USES; do
    REF=${USE#*@}
    COMMIT=$(git -C "$SRC" rev-parse --quiet --verify "$REF^{commit}" || git -C "$SRC" rev-parse --quiet --verify "origin/$REF^{commit}")
    if [ -z "$COMMIT" ]; then
      echo "$USE: unknown ref, check it by hand"
    elif git -C "$SRC" merge-base --is-ancestor "$FIX" "$COMMIT"; then
      echo "$USE: includes the fix"
    else
      echo "$USE: AFFECTED, update it"
    fi
  done
  rm -rf "$SRC"
fi
```

Each use prints `includes the fix` or `AFFECTED, update it`. For example, `@v1`,
`@v1.9.0` and `@main` include the fix; `@v1.0.14` and v1.0.14's commit SHA are affected.

To look for past use, open the approve workflow's runs from before you were on a fixed
version. In each run's **Apply baseline approvals** step, the list under
"Available pending baselines:" shows every name it saw. A name containing a quote,
parentheses or `+` is not one TestivAI writes. A **Post confirmation comment** step that
failed with a JavaScript error is worth a look too. Then check for commits, tags or
releases nobody on your team made. If you passed a personal access token or a GitHub App
token, rotate it. A `GITHUB_TOKEN` expires when its job ends. GitHub keeps run logs for 90
days by default.

## Remediation

- **On `@v1`:** nothing to do. `v1` has pointed at v1.1.0 or later since 2026-10-16.
- **Pinned to a tag from v1.0.3 to v1.0.14, or to a commit SHA from before the fix:**
  update to v1.1.0 or later. The latest release is the better target; pin its commit SHA
  if you pin. Releases after v1.1.0 change some behaviour, listed in
  [action/CHANGELOG.md](https://github.com/testivai/testivai-oss/blob/main/action/CHANGELOG.md):
  since v1.1.1 the action uses `actions/github-script@v9` and `actions/checkout@v7`, which
  need Actions Runner v2.327.1 or later on self-hosted runners; since v1.8.0 only the
  comment's first line is read as the command.
- If the check above finds signs of use, also rotate the token the approve job used, and
  review the commits, tags and releases made while you were affected.

## Workarounds

If you cannot update yet:

- Disable the workflow that runs the approve action and approve baselines locally with
  [`npx testivai approve`](../cli/approve.md), then push the commit. This removes the
  exposure.
- Partial: approve only by name (`/testivai approve home about`), never `--all` or a bare
  `/testivai approve`. Names typed in the comment still went into the script, so this
  holds only while nobody with write access types an unusual name.
- Partial: under **Settings → Actions → General**, pick the strictest option for running
  workflows on pull requests from forks (approval for all outside contributors), so a
  fork's CI run cannot produce a report until someone has looked at its changes.

## References

- Fix: [865faf1](https://github.com/testivai/testivai-oss/commit/865faf168965c5d35e77456cc1008a034f9da162), pull request [#179](https://github.com/testivai/testivai-oss/pull/179)
- Release: [v1.1.0](https://github.com/testivai/testivai-oss/releases/tag/v1.1.0)
- Tests that run the action's step scripts against hostile names: [action/src/\_\_tests\_\_/approve-action.test.ts](https://github.com/testivai/testivai-oss/blob/main/action/src/__tests__/approve-action.test.ts)
- [SECURITY.md](https://github.com/testivai/testivai-oss/blob/main/SECURITY.md)

## Credits

Found in an internal review of the approve action, fixed in #179. Edit this if a reporter
should be credited.
