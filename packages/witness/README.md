# @testivai/witness

Framework-agnostic visual regression testing SDK for TestivAI.

## Overview

The TestivAI Witness SDK allows you to integrate visual regression testing into any test framework that can control Chrome/Chromium browsers. It connects to the browser's remote debugging interface and injects a `window.testivaiWitness` function that triggers visual captures.

## Installation

```bash
npm install -D @testivai/witness
```

## Quick Start

TestivAI runs entirely on your machine — no account, no server, nothing uploaded:

1. **Initialize your project**
   ```bash
   npx testivai init
   ```

2. **Add visual captures to your tests**
   ```javascript
   // In your test code
   await window.testivaiWitness('my-snapshot');
   ```

3. **Run your tests**
   ```bash
   # Make sure Chrome is running with remote debugging
   chrome --remote-debugging-port=9222
   
   # Run your tests with TestivAI
   npx testivai run "npm test"
   ```

4. **View the report**
   Open `visual-report/index.html` in your browser to see results.

5. **Approve changes**
   ```bash
   npx testivai approve --all
   ```

## Sharing results with your team

Everything stays on your machine. To get a diff in front of a teammate:

- **In a PR** — the [`testivai/testivai-oss` action](https://github.com/testivai/testivai-oss) posts the summary as a PR comment and uploads the report as a build artifact; its companion `publish@v1` can put each run's report on the repository's [GitHub Pages](https://github.com/testivai/testivai-oss/blob/main/docs/github-action.md#reports-on-github-pages) and link it from the comment. Approve from the PR with a `/testivai approve` comment.
- **As a single file** — `npx testivai report --share` writes `visual-report/share.html` with every image inlined, so it works over chat or email with no server. Set `shareUploadCommand` in `.testivai/config.json` to pipe it to your own storage (S3, GCS, or anything with a CLI).

## Framework Integration

### Cypress

Add this custom command to `cypress/support/commands.js`:

```javascript
// testivai-witness.js
Cypress.Commands.add('witness', (name) => {
  return cy.window().invoke('testivaiWitness', name);
});
```

Use in your tests:

```javascript
it('should capture visual snapshot', () => {
  cy.visit('/my-page');
  cy.witness('my-snapshot');
});
```

Run tests:
```bash
testivai run "cypress run"
```

### Selenium (Python)

```python
from selenium import webdriver

def capture_snapshot(driver, name):
    driver.execute_script(f"return window.testivaiWitness('{name}')")

def test_visual_snapshot():
    driver = webdriver.Chrome()
    driver.get("http://localhost:3000")
    capture_snapshot(driver, "my-snapshot")
```

Run tests:
```bash
testivai run "pytest tests/"
```

### Selenium (JavaScript)

```javascript
const { Builder, By } = require('selenium-webdriver');

async function captureSnapshot(driver, name) {
  await driver.executeScript(`return window.testivaiWitness('${name}')`);
}

it('should capture visual snapshot', async () => {
  const driver = await new Builder().forBrowser('chrome').build();
  await driver.get('http://localhost:3000');
  await captureSnapshot(driver, 'my-snapshot');
});
```

Run tests:
```bash
testivai run "npm test"
```

### WebdriverIO

Add this custom command to your test setup:

```javascript
// In wdio.conf.js or test setup
browser.addCommand('witness', function(name) {
  return this.executeScript('return window.testivaiWitness(arguments[0])', name);
});
```

Use in your tests:

```javascript
it('should capture visual snapshot', async () => {
  await browser.url('/my-page');
  await browser.witness('my-snapshot');
});
```

Run tests:
```bash
testivai run "npx wdio"
```

## How It Works

1. **Browser Connection**: The SDK connects to Chrome's remote debugging interface (usually on port 9222)
2. **Binding Injection**: It injects a native function `window.testivaiWitness` into the browser
3. **Promise Wrapper**: A client-side script wraps the native binding in a Promise for async/await support
4. **Capture Trigger**: When `window.testivaiWitness('name')` is called, it triggers:
   - Screenshot capture
   - Page structure extraction
   - Layout analysis
   - Performance metrics
5. **Compare & report**: Captures are diffed against `.testivai/baselines/` and written to `visual-report/` (HTML + `results.json`)

## Configuration

Create a `testivai.config.ts` file in your project root:

```typescript
import type { WitnessConfig } from '@testivai/witness';

const config: WitnessConfig = {
  // Chrome remote debugging port
  browserPort: 9222,
  
  // Auto-launch Chrome if not running (experimental)
  autoLaunch: false,
  
  // Chrome executable path (for auto-launch)
  // chromePath: '/path/to/chrome',
  
  // Additional Chrome arguments
  chromeArgs: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
  
  // Connection settings
  connectionTimeout: 5000,
  connectionRetries: 3,
};

export default config;
```

## CLI Commands

### `npx testivai init`
Initialize TestivAI in your project. Detects your framework and provides setup instructions.

### `npx testivai run <command>`
Run your test command with automatic visual capture.

```bash
npx testivai run "npm test"
npx testivai run "cypress run"
npx testivai run "pytest tests/"
```

Options:
- `-p, --port <number>` - Specify browser debugging port (default: 9222)

### `npx testivai capture <name>`
Capture a single snapshot without running tests.

```bash
npx testivai capture "my-snapshot" --format json
```

Options:
- `-p, --port <number>` - Specify browser debugging port
- `-o, --output <path>` - Output directory (default: .testivai/captures)
- `-f, --format <format>` - Output format: json|png (default: json)

### `npx testivai approve [name]`
Approve snapshots in local mode. Use after reviewing visual changes.

```bash
npx testivai approve "my-snapshot"     # Approve specific snapshot
npx testivai approve --all           # Approve all changed snapshots
npx testivai approve --undo "name"   # Undo an approval
```

Options:
- `--all` - Approve all changed snapshots
- `--undo` - Undo approval for the specified snapshot

## Chrome Setup

### Manual Launch

Launch Chrome with remote debugging enabled:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

### Common Chrome Arguments

```bash
chrome \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --headless  # For CI environments
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Visual Tests
on: [push, pull_request]

jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Install TestivAI Witness SDK
        run: npm install -g @testivai/witness
        
      - name: Start Chrome
        run: |
          google-chrome \
            --remote-debugging-port=9222 \
            --no-sandbox \
            --disable-dev-shm-usage \
            --headless \
            --disable-gpu &

      - name: Run visual tests
        run: testivai run "npm test"

      - name: Visual diff gate
        run: npx testivai report --fail-on-diff
```

### Jenkins

```groovy
pipeline {
  agent any
  
  stages {
    stage('Setup') {
      steps {
        sh 'npm ci'
        sh 'npm install -g @testivai/witness'
      }
    }
    
    stage('Start Chrome') {
      steps {
        sh '''
          google-chrome \
            --remote-debugging-port=9222 \
            --no-sandbox \
            --disable-dev-shm-usage \
            --headless &
        '''
      }
    }
    
    stage('Visual Tests') {
      steps {
        sh 'testivai run "npm test"'
        sh 'npx testivai report --fail-on-diff'
      }
    }
  }
}
```

## Troubleshooting

### Chrome not found
```
error: Browser debugging endpoint not found
```

**Solution**: Make sure Chrome is running with remote debugging:
```bash
chrome --remote-debugging-port=9222
```

### Connection timeout
```
error: Failed to connect to browser: Connection timeout
```

**Solution**: 
1. Check if Chrome is running
2. Verify the port number (default: 9222)
3. Check for firewall issues

### Tests hang after calling testivaiWitness
**Solution**: The Promise wrapper might not be working. Check browser console for errors and ensure the SDK is properly connected to the browser.

### No snapshots captured
**Solution**: 
1. Verify `window.testivaiWitness` is available in your tests
2. Check that the SDK is connected before running tests
3. Enable verbose logging: `testivai run "npm test" --verbose`

## Performance

- **Package size**: ~270KB (no browser binaries included)
- **Memory usage**: ~50MB additional overhead
- **Capture time**: ~100-500ms per snapshot
- **Compare time**: ~50-200ms per snapshot (pixel + DOM diff)

## API Reference

### BrowserClient
Main class for connecting to the browser.

```typescript
import { BrowserClient } from '@testivai/witness';

const client = new BrowserClient();
await client.connect(9222);
await client.send('Page.navigate', { url: 'https://example.com' });
await client.disconnect();
```

### BrowserCapture
Handles screenshot and data capture.

```typescript
import { BrowserCapture } from '@testivai/witness';

const capture = new BrowserCapture(client);
const snapshot = await capture.captureSnapshot('my-snapshot');
```

### BrowserBinding
Manages the `window.testivaiWitness` binding.

```typescript
import { BrowserBinding } from '@testivai/witness';

const binding = new BrowserBinding(client);
await binding.setupBindings();
const snapshots = binding.getSnapshots();
```

## License

MIT

## Support

- Documentation: https://github.com/testivai/testivai-oss/tree/main/packages/witness
- Issues: https://github.com/testivai/testivai-oss/issues
- Website: https://testiv.ai
