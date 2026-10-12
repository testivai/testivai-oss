// Dependency-free demo site for proving check.mjs.
//
// Serves the same page under a mode prefix (/ok/, /missing-css/, ...); each
// mode switches exactly one breakage on. The HTML has no static text: all
// visible text comes from app.js, so `blank` really renders 0 characters.
//
//   node demo/site-server.mjs [port]   # prints the base URL
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODES = [
  'ok',
  'missing-css',
  'css-html',
  'css-empty',
  'js-error',
  'blank',
  'font-404',
  'img-404',
  'console-error',
  'down',
  'late-render',
  'css-cross-origin',
  'analytics-ping',
];

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo shop</title>
<link rel="stylesheet" href="style.css">
<script src="app.js" defer></script>
</head>
<body>
<main id="app"></main>
<img id="logo" src="logo.svg" alt="" width="48" height="48">
</body>
</html>
`;

const CSS = `@font-face {
  font-family: "Demo";
  src: url("font.ttf") format("truetype");
}
body { font-family: "Demo", sans-serif; margin: 40px; color: #1d2433; }
h1 { font-size: 32px; }
`;

const ERROR_PAGE = `<!doctype html>
<html><head><title>502 Bad Gateway</title></head>
<body><h1>502 Bad Gateway</h1><p>The upstream server returned an invalid response.</p></body></html>
`;

const RENDER = `document.getElementById('app').innerHTML =
  '<h1>Demo shop</h1>' +
  '<p>Everything you need, delivered fast. Browse the products below.</p>';
`;

const SCRIPTS = {
  // Renders, then dies on a bug a few lines later.
  'js-error': `${RENDER}
const cart = null;
cart.items.length;
`,
  // Waits for data that never arrives, so nothing is ever rendered.
  blank: `// The render call depends on a response that never comes.
window.__waitingForData = true;
`,
  'console-error': `${RENDER}
console.error('Analytics: failed to initialise tracker');
`,
  // Healthy, plus a tracking ping sent as an image request, like Google Analytics.
  'analytics-ping': `${RENDER}
new Image().src = 'collect?v=2&t=pageview';
`,
  // Healthy, but renders only after data that arrives well after "load".
  'late-render': `fetch('data.json')
  .then((response) => response.json())
  .then(() => {
${RENDER.replace(/^/gm, '    ')}  });
`,
};

// How long data.json takes in late-render mode.
const LATE_DATA_MS = 800;

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
<rect width="48" height="48" rx="8" fill="#3b5bdb"/></svg>
`;

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
];

// A real TTF from the system, so the healthy modes load a real web font.
export function findSystemFont() {
  if (process.env.DEMO_FONT_PATH) return process.env.DEMO_FONT_PATH;
  for (const path of FONT_CANDIDATES) if (existsSync(path)) return path;
  const stack = ['/usr/share/fonts'];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.toLowerCase().endsWith('.ttf')) return path;
    }
  }
  throw new Error('No .ttf font found under /usr/share/fonts; set DEMO_FONT_PATH');
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
}

export function createHandler(font = readFileSync(findSystemFont())) {
  return (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    // Browsers ask for this on their own; answer so a healthy page stays clean.
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    const match = path.match(/^\/([a-z0-9-]+)\/([a-z.]*)$/);
    if (!match || !MODES.includes(match[1])) return notFound(res);
    const [, mode, file] = match;

    switch (file) {
      case '':
      case 'index.html':
        if (mode === 'down') {
          // Short, like many host error pages: a render check run on it would fail too.
          return send(res, 503, 'text/html; charset=utf-8', '<h1>503</h1>\n');
        }
        if (mode === 'css-cross-origin') {
          // Healthy, but the stylesheet comes from another origin (localhost vs
          // 127.0.0.1), so the page may not read its rules: a SecurityError.
          const port = new URL(`http://${req.headers.host}`).port;
          return send(res, 200, 'text/html; charset=utf-8', PAGE.replace('href="style.css"', `href="http://localhost:${port}/ok/style.css"`));
        }
        return send(res, 200, 'text/html; charset=utf-8', PAGE);
      case 'style.css':
        if (mode === 'missing-css') return notFound(res);
        if (mode === 'css-html') return send(res, 200, 'text/html; charset=utf-8', ERROR_PAGE);
        // A truncated deploy: right status, right type, no rules.
        if (mode === 'css-empty') return send(res, 200, 'text/css; charset=utf-8', '/* build output missing */\n');
        return send(res, 200, 'text/css; charset=utf-8', CSS);
      case 'app.js':
        return send(res, 200, 'text/javascript; charset=utf-8', SCRIPTS[mode] ?? RENDER);
      case 'font.ttf':
        if (mode === 'font-404') return notFound(res);
        // Fonts need CORS when the stylesheet is on another origin, as on real CDNs.
        return send(res, 200, 'font/ttf', font, { 'access-control-allow-origin': '*' });
      case 'collect':
        // Analytics endpoints answer image pings with 200 and a non-image body.
        if (mode !== 'analytics-ping') return notFound(res);
        return send(res, 200, 'text/html; charset=utf-8', '');
      case 'data.json':
        if (mode !== 'late-render') return notFound(res);
        setTimeout(() => send(res, 200, 'application/json', '{"products":[]}\n'), LATE_DATA_MS);
        return;
      case 'logo.svg':
        if (mode === 'img-404') return notFound(res);
        return send(res, 200, 'image/svg+xml', LOGO);
      default:
        return notFound(res);
    }
  };
}

// Starts the server on 127.0.0.1. Port 0 picks a free port. Host 0.0.0.0
// makes it reachable from other containers (the Docker smoke test).
export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(createHandler());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const base = `http://${host}:${server.address().port}`;
  return {
    base,
    url: (mode) => `${base}/${mode}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = await startServer({ port: Number(process.argv[2] ?? 0), host: process.env.DEMO_HOST || undefined });
  console.log(`Demo site on ${site.base}`);
  for (const mode of MODES) console.log(`  ${site.url(mode)}`);
}
