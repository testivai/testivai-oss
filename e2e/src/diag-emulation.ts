/**
 * TEMPORARY DIAGNOSTIC (to be removed before merge): prints, never fails.
 * Which way of restoring the device emulation a CDP beyond-viewport capture
 * drops brings back `pointer: coarse` on this machine's Chrome.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { chromium, devices } from 'playwright-core';

const probe = `JSON.stringify({ dpr: devicePixelRatio, touch: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches })`;

function chrome(): string | null {
  if (process.env.TESTIVAI_CHROME_PATH && fs.existsSync(process.env.TESTIVAI_CHROME_PATH)) return process.env.TESTIVAI_CHROME_PATH;
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    try { const p = execFileSync('which', [n], { encoding: 'utf-8' }).trim(); if (p) return p; } catch { /* next */ }
  }
  return null;
}

type Restore = (ctx: any, page: any, keep: any[]) => Promise<void>;
const nudge = async (page: any) => { const vp = page.viewportSize(); await page.setViewportSize({ width: vp.width, height: vp.height + 1 }); await page.setViewportSize(vp); };
const touchOn = async (ctx: any, page: any, keep: any[], extra?: (s: any) => Promise<void>) => { const s = await ctx.newCDPSession(page); keep.push(s); await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }); if (extra) await extra(s); };

const VARIANTS: Array<[string, Restore]> = [
  ['A nudge only', async (_c, p) => nudge(p)],
  ['B touch then nudge', async (c, p, k) => { await touchOn(c, p, k); await nudge(p); }],
  ['C nudge then touch', async (c, p, k) => { await nudge(p); await touchOn(c, p, k); }],
  ['D touch+emitTouch(mobile) then nudge', async (c, p, k) => { await touchOn(c, p, k, (s) => s.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })); await nudge(p); }],
  ['E touch off/on then nudge', async (c, p, k) => { const s = await c.newCDPSession(p); k.push(s); await s.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }); await nudge(p); }],
  ['F own metrics(mobile)+touch on kept session', async (c, p, k) => { const s = await c.newCDPSession(p); k.push(s); await s.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 839, deviceScaleFactor: 2.625, mobile: true }); await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }); }],
  ['G nudge, touch, nudge', async (c, p, k) => { await nudge(p); await touchOn(c, p, k); await nudge(p); }],
];

(async () => {
  const exe = chrome();
  if (!exe) { console.log('[diag] no chrome'); return; }
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  console.log('[diag] chrome', browser.version());
  for (const [label, restore] of VARIANTS) {
    try {
      const ctx = await browser.newContext({ ...devices['Pixel 7'] });
      const page = await ctx.newPage();
      await page.setContent('<meta name="viewport" content="width=device-width"><div style="height:2000px"></div>');
      const before = await page.evaluate(probe);
      const c = await ctx.newCDPSession(page);
      const m = await c.send('Page.getLayoutMetrics');
      await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(m.contentSize.width), height: Math.ceil(m.contentSize.height), scale: 1 } });
      await c.detach();
      const after = await page.evaluate(probe);
      const keep: any[] = [];
      await restore(ctx, page, keep);
      await page.waitForTimeout(50);
      console.log(`[diag] ${label.padEnd(44)} before ${before} after-capture ${after} restored ${await page.evaluate(probe)}`);
      await ctx.close();
    } catch (e) {
      console.log(`[diag] ${label} threw ${(e as Error).message}`);
    }
  }
  await browser.close();
})();
