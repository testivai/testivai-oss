/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * HEALTH_PROBE_EXPRESSION, emitted from
 *   packages/witness/src/capture/health.ts
 * by
 *   scripts/generate-element-map-asset.js
 *
 * What failed to load, read in the page right after the screenshot: `health`
 * in the capture's metadata.json.
 * Evaluate the expression below as it is (WebDriver: prefix `return `), so
 * every adapter records the same thing. Edit the TypeScript source and
 * re-run the generator; CI fails if this file is stale.
 */
(function () {
  var LIMIT = 10;
  var MAX = 200;
  var out = {};
  var base;
  try { base = document.baseURI || undefined; } catch (e) {}
  function where(href) {
    try {
      var u = new URL(String(href), base);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return (u.host + u.pathname).slice(0, MAX);
      return u.protocol;
    } catch (e) { return ''; }
  }
  var sheetHrefs = {};
  function kindOf(url, initiator) {
    if (initiator === 'fetch' || initiator === 'xmlhttprequest' || initiator === 'beacon') return 'other';
    if (initiator === 'link' && sheetHrefs[url]) return 'css';
    var m = /\.([a-z0-9]+)$/i.exec(url);
    var ext = m ? m[1].toLowerCase() : '';
    if (/^(woff2?|ttf|otf|eot)$/.test(ext)) return 'font';
    if (ext === 'css') return 'css';
    if (/^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(ext)) return 'img';
    if (/^m?js$/.test(ext)) return 'script';
    if (ext) return 'other';
    if (initiator === 'img' || initiator === 'image' || initiator === 'input') return 'img';
    if (initiator === 'script') return 'script';
    return 'other';
  }
  try {
    var set = document.fonts;
    if (set && typeof set.status === 'string' && typeof set.forEach === 'function') {
      var faces = [];
      set.forEach(function (face) {
        if (face && face.status === 'error' && faces.length < LIMIT) {
          faces.push({
            family: String(face.family).replace(/^\s*["']|["']\s*$/g, '').slice(0, MAX),
            weight: String(face.weight).slice(0, MAX),
            style: String(face.style).slice(0, MAX)
          });
        }
      });
      out.fonts = { status: set.status === 'loaded' ? 'loaded' : 'loading', failed: faces };
    } else {
      out.fonts = { status: 'unavailable', failed: [] };
    }
  } catch (e) { out.fonts = { status: 'unavailable', failed: [] }; }
  var statusByUrl = {};
  try {
    var timed = typeof performance !== 'undefined' && performance && typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
    for (var t = 0; t < timed.length; t++) {
      if (typeof timed[t].responseStatus === 'number') statusByUrl[timed[t].name] = timed[t].responseStatus;
    }
  } catch (e) {}
  try {
    var links = document.querySelectorAll('link[rel]');
    var sheetsFailed = 0, sheetUrls = [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var rel = ' ' + String(link.getAttribute('rel') || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
      if (rel.indexOf(' stylesheet ') === -1) continue;
      if (link.getAttribute('href')) sheetHrefs[where(link.href)] = true;
      if (rel.indexOf(' alternate ') !== -1) continue;
      if (link.disabled || !link.getAttribute('href')) continue;
      if (!link.sheet || statusByUrl[link.href] >= 400) {
        sheetsFailed++;
        if (sheetUrls.length < LIMIT) sheetUrls.push(where(link.href));
      }
    }
    out.stylesheets = { failed: sheetsFailed, urls: sheetUrls };
  } catch (e) {}
  try {
    var imgs = document.images, broken = 0, imageUrls = [];
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      var src = img.currentSrc || img.src || '';
      if (!src) continue;
      if (img.complete && img.naturalWidth === 0) {
        broken++;
        if (imageUrls.length < LIMIT) imageUrls.push(where(src));
      }
    }
    out.images = { broken: broken, urls: imageUrls };
  } catch (e) {}
  try {
    var timing = typeof PerformanceResourceTiming !== 'undefined' ? PerformanceResourceTiming : null;
    var perf = typeof performance !== 'undefined' ? performance : null;
    if (!timing || !timing.prototype || !('responseStatus' in timing.prototype) || !perf || typeof perf.getEntriesByType !== 'function') {
      out.resources = { status: 'unavailable', failed: {} };
    } else {
      var failed = {}, seen = {};
      var entries = perf.getEntriesByType('resource');
      for (var k = 0; k < entries.length; k++) {
        var entry = entries[k];
        var status = entry.responseStatus;
        if (typeof status !== 'number' || status < 400) continue;
        var url = where(entry.name);
        if (entry.initiatorType === 'other' && url.indexOf('/') === url.length - 12 && url.slice(-12) === '/favicon.ico') continue;
        var type = kindOf(url, entry.initiatorType);
        if (seen[type + ' ' + url]) continue;
        seen[type + ' ' + url] = true;
        var group = failed[type] || (failed[type] = { count: 0, entries: [] });
        group.count++;
        if (group.entries.length < LIMIT) group.entries.push({ url: url, status: status });
      }
      out.resources = { status: 'checked', failed: failed };
    }
  } catch (e) { out.resources = { status: 'unavailable', failed: {} }; }
  return out;
})()
