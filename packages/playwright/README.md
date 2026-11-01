# @testivai/witness-playwright

Official Playwright adapter for TestivAI visual regression testing.

## Installation

```bash
npm install -D @testivai/witness-playwright
```

## Quick Start (Local Mode — Free)

1. **Initialize your project**
   ```bash
   npx testivai init
   # Select "Local Mode" when prompted
   ```

2. **Add the reporter to your Playwright config**
   ```typescript
   // playwright.config.ts
   import { defineConfig } from '@playwright/test';

   export default defineConfig({
     reporter: [
       ['line'],
       ['@testivai/witness-playwright/reporter', {
       }]
     ],
   });
   ```

3. **Capture snapshots in your tests**
   ```typescript
   import { test, expect } from '@playwright/test';
   import { witness } from '@testivai/witness-playwright';

   test('homepage visual', async ({ page }, testInfo) => {
     await page.goto('https://example.com');
     await witness(page, testInfo, 'homepage');
   });
   ```

4. **Run your tests**
   ```bash
   npx playwright test
   ```

5. **View the report**
   Open `visual-report/index.html` in your browser.

6. **Approve changes**
   ```bash
   npx testivai approve --all
   ```

## Configuration

No configuration needed — `npx testivai init` scaffolds `.testivai/config.json`,
the baselines directory, and the `.gitignore` entries. Everything runs locally.

## API Reference

### `witness(page, testInfo, name?, config?)`

Capture a visual snapshot of the current page.

```typescript
import { witness } from '@testivai/witness-playwright';

// Basic usage
await witness(page, testInfo, 'my-snapshot');

// With per-snapshot overrides
await witness(page, testInfo, 'checkout-page', {
  ignoreSelectors: ['.live-chat', '[data-testid=clock]'], // hidden for this capture
  stabilize: false, // opt out of animation-freeze + font-wait for this snapshot
});

// Diff tolerances (maxDiffPercent, noiseAutoPass, ...) are project-level:
// set them in .testivai/config.json — see the repository README.
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Visual Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npx playwright install chromium
      - run: npx playwright test
      # After a failing test too: the reporter writes the report whatever
      # the tests did, and the action posts it.
      - uses: testivai/testivai-oss@v1
        if: ${{ !cancelled() }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          report-dir: visual-report
```

## License

MIT

## Support

- Documentation: https://github.com/testivai/testivai-oss/tree/main/packages/playwright
- Issues: https://github.com/testivai/testivai-oss/issues
- Website: https://testiv.ai
