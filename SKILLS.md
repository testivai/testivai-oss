# testivai-oss — Skill Recipes

Step-by-step procedures for the most common tasks in this repo.
Each skill is self-contained — read only the one you need.

---

## Skill: Add a visual snapshot test (Playwright)

**When:** Adding a new page or component that needs visual regression coverage.

```ts
// tests/my-page.spec.ts
import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test('my page looks correct', async ({ page }, testInfo) => {
  await page.goto('http://localhost:3000/my-page');
  // Optional: wait for animations, lazy images, etc.
  await page.waitForLoadState('networkidle');
  await witness(page, testInfo, 'my-page');
});
```

**First run** — baselines are written to `.testivai/baselines/my-page/`.
Commit them: `git add .testivai/baselines/my-page/`.

**Later runs** — screenshots are diffed against the baseline.
A report is written to `visual-report/index.html`.

---

## Skill: Add a changeset

**When:** Any PR that changes the public API, fixes a bug, or adds a feature in a package.

```bash
pnpm changeset
```

1. Select the affected package(s) with spacebar
2. Choose bump type: `patch` (bug fix) · `minor` (new feature) · `major` (breaking)
3. Write a short description — this becomes the CHANGELOG entry
4. Commit the generated `.changeset/<random-name>.md` with your PR

Do **not** run this for changes to `action/`, `approve/`, `docs/`, or `examples/`.

---

## Skill: Change the GitHub Action reporter

**When:** Modifying `action/src/` (comment format, artifact bundling, image upload, etc.)

```bash
cd action
npm install          # if deps changed
# ... make your changes to src/ ...
npm run build        # rebuilds dist/index.js via ncc
cd ..
git add action/dist/index.js action/src/
git commit -m "feat(action): ..."
```

Then push a new semver tag to roll `v1`:

```bash
# Find current latest action tag
git tag --list 'v*' --sort=-version:refname | head -3

# Bump patch (e.g. v1.0.3 → v1.0.4)
git tag v1.0.4
git push origin v1.0.4
# CI automatically rolls the v1 major tag
```

**Never** edit `action/dist/index.js` by hand — always rebuild via `npm run build`.

---

## Skill: Change the approve composite action

**When:** Modifying `approve/action.yml` (permission check, baseline copy logic, comment text, etc.)

```bash
# Edit approve/action.yml directly — no build step needed
git add approve/action.yml
git commit -m "fix(approve): ..."

# Push a new semver tag to ship the change at v1
git tag v1.0.4
git push origin v1.0.4
```

The composite action ships as-is. CI rolls `v1` to the new tag automatically.

---

## Skill: Add a new framework adapter

**When:** Supporting a new test framework (e.g. `@testivai/witness-cypress`).

1. **Scaffold the package**
   ```bash
   mkdir packages/cypress
   cd packages/cypress
   # Copy structure from packages/webdriverio as a starting point
   ```

2. **Minimum required files**
   ```
   packages/cypress/
     package.json          name: "@testivai/witness-cypress", version: "0.1.0"
     tsconfig.json         extends ../../tsconfig.base.json
     src/
       index.ts            public entry point
       service.ts          framework hook integration
     src/__tests__/
       *.test.ts           unit tests
     CHANGELOG.md          empty initial changelog
     README.md             usage instructions
   ```

3. **Wire it into the workspace**
   ```bash
   # pnpm-workspace.yaml already picks up packages/* automatically
   pnpm install
   pnpm build
   pnpm test
   ```

4. **Add a changeset for the initial publish**
   ```bash
   pnpm changeset
   # Select @testivai/witness-cypress → patch → "Initial release"
   ```

5. **Open a PR** — CI will publish it on merge of the version PR.

---

## Skill: Approve baselines locally

**When:** You have run tests locally and want to promote `temp/` screenshots to `baselines/`
without going through the PR comment flow.

```bash
# Option A — using the testivai CLI
npx testivai approve --all           # approve all changed snapshots
npx testivai approve homepage        # approve one named snapshot

# Option B — using the BaselineStore API directly
node -e "
  const { BaselineStore } = require('./packages/witness/dist/baselines/store');
  const s = new BaselineStore(process.cwd());
  s.listTemp().forEach(n => { s.approve(n); console.log('approved:', n); });
"

# Then commit the updated baselines
git add .testivai/baselines/
git commit -m "chore(baselines): approve visual snapshots"
```

---

## Skill: Approve baselines via PR comment

**When:** CI has run and posted a diff report on your PR. You've reviewed the report
and want to approve specific (or all) changed snapshots.

Post a comment on the PR:

```
/testivai approve homepage        ← approves one snapshot
/testivai approve --all           ← approves all changed snapshots
```

**What happens:**
1. The `testivai/testivai-oss/approve@v1` action verifies you have write access
2. Downloads the `testivai-visual-report` artifact from the latest CI run
3. Copies approved screenshots into `.testivai/baselines/`
4. Commits them to your PR branch
5. Posts a confirmation comment; CI re-runs automatically

**Requires:** the workflow has `contents: write` permission and the `approve-baselines` job.

---

## Skill: Debug a visual regression failure

**When:** A snapshot is showing as `changed` but you're not sure why.

1. **Open the HTML report**
   ```bash
   open visual-report/index.html
   ```
   Check the three-panel view: baseline / current / diff overlay.

2. **Check the DOM diff hint**
   In `visual-report/results.json`, look at the snapshot's `dom` field:
   ```json
   "dom": { "changed": false, "noiseHint": true }
   ```
   - `noiseHint: true` + `changed: false` → DOM is identical, diff is render noise
     (font hinting, anti-aliasing, sub-pixel rendering). Safe to approve.
   - `changed: true` → real DOM change. Check `dom.summary` for what added/removed.

3. **Raise the threshold** if the diff is render noise across many snapshots:
   ```json
   // .testivai/config.json
   { "threshold": 0.2 }   // default is 0.1 (0–100 scale)
   ```

4. **Isolate the snapshot** for faster iteration:
   ```bash
   npx playwright test --grep "homepage"
   ```

---

## Skill: Cut a release (full flow)

**When:** Merging features that need to be published to npm.

```
1. Contributor opens PR with changeset file included
2. PR merges to main
3. CI opens "Version Packages" PR automatically (or you create it manually)
4. Review the version bumps and CHANGELOG entries in that PR
5. Merge the Version PR
6. CI runs pnpm release → publishes to npm with provenance
7. CI creates GitHub Releases for each published package
```

**Manual publish** (emergency / local):
```bash
git checkout main && git pull
pnpm build
npm whoami          # confirm logged in to npm
pnpm release        # runs changeset publish
```

**After publishing:** if `action/src/` changed in this release cycle, push a semver tag
to roll `v1` (see the "Change the GitHub Action reporter" skill).

---

## Skill: Run full verification before opening a PR

```bash
pnpm install          # ensure deps are in sync
pnpm build            # compile all packages
pnpm test             # run all unit tests
pnpm e2e              # run smoke E2E
pnpm pack:dry         # validate publish artifacts (catches missing files in package.json)

# If action/src/ changed:
cd action && npm run build && cd ..
git diff --stat action/dist/index.js   # should show changes if src changed
```

All four must pass before the PR is opened. CI enforces the same checks.

---

## Skill: Update the `.testivai/config.json` defaults

**When:** Changing default threshold, report directory, or adding a new config field.

Key file: `packages/witness/src/config/local-config.ts` (the `LocalConfig` type and defaults).

After changing defaults:
- Update the `results.json` schema comment in `AGENTS.md` and `CLAUDE.md` if the shape changes
- Add a changeset for `@testivai/witness` at the appropriate bump level
- Update `docs/` if the field is user-facing

---

## Skill: Add a new field to `results.json`

**When:** Adding new diff data (e.g. a new comparison layer) to the report output.

1. Update the generator: `packages/witness/src/report/generator.ts`
2. Update the TypeScript types: `packages/witness/src/report/types.ts`
3. Update the action reader if it reads the new field: `action/src/types.ts`, `action/src/index.ts`
4. Update the schema docs in `AGENTS.md` and `CLAUDE.md`
5. Add a **minor** changeset for `@testivai/witness` (new field = additive = minor)
6. If the action reads it, rebuild `action/dist/index.js` and push a semver tag
