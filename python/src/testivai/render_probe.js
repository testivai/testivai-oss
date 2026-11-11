/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * RENDER_PROBE_EXPRESSION, emitted from
 *   packages/witness/src/capture/environment.ts
 * by
 *   scripts/generate-element-map-asset.js
 *
 * What the page is rendered with (viewport, scale, colour scheme…): `render`
 * in the capture's `environment` block.
 * Evaluate the expression below as it is (WebDriver: prefix `return `), so
 * every adapter records the same thing. Edit the TypeScript source and
 * re-run the generator; CI fails if this file is stale.
 */
(function () {
  var out = {};
  try { out.viewport = { width: window.innerWidth, height: window.innerHeight }; } catch (e) {}
  try { out.deviceScaleFactor = window.devicePixelRatio; } catch (e) {}
  try { out.colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) {}
  try { out.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'; } catch (e) {}
  try { out.locale = navigator.language; } catch (e) {}
  try { out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  try { out.userAgent = navigator.userAgent; } catch (e) {}
  return out;
})()
