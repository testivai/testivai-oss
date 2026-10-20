"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/approve.ts
var approve_exports = {};
__export(approve_exports, {
  approvedRun: () => approvedRun,
  buildApproveReply: () => buildApproveReply,
  findReportUrl: () => findReportUrl,
  readApprovedHealth: () => readApprovedHealth,
  reply: () => reply
});
module.exports = __toCommonJS(approve_exports);
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// ../packages/witness/src/capture/health.ts
var RESOURCE_TYPES = ["css", "font", "img", "script", "other"];
var HEALTH_LIMITS = {
  /** Entries kept per list. */
  list: 10,
  /** Characters kept of a URL (host and path). */
  url: 200,
  /** Longest family, weight, style or error text accepted. */
  text: 200
};
var HEALTH_PROBE_EXPRESSION = `(function () {
  var LIMIT = ${HEALTH_LIMITS.list};
  var MAX = ${HEALTH_LIMITS.url};
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
    var m = /\\.([a-z0-9]+)$/i.exec(url);
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
            family: String(face.family).replace(/^\\s*["']|["']\\s*$/g, '').slice(0, MAX),
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
      var rel = ' ' + String(link.getAttribute('rel') || '').toLowerCase().replace(/\\s+/g, ' ') + ' ';
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
})()`;
var Malformed = class extends Error {
};
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function record(v) {
  if (!isRecord(v)) throw new Malformed();
  return v;
}
function count(v) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Malformed();
  return v;
}
function text(v, max) {
  if (typeof v !== "string" || v.length > max) throw new Malformed();
  return v;
}
function oneOf(v, allowed) {
  if (typeof v !== "string" || !allowed.includes(v)) throw new Malformed();
  return v;
}
function list(v, item) {
  if (!Array.isArray(v)) throw new Malformed();
  return v.slice(0, HEALTH_LIMITS.list).map(item);
}
function readFailures(v) {
  const g = record(v);
  return {
    count: count(g.count),
    entries: list(g.entries, (e) => {
      const entry = record(e);
      const out = { url: text(entry.url, HEALTH_LIMITS.url), status: count(entry.status) };
      if (entry.error !== void 0) out.error = text(entry.error, HEALTH_LIMITS.text);
      return out;
    })
  };
}
function readHealthBlock(raw) {
  const h = record(raw);
  const fonts = record(h.fonts);
  const stylesheets = record(h.stylesheets);
  const images = record(h.images);
  const resources = record(h.resources);
  const failed = {};
  for (const [type, group] of Object.entries(record(resources.failed))) {
    failed[oneOf(type, RESOURCE_TYPES)] = readFailures(group);
  }
  return {
    fonts: {
      status: oneOf(fonts.status, ["loaded", "loading", "unavailable"]),
      failed: list(fonts.failed, (f) => {
        const face = record(f);
        return { family: text(face.family, HEALTH_LIMITS.text), weight: text(face.weight, HEALTH_LIMITS.text), style: text(face.style, HEALTH_LIMITS.text) };
      })
    },
    stylesheets: { failed: count(stylesheets.failed), urls: list(stylesheets.urls, (u) => text(u, HEALTH_LIMITS.url)) },
    images: { broken: count(images.broken), urls: list(images.urls, (u) => text(u, HEALTH_LIMITS.url)) },
    resources: { status: oneOf(resources.status, ["checked", "unavailable"]), failed }
  };
}
function parseHealth(raw) {
  try {
    return readHealthBlock(raw);
  } catch {
    return null;
  }
}

// ../packages/witness/src/report/anchor.ts
var PLAIN_SNAPSHOT_NAME = /^[A-Za-z0-9_-]{1,60}$/;
function snapshotAnchorId(name) {
  if (PLAIN_SNAPSHOT_NAME.test(name)) return `snap-${name}`;
  const readable = trimDashes(name.replace(/[^A-Za-z0-9_-]+/g, "-")).slice(0, 60);
  return `snap-${readable ? `${readable}-` : ""}${fnv1a(name)}`;
}
function trimDashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start++;
  while (end > start && value[end - 1] === "-") end--;
  return value.slice(start, end);
}
function fnv1a(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ../packages/witness/src/report/health.ts
var NAMED = 3;
var plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
function requestLine(noun, entry) {
  const url = entry.url || "(no URL)";
  if (entry.status > 0) return `${noun} ${url} returned ${entry.status}`;
  return `${noun} ${url} failed to load${entry.error ? ` (${entry.error})` : ""}`;
}
function requestLines(noun, entries, total) {
  const shown = entries.slice(0, NAMED);
  const lines = shown.map((e) => requestLine(noun, e));
  const rest = total - shown.length;
  if (rest > 0) lines.push(`${plural(rest, `more ${noun}`)} failed to load`);
  return lines;
}
function elementLines(noun, urls, total, requests) {
  const byUrl = new Map(requests.map((e) => [e.url, e]));
  const shown = urls.slice(0, NAMED);
  const lines = shown.map((url) => {
    const request = byUrl.get(url);
    return request ? requestLine(noun, request) : `${noun} ${url || "(no URL)"} did not load`;
  });
  const rest = total - shown.length;
  if (rest > 0) lines.push(`${plural(rest, `more ${noun}`)} did not load`);
  return lines;
}
function fontLine(families) {
  const quoted = families.map((f) => `'${f}'`);
  if (quoted.length === 1) return `web font ${quoted[0]} failed to load, so the page rendered with a fallback font`;
  const names = quoted.length === 2 ? `${quoted[0]} and ${quoted[1]}` : `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
  return `web fonts ${names} failed to load, so the page rendered with fallback fonts`;
}
function assessHealth(health) {
  const reasons = [];
  const warnings = [];
  const problems = /* @__PURE__ */ new Set();
  const failed = health.resources.failed;
  if (health.fonts.status === "loading") {
    reasons.push("web fonts were still loading when the page was captured");
    problems.add("web fonts still loading");
  }
  const families = [...new Set(health.fonts.failed.map((f) => f.family))];
  if (families.length > 0) {
    reasons.push(fontLine(families));
    problems.add("a failed web font");
  }
  if (failed.font && failed.font.count > 0) {
    const lines = requestLines("font file", failed.font.entries, failed.font.count);
    if (families.length > 0 || health.fonts.status === "unavailable") {
      reasons.push(...lines);
      problems.add("a failed web font");
    } else {
      warnings.push(...lines);
    }
  }
  const css = failed.css ?? { count: 0, entries: [] };
  if (health.stylesheets.failed > 0) {
    reasons.push(...elementLines("stylesheet", health.stylesheets.urls, health.stylesheets.failed, css.entries));
    problems.add("a failed stylesheet");
  }
  const linked = new Set(health.stylesheets.urls);
  const unlinked = css.entries.filter((e) => !linked.has(e.url));
  const unlinkedCount = css.count - (css.entries.length - unlinked.length);
  if (unlinkedCount > 0) {
    reasons.push(...requestLines("stylesheet", unlinked, unlinkedCount));
    problems.add("a failed stylesheet");
  }
  const img = failed.img ?? { count: 0, entries: [] };
  if (health.images.broken > 0) warnings.push(...elementLines("image", health.images.urls, health.images.broken, img.entries));
  const shownImages = new Set(health.images.urls);
  const otherImages = img.entries.filter((e) => !shownImages.has(e.url));
  const otherImageCount = img.count - (img.entries.length - otherImages.length);
  if (otherImageCount > 0) warnings.push(...requestLines("image", otherImages, otherImageCount));
  if (failed.script && failed.script.count > 0) warnings.push(...requestLines("script", failed.script.entries, failed.script.count));
  if (failed.other && failed.other.count > 0) warnings.push(...requestLines("request", failed.other.entries, failed.other.count));
  return { unhealthy: problems.size > 0, problems: [...problems], reasons, warnings };
}

// ../packages/witness/src/report/diff-shape.ts
var CONCENTRATED_MAX_PAGE_SHARE = 1 / 3;

// src/comment.ts
var RUN_MARKER = /<!-- testivai-run:([A-Za-z0-9_-]+) -->/;
function readRunKey(body) {
  return RUN_MARKER.exec(body)?.[1];
}
function safeReportUrl(url) {
  if (!url || /[\s"'<>()`\\]/.test(url)) return void 0;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return void 0;
  }
  if (parsed.protocol !== "https:") return void 0;
  parsed.hash = "";
  return parsed.toString();
}

// src/publish/comments.ts
var BOT_LOGIN = "github-actions[bot]";

// src/report-artifact.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var RUN_STAMP_FILE = "testivai-run.json";
function readRunStamp(reportDir) {
  try {
    return parseRunStamp(fs.readFileSync(path.join(reportDir, RUN_STAMP_FILE), "utf8"));
  } catch {
    return null;
  }
}
function parseRunStamp(text2) {
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { runId, runAttempt, sha } = raw;
  if (typeof runId !== "string" || typeof runAttempt !== "number" || !Number.isInteger(runAttempt) || runAttempt < 1) return null;
  return { runId, runAttempt, ...typeof sha === "string" ? { sha } : {} };
}

// src/approve.ts
var LINK = /\]\((https:\/\/[^\s()<>"'`\\]+)\)/g;
function findReportUrl(comments, { pr, runKey }) {
  const page = `/pr/${Math.trunc(pr)}/${runKey}/`;
  for (const comment of comments) {
    if (comment.author !== BOT_LOGIN || readRunKey(comment.body) !== runKey) continue;
    for (const [, raw] of comment.body.matchAll(LINK)) {
      const url = safeReportUrl(raw);
      if (!url) continue;
      const parsed = new URL(url);
      if (!parsed.search && parsed.pathname.endsWith(page)) return url;
    }
  }
  return void 0;
}
function approvedRun(stamp, downloadedRunId) {
  if (!downloadedRunId || !/^\d+$/.test(downloadedRunId)) return void 0;
  if (stamp && stamp.runId === downloadedRunId) return { id: downloadedRunId, attempt: stamp.runAttempt };
  return { id: downloadedRunId };
}
function readApprovedHealth(artifactDir, names) {
  const out = [];
  for (const name of names) {
    if (!name || name === "." || name === ".." || /[/\\]/.test(name)) continue;
    try {
      const meta = JSON.parse(fs2.readFileSync(path2.join(artifactDir, "pending-baselines", name, "metadata.json"), "utf-8"));
      const health = parseHealth(meta?.health);
      if (!health) continue;
      const assessment = assessHealth(health);
      if (assessment.unhealthy) out.push({ name, reasons: assessment.reasons });
    } catch {
    }
  }
  return out;
}
var RERUN_NOTE = "CI runs again on this commit when the approve step pushes with a personal access token or GitHub App token. With the default `GITHUB_TOKEN`, GitHub starts no run for this push: push another commit to re-run CI.";
function buildApproveReply({ approved, skipped, count: count2, actor, run, reportUrl, serverUrl, repo, unhealthy = [] }) {
  if (count2 === 0) {
    return [
      "No baselines were updated.",
      "",
      "Possible reasons:",
      "- The snapshot name(s) don't match any pending changes.",
      "- The artifact is from a run where no visual differences were detected.",
      "- Re-run the OSS visual regression tests and try again."
    ].join("\n");
  }
  const report = safeReportUrl(reportUrl);
  const from = run ? ` from [CI run ${run.id}${run.attempt ? `, attempt ${run.attempt}` : ""}](${serverUrl}/${repo}/actions/runs/${run.id}${run.attempt ? `/attempts/${run.attempt}` : ""})` : "";
  const lines = [`**${count2} baseline${count2 === 1 ? "" : "s"} approved** by @${actor}${from}`, ""];
  if (report) lines.push(`> **[Open the visual report](${report})** of that run: baseline, current and diff side by side`, "");
  lines.push(approved.map((n) => report ? `- \`${n}\` \xB7 [open in report](${report}#${snapshotAnchorId(n)})` : `- \`${n}\``).join("\n"));
  for (const u of unhealthy) {
    lines.push(
      "",
      `> **\`${u.name}\` was approved from an unhealthy capture** \u2014 ${u.reasons.join("; ")}. Every compare against it will say so: fix the page, the server or the test, re-run and approve a healthy capture.`
    );
  }
  if (skipped.length) lines.push("", `Not found in pending baselines: ${skipped.map((n) => `\`${n}\``).join(", ")}`);
  lines.push("", RERUN_NOTE);
  return lines.join("\n");
}
var PAGE = 100;
var MAX_PAGES = 10;
async function listComments(github, context) {
  const comments = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await github.rest.issues.listComments({ ...context.repo, issue_number: context.issue.number, per_page: PAGE, page });
    comments.push(...data.map((c) => ({ author: c.user?.login ?? "", body: c.body ?? "" })));
    if (data.length < PAGE) break;
  }
  return comments;
}
var words = (value) => (value ?? "").trim().split(/\s+/).filter(Boolean);
async function reply({ github, context, core, env }) {
  const count2 = Number.parseInt(env.COUNT ?? "", 10) || 0;
  const run = approvedRun(env.ARTIFACT_DIR ? readRunStamp(env.ARTIFACT_DIR) : null, env.RUN_ID);
  let reportUrl;
  if (count2 > 0 && run?.attempt !== void 0) {
    try {
      reportUrl = findReportUrl(await listComments(github, context), { pr: context.issue.number, runKey: `${run.id}-${run.attempt}` });
      core.info(reportUrl ? `Linking run ${run.id}'s published report: ${reportUrl}` : `Run ${run.id}, attempt ${run.attempt} has no published report linked in a TestivAI comment.`);
    } catch (error) {
      core.warning(`Could not read the pull request's comments for the report link (${error instanceof Error ? error.message : String(error)}); the reply goes without it.`);
    }
  }
  const approvedNames = words(env.APPROVED);
  const unhealthy = count2 > 0 && env.ARTIFACT_DIR ? readApprovedHealth(env.ARTIFACT_DIR, approvedNames) : [];
  const body = buildApproveReply({
    approved: approvedNames,
    skipped: words(env.SKIPPED),
    count: count2,
    actor: env.ACTOR ?? "",
    ...run ? { run } : {},
    ...reportUrl ? { reportUrl } : {},
    serverUrl: context.serverUrl || "https://github.com",
    repo: `${context.repo.owner}/${context.repo.repo}`,
    ...unhealthy.length > 0 ? { unhealthy } : {}
  });
  await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  approvedRun,
  buildApproveReply,
  findReportUrl,
  readApprovedHealth,
  reply
});
