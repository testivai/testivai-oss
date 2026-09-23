/**
 * TestivAI Report — HTML Template
 *
 * Single-file HTML with inlined CSS/JS. Light theme by default with a
 * persisted dark-mode toggle (CSS custom properties). Sidebar + summary
 * cards, Changed → New → Passed sections, a per-snapshot "Layered analysis"
 * panel (verdict + DOM/style signal + attributed regions + page-shift +
 * masks — the same evidence agents get via @testivai/mcp explain_snapshot),
 * 3-column diff view, approve command copy button, image zoom overlay.
 */

import type { ReportData, SnapshotResult } from './results';

/**
 * Render a standalone HTML report from report data.
 */
export function renderHtml(data: ReportData): string {
  const { summary, snapshots, version, timestamp } = data;

  const changed = snapshots.filter((s) => s.status === 'changed');
  const newSnapshots = snapshots.filter((s) => s.status === 'new');
  const passed = snapshots.filter((s) => s.status === 'passed');
  const missing = data.missingBaselines ?? [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TestivAI Visual Report</title>
  <style>
    /* ── Theme tokens ─────────────────────────────────────────────────────
       Light is the default (no attribute); html[data-theme="dark"] overrides.
       The toggle persists to localStorage("testivai-theme"). */
    :root {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface-2: #eef1f4;
      --border: #d0d7de;
      --border-soft: #e4e8ec;
      --text: #1f2328;
      --text-muted: #59636e;
      --accent: #0e7490;
      --accent-contrast: #ffffff;
      --link: #0969da;
      --changed: #cf222e;      --changed-bg: #cf222e14;
      --new: #bc4c00;          --new-bg: #bc4c0014;
      --passed: #1a7f37;       --passed-bg: #1a7f3714;
      --info: #0969da;         --info-bg: #0969da12;
      --code-bg: #eff2f5;
      --shadow: 0 1px 3px rgba(31,35,40,0.06), 0 8px 24px rgba(31,35,40,0.04);
      --sidebar-bg: #ffffff;
      --hatch-a: #eef1f4; --hatch-b: #e4e8ec;
    }
    html[data-theme="dark"] {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-2: #1c2129;
      --border: #30363d;
      --border-soft: #21262d;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --accent: #00d4ff;
      --accent-contrast: #08111f;
      --link: #58a6ff;
      --changed: #f85149;      --changed-bg: #f8514922;
      --new: #f0883e;          --new-bg: #f0883e22;
      --passed: #3fb950;       --passed-bg: #3fb95022;
      --info: #79c0ff;         --info-bg: #1f6feb1a;
      --code-bg: #0d1117;
      --shadow: none;
      --sidebar-bg: #08111f;
      --hatch-a: #161b22; --hatch-b: #1c2129;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); display: flex; min-height: 100vh; }
    code, .mono { font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace; }

    /* Mobile top bar (hidden on desktop) */
    .mobile-topbar { display: none; position: sticky; top: 0; z-index: 50; align-items: center; gap: 12px; padding: 10px 14px; background: var(--sidebar-bg); border-bottom: 1px solid var(--border-soft); }
    .menu-toggle { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 12px; font-size: 16px; line-height: 1; cursor: pointer; }
    .topbar-title { font-size: 15px; font-weight: 700; color: var(--accent); }
    .topbar-title span { font-weight: 400; font-size: 12px; color: var(--text-muted); }
    .sidebar-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 55; }

    /* Sidebar */
    .sidebar { width: 264px; background: var(--sidebar-bg); padding: 24px 16px; flex-shrink: 0; border-right: 1px solid var(--border-soft); position: fixed; top: 0; height: 100vh; height: 100dvh; overflow-y: auto; display: flex; flex-direction: column; }
    .brand-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .sidebar h1 { font-size: 18px; color: var(--accent); letter-spacing: -0.2px; }
    .theme-toggle { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: all .15s; }
    .theme-toggle:hover { border-color: var(--accent); }
    .sidebar .version { font-size: 12px; color: var(--text-muted); margin-bottom: 2px; }
    .sidebar .timestamp { font-size: 11px; color: var(--text-muted); margin-bottom: 20px; }

    /* Summary cards */
    .summary-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 20px; }
    .card { padding: 12px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-soft); box-shadow: var(--shadow); }
    .card .label { font-size: 10px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.6px; }
    .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
    .card.total .value { color: var(--text); }
    .card.changed .value { color: var(--changed); }
    .card.new .value { color: var(--new); }
    .card.passed .value { color: var(--passed); }

    /* Nav */
    .nav { list-style: none; margin-bottom: 20px; }
    .nav li { margin-bottom: 2px; }
    .nav a { display: block; padding: 8px 12px; border-radius: 8px; color: var(--text-muted); text-decoration: none; font-size: 13px; transition: all 0.15s; }
    .nav a:hover { background: var(--surface-2); color: var(--text); }
    .nav a .count { float: right; background: var(--surface-2); border: 1px solid var(--border-soft); padding: 1px 8px; border-radius: 10px; font-size: 11px; }

    /* Agent CTA */
    .cta { background: var(--surface); border: 1px solid var(--border-soft); padding: 14px; border-radius: 10px; box-shadow: var(--shadow); }
    .cta h3 { font-size: 13px; color: var(--text); margin-bottom: 6px; }
    .cta p { font-size: 11px; color: var(--text-muted); line-height: 1.55; }
    .cta code { background: var(--code-bg); border-radius: 4px; padding: 1px 4px; font-size: 10px; }
    .cta a { display: inline-block; margin-top: 8px; padding: 6px 14px; background: var(--accent); color: var(--accent-contrast); border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: 600; }

    /* Main content */
    .main { margin-left: 264px; flex: 1; padding: 32px 36px; max-width: 1280px; }
    .section { margin-bottom: 44px; }
    .section-title { font-size: 18px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
    .section-title::before { content: ''; width: 8px; height: 8px; border-radius: 50%; }
    .section-title.changed { color: var(--changed); } .section-title.changed::before { background: var(--changed); }
    .section-title.new { color: var(--new); } .section-title.new::before { background: var(--new); }
    .section-title.passed { color: var(--passed); } .section-title.passed::before { background: var(--passed); }

    /* Snapshot card */
    .snapshot { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 14px; padding: 20px; margin-bottom: 16px; box-shadow: var(--shadow); }
    .snapshot-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .snapshot-name { font-size: 15px; font-weight: 650; }
    .snapshot-badge { padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: capitalize; }
    .badge-changed { background: var(--changed-bg); color: var(--changed); }
    .badge-new { background: var(--new-bg); color: var(--new); }
    .badge-passed { background: var(--passed-bg); color: var(--passed); }
    .snapshot-stats { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }

    /* Layered analysis panel — the same evidence agents get via MCP */
    .analysis { border: 1px solid var(--border-soft); background: var(--surface-2); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
    .analysis-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .analysis-title { font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--text-muted); }
    .analysis-mcp { font-size: 10px; color: var(--text-muted); }
    .analysis-mcp code { background: var(--code-bg); border-radius: 3px; padding: 1px 4px; }
    .verdict { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; font-weight: 550; margin-bottom: 8px; }
    .verdict.v-noise { background: var(--info-bg); color: var(--info); border: 1px solid var(--info); border-color: color-mix(in srgb, var(--info) 30%, transparent); }
    .verdict.v-style { background: var(--new-bg); color: var(--new); border: 1px solid color-mix(in srgb, var(--new) 30%, transparent); }
    .verdict.v-structural { background: var(--changed-bg); color: var(--changed); border: 1px solid color-mix(in srgb, var(--changed) 30%, transparent); }
    .verdict.v-shift { background: var(--info-bg); color: var(--info); border: 1px solid color-mix(in srgb, var(--info) 30%, transparent); }
    .verdict.v-new { background: var(--new-bg); color: var(--new); border: 1px solid color-mix(in srgb, var(--new) 30%, transparent); }
    .verdict.v-pass { background: var(--passed-bg); color: var(--passed); border: 1px solid color-mix(in srgb, var(--passed) 30%, transparent); }
    .verdict code { background: var(--code-bg); border-radius: 3px; padding: 1px 4px; font-size: 12px; }

    /* DOM noise hint */
    .dom-hint { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 9px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
    .dom-hint.noise { background: var(--info-bg); color: var(--info); }
    .dom-hint.changed { background: var(--surface); border: 1px solid var(--border-soft); color: var(--text); }
    .dom-hint.style-changed { background: var(--new-bg); color: var(--new); }
    .dom-hint.style-changed code { background: var(--code-bg); border-radius: 3px; padding: 1px 4px; font-size: 11px; }
    .dom-hint .label { font-weight: 600; }
    .dom-hint .summary { color: inherit; opacity: 0.85; }

    /* 3-column diff view */
    .diff-view { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .diff-view.two-col { grid-template-columns: 1fr 1fr; }
    .diff-view.one-col { grid-template-columns: 1fr; }
    .diff-col { text-align: center; }
    .diff-col label { display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
    .heat-legend { text-transform: none; letter-spacing: 0; font-size: 10px; margin-left: 6px; }
    .heat-bar { display: inline-block; width: 44px; height: 7px; border-radius: 4px; vertical-align: middle; margin: 0 3px; background: linear-gradient(90deg, #ffeb3b, #ff9800, #d32f2f); }
    .diff-col img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); cursor: zoom-in; transition: transform 0.2s; background: #fff; }
    .diff-col img:hover { transform: scale(1.02); }

    /* Approve command */
    .approve-cmd { margin-top: 16px; background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .approve-cmd code { font-size: 13px; color: var(--accent); }
    .approve-cmd button { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
    .approve-cmd button:hover { border-color: var(--accent); }
    .approve-cmd button.copied { background: var(--passed); border-color: var(--passed); color: #fff; }

    /* Regions */
    .regions { margin-top: 8px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; font-size: 12px; }
    .regions .regions-title { color: var(--text-muted); font-weight: 600; margin-bottom: 6px; }
    .regions ul { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
    .regions li a { display: inline-block; padding: 3px 10px; border-radius: 10px; background: var(--changed-bg); color: var(--changed); text-decoration: none; font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace; font-size: 11px; }
    .regions li a:hover { filter: brightness(0.95); }
    .regions li a.region-shift { background: var(--info-bg); color: var(--info); }
    .page-shift { margin-top: 8px; padding: 8px 10px; background: var(--info-bg); border-radius: 6px; font-size: 12px; color: var(--info); }

    /* Masks (audit trail) */
    .masks { margin-top: 8px; padding: 10px 12px; background: repeating-linear-gradient(45deg, var(--hatch-a), var(--hatch-a) 6px, var(--hatch-b) 6px, var(--hatch-b) 8px); border: 1px solid var(--border); border-radius: 8px; font-size: 12px; color: var(--text-muted); }
    .masks .label { font-weight: 600; color: var(--text); }
    .masks code { color: var(--link); font-size: 11px; }
    .mask-warning { margin-top: 8px; padding: 10px 12px; background: var(--new-bg); border-radius: 8px; font-size: 12px; color: var(--new); }

    /* Zoom overlay */
    .zoom-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 100; justify-content: center; align-items: center; cursor: zoom-out; }
    .zoom-overlay.active { display: flex; }
    .zoom-overlay img { max-width: 95%; max-height: 95%; border-radius: 8px; }

    /* Missing-baselines notice (coverage loss) */
    .missing-notice { background: var(--new-bg); border: 1px solid color-mix(in srgb, var(--new) 30%, transparent); border-radius: 10px; padding: 14px 16px; margin-bottom: 24px; font-size: 13px; color: var(--new); }
    .missing-notice .m-title { font-weight: 700; margin-bottom: 4px; }
    .missing-notice code { background: var(--code-bg); border-radius: 3px; padding: 1px 5px; font-size: 12px; }
    .missing-notice .m-hint { color: var(--text-muted); font-size: 12px; margin-top: 6px; }

    /* Notices / empty state */
    .oss-notice { margin-top: 14px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; font-size: 11px; color: var(--text-muted); line-height: 1.6; box-shadow: var(--shadow); }
    .oss-notice h4 { margin: 0 0 8px; font-size: 11px; color: var(--text); }
    .oss-notice p { margin: 0 0 6px; }
    .oss-notice p:last-child { margin-bottom: 0; }
    .oss-notice code { background: var(--code-bg); border-radius: 3px; padding: 1px 4px; font-size: 10px; }
    .oss-notice a { color: var(--link); }
    .empty { text-align: center; padding: 48px; color: var(--text-muted); }
    .empty .icon { font-size: 48px; margin-bottom: 16px; }

    /* Mobile / narrow screens: sidebar becomes an off-canvas drawer, collapsed
       by default; diff images stack; everything wraps instead of overflowing. */
    @media (max-width: 900px) {
      body { display: block; }
      .mobile-topbar { display: flex; }
      .sidebar { z-index: 60; width: min(300px, 85vw); transform: translateX(-105%); transition: transform 0.2s ease; box-shadow: 4px 0 24px rgba(0,0,0,0.25); }
      .sidebar.open { transform: translateX(0); }
      .sidebar-backdrop.active { display: block; }
      .main { margin-left: 0; padding: 16px; max-width: 100%; }
      .section { scroll-margin-top: 64px; }
      .snapshot { padding: 14px; }
      .snapshot-header { flex-wrap: wrap; gap: 6px; }
      .diff-view, .diff-view.two-col { grid-template-columns: 1fr; }
      .diff-col img:hover { transform: none; }
      .approve-cmd { flex-wrap: wrap; gap: 8px; }
      .approve-cmd code { overflow-wrap: anywhere; }
      .analysis-head { flex-wrap: wrap; gap: 4px; }
      .verdict code, .missing-notice code { overflow-wrap: anywhere; }
    }
  </style>
</head>
<body>
  <header class="mobile-topbar">
    <button class="menu-toggle" id="menuToggle" aria-label="Toggle navigation" aria-expanded="false">☰</button>
    <span class="topbar-title">TestivAI <span>Visual Report</span></span>
  </header>
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
  <aside class="sidebar" id="sidebar">
    <div class="brand-row">
      <h1>TestivAI</h1>
      <button class="theme-toggle" id="themeToggle" title="Switch between light and dark theme">Dark</button>
    </div>
    <div class="version">Visual Report v${escapeHtml(version)}</div>
    <div class="timestamp">${escapeHtml(new Date(timestamp).toLocaleString())}</div>

    <div class="summary-cards">
      <div class="card total"><div class="label">Total</div><div class="value">${summary.total}</div></div>
      <div class="card changed"><div class="label">Changed</div><div class="value">${summary.changed}</div></div>
      <div class="card new"><div class="label">New</div><div class="value">${summary.newSnapshots}</div></div>
      <div class="card passed"><div class="label">Passed</div><div class="value">${summary.passed}</div></div>
    </div>

    <ul class="nav">
      ${summary.changed > 0 ? `<li><a href="#changed">Changed <span class="count">${summary.changed}</span></a></li>` : ''}
      ${summary.newSnapshots > 0 ? `<li><a href="#new">New <span class="count">${summary.newSnapshots}</span></a></li>` : ''}
      ${summary.passed > 0 ? `<li><a href="#passed">Passed <span class="count">${summary.passed}</span></a></li>` : ''}
    </ul>

    <div class="cta">
      <h3>Reviewing with an AI agent?</h3>
      <p>The <code>@testivai/mcp</code> server gives Claude Code, Cursor, and any MCP client this report as structured data — including <code>explain_snapshot</code>, which attributes each diff to selectors and explains why it happened.</p>
      <a href="https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md" target="_blank">Agent setup guide</a>
    </div>

    <div class="oss-notice">
      <h4>Pixel-exact mode</h4>
      <p>Dynamic content (images, fonts, animations) may cause false positives. The <strong>DOM unchanged</strong> hint identifies likely render noise.</p>
      <p>To reduce noise:<br>
        • Raise <code>threshold</code> in <code>.testivai/config.json</code><br>
        • Add <code>ignoreSelectors</code> for dynamic elements<br>
        • Use <code>mode: "collapse"</code> for variable-height regions
      </p>
    </div>
  </aside>

  <main class="main">
    ${missing.length > 0 ? `
    <div class="missing-notice">
      <div class="m-title">${missing.length} baseline${missing.length === 1 ? '' : 's'} received no capture this run</div>
      ${missing.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}
      <div class="m-hint">A deleted or renamed test silently stops guarding its page. If intentional, remove the baseline (and commit); if this was a filtered run (<code>--grep</code>), ignore this notice.</div>
    </div>` : ''}
    ${summary.total === 0 ? `
    <div class="empty">
      
      <h2>No snapshots found</h2>
      <p>Run your tests to capture snapshots, then re-run the report.</p>
    </div>` : ''}

    ${changed.length > 0 ? `
    <section class="section" id="changed">
      <h2 class="section-title changed">Changed (${changed.length})</h2>
      ${changed.map((s) => renderSnapshot(s)).join('\n')}
    </section>` : ''}

    ${newSnapshots.length > 0 ? `
    <section class="section" id="new">
      <h2 class="section-title new">New (${newSnapshots.length})</h2>
      ${newSnapshots.map((s) => renderSnapshot(s)).join('\n')}
    </section>` : ''}

    ${passed.length > 0 ? `
    <section class="section" id="passed">
      <h2 class="section-title passed">Passed (${passed.length})</h2>
      ${passed.map((s) => renderSnapshot(s)).join('\n')}
    </section>` : ''}
  </main>

  <div class="zoom-overlay" id="zoomOverlay"><img id="zoomImg" src="" alt="Zoomed"></div>

  <script>
    // Theme: light is the default; a stored preference of "dark" overrides.
    (function () {
      const KEY = 'testivai-theme';
      const btn = document.getElementById('themeToggle');
      const apply = (theme) => {
        if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
        btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
      };
      let theme = 'light';
      try { theme = localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch {}
      apply(theme);
      btn.addEventListener('click', () => {
        theme = theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, theme); } catch {}
        apply(theme);
      });
    })();

    // Mobile drawer: collapsed by default; hamburger toggles, backdrop or a
    // nav tap closes. Inert on desktop (the topbar/backdrop are display:none).
    (function () {
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebarBackdrop');
      const toggle = document.getElementById('menuToggle');
      const set = (open) => {
        sidebar.classList.toggle('open', open);
        backdrop.classList.toggle('active', open);
        toggle.setAttribute('aria-expanded', String(open));
      };
      toggle.addEventListener('click', () => set(!sidebar.classList.contains('open')));
      backdrop.addEventListener('click', () => set(false));
      sidebar.querySelectorAll('.nav a').forEach(a => a.addEventListener('click', () => set(false)));
    })();

    document.querySelectorAll('.diff-col img').forEach(img => {
      img.addEventListener('click', () => {
        document.getElementById('zoomImg').src = img.src;
        document.getElementById('zoomOverlay').classList.add('active');
      });
    });
    document.getElementById('zoomOverlay').addEventListener('click', () => {
      document.getElementById('zoomOverlay').classList.remove('active');
    });

    document.querySelectorAll('.region-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        const diff = chip.dataset.diff;
        if (diff) {
          document.getElementById('zoomImg').src = diff;
          document.getElementById('zoomOverlay').classList.add('active');
        }
      });
    });

    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        navigator.clipboard.writeText(cmd).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderSnapshot(snapshot: SnapshotResult): string {
  const badgeClass = snapshot.status === 'changed' ? 'badge-changed' : snapshot.status === 'new' ? 'badge-new' : 'badge-passed';

  const hasBaseline = !!snapshot.baselinePath;
  const hasDiff = !!snapshot.diffPath;
  const hasCurrent = !!snapshot.currentPath;

  let gridClass = 'diff-view';
  if (hasBaseline && hasDiff && hasCurrent) gridClass += '';
  else if (hasCurrent && !hasBaseline) gridClass += ' one-col';
  else gridClass += ' two-col';

  return `
    <div class="snapshot">
      <div class="snapshot-header">
        <span class="snapshot-name">${escapeHtml(snapshot.name)}</span>
        <span class="snapshot-badge ${badgeClass}">${snapshot.status}</span>
      </div>
      ${renderStats(snapshot)}
      ${renderAnalysis(snapshot)}
      <div class="${gridClass}">
        ${hasBaseline ? `<div class="diff-col"><label>Baseline</label><img src="${snapshot.baselinePath}" alt="Baseline"></div>` : ''}
        ${hasDiff ? `<div class="diff-col"><label>Diff <span class="heat-legend" title="Heatmap: color = difference magnitude">subtle <span class="heat-bar"></span> strong</span></label><img src="${snapshot.diffPath}" alt="Diff heatmap"></div>` : ''}
        ${hasCurrent ? `<div class="diff-col"><label>Current</label><img src="${snapshot.currentPath}" alt="Current"></div>` : ''}
      </div>
      ${snapshot.status === 'changed' || snapshot.status === 'new' ? `
      <div class="approve-cmd">
        <code>npx testivai approve ${escapeHtml(snapshot.name)}</code>
        <button class="copy-btn" data-cmd="npx testivai approve ${escapeHtml(snapshot.name)}">Copy</button>
      </div>` : ''}
    </div>`;
}

/**
 * Stats line: diff numbers (for changed/auto-passed) plus baseline
 * provenance — when the compared baseline was last approved. A months-old
 * baseline deserves a closer look than yesterday's.
 */
function renderStats(snapshot: SnapshotResult): string {
  const parts: string[] = [];
  if (snapshot.status === 'changed' || snapshot.autoPassed) {
    parts.push(
      `Diff: ${snapshot.diffPercent.toFixed(2)}% (${snapshot.diffCount} pixels)${snapshot.autoPassed ? ` — auto-passed: ${snapshot.autoPassed === 'noise' ? 'DOM unchanged, within noise tolerance' : snapshot.autoPassed === 'shift' ? 'pure element shifts within layout tolerance' : 'within configured diff tolerance'}` : ''}`,
    );
  }
  if (snapshot.baselineApprovedAt) {
    const d = new Date(snapshot.baselineApprovedAt);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`baseline approved ${d.toISOString().slice(0, 10)}`);
    }
  }
  if (parts.length === 0) return '';
  return `<div class="snapshot-stats">${parts.join(' · ')}</div>`;
}

/**
 * The "Layered analysis" panel: a synthesized verdict headline followed by
 * the individual evidence layers (DOM/style signal, attributed regions,
 * page shift, masks). This is the human-facing view of the same layered
 * evidence @testivai/mcp's explain_snapshot serves to AI agents.
 */
function renderAnalysis(snapshot: SnapshotResult): string {
  const verdict = renderVerdict(snapshot);
  const layers = [renderDomHint(snapshot), renderRegions(snapshot), renderMasks(snapshot)].filter(Boolean).join('');
  if (!verdict && !layers) return '';

  return `
      <div class="analysis">
        <div class="analysis-head">
          <span class="analysis-title">Layered analysis</span>
          <span class="analysis-mcp">agents get this via <code>@testivai/mcp</code> · <code>explain_snapshot</code></span>
        </div>
        ${verdict}
        ${layers}
      </div>`;
}

/**
 * Verdict headline: one plain-language line synthesizing the layers, in
 * priority order — style-only change (real) > page shift (injected content)
 * > structural DOM change > render noise > new snapshot > auto-pass.
 */
function renderVerdict(snapshot: SnapshotResult): string {
  if (snapshot.status === 'passed' && !snapshot.autoPassed) return '';

  if (snapshot.status === 'new') {
    return `<div class="verdict v-new"><span>First capture — no baseline yet. Review the image, then approve to make it the baseline.</span></div>`;
  }

  if (snapshot.dom?.styleCheck === 'mismatch' && snapshot.dom.styleChanges) {
    const n = snapshot.dom.styleChanges.count;
    const first = snapshot.dom.styleChanges.elements[0];
    const el = first ? `<code>${escapeHtml(first.split(' > ').slice(-1)[0])}</code>` : '';
    return `<div class="verdict v-style"><span>Style-only change — a real change, not noise: ${n} element${n === 1 ? '' : 's'} restyled with identical DOM${el ? ` (${el}${n > 1 ? ', …' : ''})` : ''}. Confirm it's intended before approving.</span></div>`;
  }

  if (snapshot.pageShift) {
    const p = snapshot.pageShift;
    return `<div class="verdict v-shift"><span>Layout shift — everything below y=${p.belowY} moved ${p.dy > 0 ? 'down' : 'up'} ${Math.abs(p.dy)}px (${p.count} elements together). Look <em>above</em> that line for inserted or removed content; the moved elements themselves are unchanged.</span></div>`;
  }

  if (snapshot.dom?.changed && snapshot.dom.summary) {
    const s = snapshot.dom.summary;
    const parts: string[] = [];
    if (s.added > 0) parts.push(`${s.added} added`);
    if (s.removed > 0) parts.push(`${s.removed} removed`);
    if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute`);
    if (s.textChanges) parts.push(`${s.textChanges} text`);
    return `<div class="verdict v-structural"><span>Structural change — the DOM differs (${escapeHtml(parts.join(', ') || 'structural difference')}). Review the diff and confirm the change is intended before approving.</span></div>`;
  }

  if (snapshot.dom?.noiseHint) {
    return `<div class="verdict v-noise"><span>Likely render noise — pixels differ but the DOM${snapshot.dom.styleCheck === 'match' ? ' and computed styles are' : ' is'} identical (anti-aliasing, font hinting). Worth a glance, not a block.</span></div>`;
  }

  if (snapshot.autoPassed) {
    return `<div class="verdict v-pass"><span>Auto-passed via the <code>${snapshot.autoPassed}</code> criterion — reported for transparency, no action needed.</span></div>`;
  }

  return '';
}

/**
 * Render the DOM noise-hint badge for a snapshot.
 *
 * Two states (DOM hint is only meaningful for `changed` snapshots that
 * have DOM data captured on both sides):
 *   - noiseHint: pixels differ but DOM is unchanged → "likely render noise"
 *   - changed:   pixels and DOM both differ → show counts so the reviewer
 *                can decide whether the change is intentional
 *
 * Returns empty string when no DOM data was captured (the adapter didn't
 * record `dom.html`); we don't want to confuse the user with "no signal".
 */
function renderDomHint(snapshot: SnapshotResult): string {
  if (!snapshot.dom) return '';

  // Style fingerprint verdict: identical DOM but changed computed styles
  // is a REAL change (the stylesheet-only case) — never noise.
  if (snapshot.dom.styleCheck === 'mismatch' && snapshot.dom.styleChanges) {
    const els = snapshot.dom.styleChanges.elements
      .slice(0, 3)
      .map((p) => `<code>${escapeHtml(p.split(' > ').slice(-1)[0])}</code>`)
      .join(', ');
    const n = snapshot.dom.styleChanges.count;
    return `
      <div class="dom-hint style-changed" title="DOM structure is identical but computed styles differ — a stylesheet-level change, not render noise.">
        <span class="label">Styles changed</span>
        <span class="summary">— ${n} element${n === 1 ? '' : 's'} restyled with identical DOM: ${els}${n > 3 ? ', …' : ''}.</span>
      </div>`;
  }

  if (snapshot.dom.noiseHint) {
    const styleNote =
      snapshot.dom.styleCheck === 'match'
        ? ' Styles verified unchanged.'
        : snapshot.dom.styleCheck === 'unavailable'
          ? ' (Style check unavailable — no comparable style digests on both sides.)'
          : '';
    return `
      <div class="dom-hint noise" title="DOM tree is identical between baseline and candidate; the pixel diff is likely render noise.">
        <span class="label">DOM unchanged</span>
        <span class="summary">— pixel diff is likely render noise (anti-aliasing, font hinting).${styleNote}</span>
      </div>`;
  }

  const s = snapshot.dom.summary;
  if (!s) return '';
  const parts: string[] = [];
  if (s.added > 0) parts.push(`${s.added} added`);
  if (s.removed > 0) parts.push(`${s.removed} removed`);
  if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute change${s.attributeChanges === 1 ? '' : 's'}`);
  if (s.textChanges) parts.push(`${s.textChanges} text change${s.textChanges === 1 ? '' : 's'}`);
  return `
    <div class="dom-hint changed" title="Structural DOM changes detected alongside the pixel diff.">
      <span class="label">DOM changed</span>
      <span class="summary">— ${escapeHtml(parts.join(', ') || 'structural difference')}.</span>
    </div>`;
}

/**
 * Region chip list: "N changed regions" with coordinates. Clicking a chip
 * zooms the diff image so the reviewer can inspect that area.
 */
function renderRegions(snapshot: SnapshotResult): string {
  const regions = snapshot.regions ?? [];
  if (regions.length === 0 || snapshot.status === 'new') return '';

  const describe = (r: NonNullable<SnapshotResult['regions']>[number]): string => {
    const el = r.elements?.[0];
    if (!el) return `${r.width}×${r.height} @ (${r.x}, ${r.y})`;
    const selector = escapeHtml(el.selector.split(' > ').slice(-1)[0]);
    if (r.classification === 'shift' && r.shift) {
      const parts: string[] = [];
      if (r.shift.dy !== 0) parts.push(`${r.shift.dy > 0 ? '+' : ''}${r.shift.dy}px vertically`);
      if (r.shift.dx !== 0) parts.push(`${r.shift.dx > 0 ? '+' : ''}${r.shift.dx}px horizontally`);
      return `${selector} shifted ${parts.join(', ')} — content unchanged`;
    }
    return `${selector} changed (${r.width}×${r.height} @ ${r.x}, ${r.y})`;
  };

  const chips = regions
    .map(
      (r, i) =>
        `<li><a href="#" class="region-chip${r.classification === 'shift' ? ' region-shift' : ''}" data-diff="${snapshot.diffPath ?? ''}" title="${r.diffPixels} changed pixels${r.elements?.[0] ? ' — ' + escapeHtml(r.elements[0].selector) : ''}">#${i + 1} · ${describe(r)}</a></li>`,
    )
    .join('');

  const shifted = regions.filter((r) => r.classification === 'shift').length;
  const title =
    shifted > 0
      ? `${regions.length} changed region${regions.length === 1 ? '' : 's'} (${shifted} shifted)`
      : `${regions.length} changed region${regions.length === 1 ? '' : 's'}`;

  const pageShift = snapshot.pageShift
    ? `<div class="page-shift">↕ Everything below y=${snapshot.pageShift.belowY} shifted ${snapshot.pageShift.dy > 0 ? '+' : ''}${snapshot.pageShift.dy}px (${snapshot.pageShift.count} elements moved together — typically an inserted banner or expanded section above).</div>`
    : '';

  return `
      <div class="regions">
        <div class="regions-title">${title}</div>
        <ul>${chips}</ul>
        ${pageShift}
      </div>`;
}

/**
 * Mask audit trail: every mask applied to this comparison is listed with
 * its source — masking is visible in review, never silent. Warnings cover
 * masks that could not be applied (e.g. selector without captured rects).
 */
function renderMasks(snapshot: SnapshotResult): string {
  const masks = snapshot.masks ?? [];
  const warnings = snapshot.maskWarnings ?? [];
  if (masks.length === 0 && warnings.length === 0) return '';

  const describe = (m: NonNullable<SnapshotResult['masks']>[number]): string => {
    const src =
      m.source.type === 'selector'
        ? `selector <code>${escapeHtml(String(m.source.spec))}</code>`
        : m.source.type === 'edge'
          ? `edge <code>${escapeHtml(JSON.stringify(m.source.spec))}</code>`
          : `region <code>${escapeHtml(JSON.stringify(m.source.spec))}</code>`;
    return `${src} → ${m.width}×${m.height} @ (${m.x}, ${m.y}) <em>(${m.source.origin})</em>`;
  };

  const maskBlock =
    masks.length > 0
      ? `
      <div class="masks" title="Masked areas are excluded from the pixel diff and hatched in the diff image.">
        <span class="label">${masks.length} mask${masks.length === 1 ? '' : 's'} applied</span>
        — ${masks.map(describe).join('; ')}
      </div>`
      : '';

  const warningBlock =
    warnings.length > 0
      ? `
      <div class="mask-warning">${warnings.map((w) => escapeHtml(w)).join('<br>')}</div>`
      : '';

  return maskBlock + warningBlock;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
