# Contributing to TestivAI OSS

Thanks for your interest in contributing! This repo is the public home of the TestivAI SDKs.

## Origin

This repository was extracted from the private TestivAI monorepo with a fresh git history. Going forward, **this repo is the source of truth** for:

- `@testivai/witness`
- `@testivai/witness-playwright`
- `@testivai/witness-webdriverio`
- The TestivAI GitHub Action (published at `testivai/testivai-oss@v1`)

## Setup

Requirements:
- Node.js 20+
- pnpm 10+

```bash
pnpm install
pnpm lint
pnpm build
pnpm test
pnpm e2e
```

## Workflow

1. Create a topic branch from `main`
2. Make focused changes (one logical change per PR)
3. **If your change touches a published package, add a changeset** (see below)
4. Run `pnpm lint`, `pnpm build`, `pnpm test`, and `pnpm e2e` locally
5. Open a PR with a clear description and rationale

## Releases — Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing. Releases are PR-driven, not manual.

### When you need a changeset

Add a changeset whenever your PR changes a **published** package's source, types, runtime behavior, or public API:

- Yes: `packages/witness`, `packages/playwright`, `packages/webdriverio`, `packages/selenium`, `packages/mcp`
- No: docs-only, CI-only, `e2e/`, `action/` (these are `ignore`d in the changesets config)

### How to add one

```bash
pnpm changeset
```

The CLI walks you through:
1. Pick which packages your PR affects
2. Pick the bump level for each (`patch` / `minor` / `major`)
3. Write a one-line summary of the change

This creates a markdown file under `.changeset/` like `cool-cats-jump.md`. Commit it with your PR.

#### Bump-level guide

| Type of change | Bump |
|---|---|
| Bug fix; no API surface change | `patch` |
| New optional API; backward compatible | `minor` |
| Removed/renamed export, changed type, behavior break | `major` |

When you bump `@testivai/witness` (the core), the adapter packages (`witness-playwright`, `witness-webdriverio`) automatically receive a `patch` bump because they depend on it via `workspace:*`. You don't need to add a separate changeset for the cascade — it happens during `version-packages`.

### What happens after merge

1. Your PR merges to `main`.
2. The Release workflow opens (or updates) a tracking PR titled **"chore(release): version packages"** that contains the version bumps + per-package CHANGELOG.md entries derived from your changeset.
3. A maintainer reviews + merges the tracking PR.
4. The Release workflow re-runs and publishes the bumped packages to npm with provenance attestations.

A maintainer can also run the workflow manually via the **Actions** tab if needed (escape hatch for hotfixes).

### MCP Registry listing

`@testivai/mcp` is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `ai.testiv/mcp`, from `packages/mcp/server.json`. Registry versions are immutable, so each npm release needs its own listing: when a release publishes `@testivai/mcp`, `release.yml` runs `.github/workflows/mcp-registry.yml`, which publishes `server.json` with `mcp-publisher` and checks the result. `pnpm version-packages` keeps the versions in `server.json` on the `package.json` version, so there is nothing to edit by hand.

To list a version that is on npm but not in the registry (a release from before this workflow, or one whose listing failed), run **MCP Registry** from the Actions tab on `main`. It publishes nothing when the registry already has the version.

One-time setup, by a maintainer:

1. The name `ai.testiv/mcp` needs proof of owning `testiv.ai`: the `testiv.ai` DNS TXT record holds an Ed25519 public key (`v=MCPv1; k=ed25519; p=…`), and the workflow signs in with the matching private key. If that key is lost, make a new pair and replace the TXT record ([registry guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)):

   ```bash
   openssl genpkey -algorithm Ed25519 -out key.pem
   echo "testiv.ai. IN TXT \"v=MCPv1; k=ed25519; p=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)\""
   ```

2. That key can publish any server under `ai.testiv/*`. In **Settings → Environments**, create the environment `mcp-registry-publish`, limit its deployment branches to `main`, and add the private key there as the secret `MCP_PRIVATE_KEY`, not as a repository secret: paste the whole `key.pem` file. Its base64 line alone, or the key's 64 hex characters, work too; `scripts/mcp-registry.js key-hex` turns any of them into the hex `mcp-publisher` takes. A required reviewer on the environment makes each publish wait for approval.

Without the secret, or with a value that is none of those, the workflow fails at the login step and says what is wrong, without printing the value.

## Code Style

- TypeScript everywhere
- Follow the existing module boundaries (`witness` → `playwright` / `webdriverio` / `selenium`)
- Keep runtime dependencies lean; prefer adding shared code to `witness` over duplicating
- New public APIs need:
  - JSDoc on the export
  - A unit test
  - A line in the package README if user-facing

## Reporting Issues

Use [GitHub Issues](https://github.com/testivai/testivai-oss/issues). Include:
- SDK package and version
- Node.js version
- Reproduction steps
- Expected vs. actual behavior

## License

By contributing, you agree your contributions are licensed under the MIT License.
