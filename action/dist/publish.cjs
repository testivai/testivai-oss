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

// src/publish.ts
var publish_exports = {};
__export(publish_exports, {
  build: () => build,
  finish: () => finish,
  parseCache: () => parseCache,
  parseComment: () => parseComment,
  parseInclude: () => parseInclude,
  parseRunsPerPr: () => parseRunsPerPr
});
module.exports = __toCommonJS(publish_exports);
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));

// ../packages/witness/src/report/diff-shape.ts
var NOISE_MAX_DIFF_PERCENT = 1;
var CONCENTRATED_MAX_PAGE_SHARE = 1 / 3;
var STYLE_CHECK_DOES_NOT_COVER = "size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets";
function diffShape(input) {
  const regions = input.regions ?? [];
  let box = null;
  if (regions.length > 0) {
    const x0 = Math.min(...regions.map((r) => r.x));
    const y0 = Math.min(...regions.map((r) => r.y));
    const x1 = Math.max(...regions.map((r) => r.x + r.width));
    const y1 = Math.max(...regions.map((r) => r.y + r.height));
    box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const page = input.totalPixels !== void 0 && input.totalPixels > 0 ? input.totalPixels : null;
  const pageShare = box && page ? box.width * box.height / page : null;
  const pagePercent = pageShare === null ? null : pageShare * 100;
  const concentrated = box !== null && (pageShare === null || pageShare <= CONCENTRATED_MAX_PAGE_SHARE);
  const small = input.diffPercent !== void 0 && input.diffPercent <= NOISE_MAX_DIFF_PERCENT;
  const kind = concentrated ? "concentrated" : small ? "scattered" : "large";
  return { kind, regionCount: regions.length, box, pagePercent };
}
function describeRegions(shape) {
  if (!shape.box) return "no regions";
  const n = shape.regionCount;
  const share = shape.pagePercent === null ? "" : `, ${shape.pagePercent.toFixed(1)}% of the page`;
  return `${n} region${n === 1 ? "" : "s"} within ${shape.box.width}\xD7${shape.box.height} px${share}`;
}

// ../packages/witness/src/report/size-mismatch.ts
function sizeMismatchKind(sm) {
  if (sm.baseline.width !== sm.candidate.width) return "width";
  if (sm.baseline.height !== sm.candidate.height) return "height";
  return null;
}
var signed = (px) => `${px > 0 ? "+" : "-"}${Math.abs(px)} px`;
function formatSizes(sm) {
  const { baseline: b, candidate: c } = sm;
  return `baseline ${b.width}\xD7${b.height} \u2192 current ${c.width}\xD7${c.height}`;
}
function formatSizeMismatch(sm) {
  const { baseline: b, candidate: c } = sm;
  const dw = c.width - b.width;
  const dh = c.height - b.height;
  if (dw === 0 && dh === 0) return formatSizes(sm);
  const delta = dw !== 0 && dh !== 0 ? `${signed(dw)} wide, ${signed(dh)} tall` : dw !== 0 ? `${signed(dw)} wide` : signed(dh);
  return `${formatSizes(sm)} (${delta})`;
}
function describeSizeChange(sm) {
  const { baseline: b, candidate: c } = sm;
  const kind = sizeMismatchKind(sm);
  if (kind === "width") {
    const height = b.height !== c.height ? ` (and height ${b.height} \u2192 ${c.height})` : "";
    return `width changed ${b.width} \u2192 ${c.width}${height}: viewport or device scale differs`;
  }
  if (kind === "height") {
    const dh = c.height - b.height;
    return `page ${dh > 0 ? "grew" : "shrank"} ${Math.abs(dh)} px`;
  }
  return "dimensions unchanged";
}
function explainHeightChange(sm, context = {}) {
  const grew = sm.candidate.height > sm.baseline.height;
  const taller = grew ? "taller" : "shorter";
  const band = `every pixel of the ${grew ? "added" : "missing"} band at the bottom counts as changed`;
  const { dom, pageShift } = context;
  const parts = [];
  if (dom && !dom.changed) {
    if (dom.styleCheck === "mismatch") {
      parts.push(`no elements were added or removed, so restyled elements lay the same content out ${taller}`);
    } else if (dom.styleCheck === "match") {
      parts.push(`no elements were added or removed, so the same content is laid out ${taller} (often fonts or rendering that differ between machines)`);
    } else {
      parts.push(
        `no elements were added or removed, so the same content is laid out ${taller} (a stylesheet change, or fonts or rendering that differ between machines: styles were not compared)`
      );
    }
  }
  if (pageShift && pageShift.dy !== 0) {
    parts.push(`everything below y=${pageShift.belowY} moved ${pageShift.dy > 0 ? "down" : "up"} ${Math.abs(pageShift.dy)} px, so look above that line`, band);
  } else if (dom?.changed) {
    parts.push("the DOM summary says what changed", `${band}, but the change itself can be anywhere on the page`);
  } else if (!dom) {
    parts.push(`${band}, but the change itself can be anywhere on the page`);
  } else {
    parts.push(band);
  }
  return parts.join("; ");
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
  for (let i2 = 0; i2 < value.length; i2++) {
    hash ^= value.charCodeAt(i2);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ../packages/witness/src/report/environment.ts
function flatten(env) {
  const flat = /* @__PURE__ */ new Map();
  const put = (key, value) => {
    if (value === void 0 || value === null) return;
    flat.set(key, String(value));
  };
  for (const [section, value] of Object.entries(env)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [field, inner] of Object.entries(value)) {
        if (section === "render" && field === "viewport" && inner && typeof inner === "object") {
          const vp = inner;
          put("render.viewport", `${vp.width}x${vp.height}`);
        } else if (inner === null || typeof inner !== "object") {
          put(`${section}.${field}`, inner);
        }
      }
    } else {
      put(section, value);
    }
  }
  return flat;
}
var MECHANISMS = {
  cdp: "CDP",
  playwright: "Playwright",
  stitched: "scroll and stitch",
  firefox: "Firefox",
  webdriver: "WebDriver"
};
function describeCaptureMethod(method) {
  const m = /^(full-page|viewport):([a-z0-9-]+)$/.exec(method);
  if (!m) return method;
  return `${m[1] === "full-page" ? "full page" : "viewport"} (${MECHANISMS[m[2]] ?? m[2]})`;
}
var ORDER = [
  "browser",
  "browser.channel",
  "browser.headless",
  "os.platform",
  "os.distro",
  "os.release",
  "os.arch",
  "render.viewport",
  "render.deviceScaleFactor",
  "render.colorScheme",
  "render.reducedMotion",
  "render.locale",
  "render.timezone",
  "adapter.captureMethod",
  "container",
  "label"
];
var LABELS = {
  "browser.channel": "channel",
  "browser.headless": "headless",
  "os.platform": "OS",
  "os.release": "OS release",
  "os.arch": "arch",
  "render.viewport": "viewport",
  "render.deviceScaleFactor": "device scale",
  "render.colorScheme": "color scheme",
  "render.reducedMotion": "reduced motion",
  "render.locale": "locale",
  "render.timezone": "time zone",
  "ci.provider": "CI",
  "ci.runnerImage": "runner image",
  project: "project"
};
var yesNo = (v) => v === "true" ? "yes" : "no";
function describeEnvironmentChange(baseline, candidate, fields) {
  const a = flatten(baseline);
  const b = flatten(candidate);
  const set = new Set(fields);
  const parts = [];
  const rank = (key) => {
    const i2 = ORDER.indexOf(key);
    return i2 === -1 ? ORDER.length : i2;
  };
  if (set.has("browser.name") || set.has("browser.version")) {
    const side = (f, withName) => [withName ? f.get("browser.name") : void 0, f.get("browser.version")].filter(Boolean).join(" ");
    const sameName = a.get("browser.name") === b.get("browser.name");
    parts.push({ rank: rank("browser"), text: `${side(a, true)} \u2192 ${side(b, !sameName)}` });
  }
  for (const field of set) {
    if (field === "browser.name" || field === "browser.version") continue;
    const left = a.get(field);
    const right = b.get(field);
    let text2;
    if (field === "browser.headless" || field === "container") {
      text2 = `${field === "container" ? "container" : "headless"} ${yesNo(left)} \u2192 ${yesNo(right)}`;
    } else if (field === "label") {
      text2 = `environment label ${left || "none"} \u2192 ${right || "none"}`;
    } else if (field === "os.distro") {
      text2 = `${left ?? "unknown"} \u2192 ${right ?? "unknown"}`;
    } else if (field === "adapter.captureMethod") {
      text2 = `capture method ${describeCaptureMethod(left ?? "?")} \u2192 ${describeCaptureMethod(right ?? "?")}`;
    } else if (/^(framework|adapter|driver)\.version$/.test(field)) {
      const owner = field.split(".")[0];
      text2 = `${b.get(`${owner}.name`) ?? owner} ${left ?? "?"} \u2192 ${right ?? "?"}`;
    } else {
      text2 = `${LABELS[field] ?? field} ${left ?? "none"} \u2192 ${right ?? "none"}`;
    }
    parts.push({ rank: rank(field), text: text2 });
  }
  return parts.sort((x2, y) => x2.rank - y.rank).map((p) => p.text).join(", ");
}
var SIZE_FIELDS = ["render.viewport", "render.deviceScaleFactor", "adapter.captureMethod"];
function isRenderingDrift(snapshot) {
  if (snapshot.status !== "changed" && !(snapshot.status === "passed" && snapshot.autoPassed)) return false;
  const rendering = snapshot.environment?.renderingDelta ?? [];
  if (rendering.length === 0) return false;
  const dom = snapshot.dom;
  if (!dom || dom.changed || dom.styleCheck !== "match") return false;
  if (snapshot.sizeMismatch) return rendering.some((f) => SIZE_FIELDS.includes(f));
  return diffShape(snapshot).kind !== "concentrated";
}
function snapshotEnvironmentChange(snapshot) {
  const e = snapshot.environment;
  if (!e || e.renderingDelta.length === 0 || !e.baseline || !e.candidate) return null;
  return describeEnvironmentChange(e.baseline, e.candidate, e.renderingDelta);
}
function environmentChangeGroups(snapshots) {
  const groups = /* @__PURE__ */ new Map();
  for (const s of snapshots) {
    if (s.status !== "changed" && !(s.status === "passed" && s.autoPassed)) continue;
    const change = snapshotEnvironmentChange(s);
    if (!change) continue;
    const group = groups.get(change) ?? { change, snapshots: [], drift: [] };
    group.snapshots.push(s.name);
    if (isRenderingDrift(s)) group.drift.push(s.name);
    groups.set(change, group);
  }
  return [...groups.values()].sort((x2, y) => y.snapshots.length - x2.snapshots.length);
}
var plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function environmentChangeLine(group) {
  const n = group.snapshots.length;
  const d = group.drift.length;
  const head = `Environment changed since the baselines (${group.change})`;
  if (d === n) {
    return `${head}: ${plural(n, "diff is", "diffs are")} rendering drift (DOM and computed styles identical), not page changes; re-baseline ${n === 1 ? "it" : "them"} once the images are confirmed.`;
  }
  if (d === 0) {
    return `${head} for ${plural(n, "snapshot", "snapshots")}; each also has a change the environment does not explain, so review ${n === 1 ? "it" : "them"} on ${n === 1 ? "its" : "their"} own.`;
  }
  const rest = n - d;
  return `${head} for ${plural(n, "snapshot", "snapshots")}: ${d} ${d === 1 ? "is" : "are"} rendering drift (DOM and computed styles identical); ${rest} also ${rest === 1 ? "has" : "have"} a change the environment does not explain, review ${rest === 1 ? "it" : "them"} on ${rest === 1 ? "its" : "their"} own.`;
}

// src/status.ts
var STATUS_CONTEXT = "TestivAI / visual";
function resolveStatusContext(input) {
  return input.trim() || STATUS_CONTEXT;
}

// src/comment.ts
var UPSERT_MARKER = "<!-- testivai-visual-report -->";
var RUN_MARKER = /<!-- testivai-run:([A-Za-z0-9_-]+) -->/;
function readRunKey(body) {
  return RUN_MARKER.exec(body)?.[1];
}
function runMarkerLine(runKey) {
  const safe = (runKey ?? "").replace(/[^A-Za-z0-9_-]/g, "").replace(/-{2,}/g, "-");
  return safe ? `
<!-- testivai-run:${safe} -->` : "";
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
function snapshotUrl(reportUrl, name) {
  return `${reportUrl}#${snapshotAnchorId(name)}`;
}
function attr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function resolveUpsertMarker(statusContext) {
  if (statusContext === STATUS_CONTEXT) return UPSERT_MARKER;
  const safe = statusContext.replace(/-{2,}/g, "-").replace(/[<>]/g, "");
  return `<!-- testivai-visual-report:${safe} -->`;
}
function formatDiffPercent(snapshot) {
  const value = snapshot.diffPercent ?? snapshot.diffPercentage ?? 0;
  return value.toFixed(2);
}
function renderDomHintMarkdown(snapshot, include = {}) {
  const lines = [];
  const { size: withSize = true, identicalDom: withIdenticalDom = true } = include;
  const size = withSize ? snapshot.sizeMismatch : void 0;
  const heightChange = Boolean(size && sizeMismatchKind(size) === "height");
  if (size) {
    const change = `**Size changed \u2014 ${describeSizeChange(size)}** (${formatSizes(size)})`;
    if (!heightChange) {
      lines.push(`> ${change}, so this is not a page change; the diff is on a padded canvas and does not describe the page. Re-capture at the baseline's viewport and device scale, or re-baseline if the new size is intended.`);
    } else {
      const identical = Boolean(snapshot.dom && !snapshot.dom.changed);
      const closing = identical ? "Compare the images before approving." : "Compare the images and confirm the change is intended before approving.";
      lines.push(`> ${change}: ${explainHeightChange(size, { dom: snapshot.dom, pageShift: snapshot.pageShift })}. ${closing}`);
    }
  }
  const styleChanges = snapshot.dom?.styleCheck === "mismatch" ? snapshot.dom.styleChanges : void 0;
  const styleOnly = Boolean(styleChanges && !snapshot.dom?.changed);
  if (styleOnly && styleChanges) {
    const n = styleChanges.count;
    const first = styleChanges.elements[0];
    const el = first ? ` (\`${first.split(" > ").slice(-1)[0]}\`${n > 1 ? ", \u2026" : ""})` : "";
    lines.push(`> **Style-only change \u2014 real, not noise** \u2014 ${n} element${n === 1 ? "" : "s"} restyled with identical DOM${el}.`);
  }
  if (snapshot.pageShift && !(heightChange && snapshot.pageShift.dy !== 0)) {
    const p = snapshot.pageShift;
    lines.push(`> **Layout shift** \u2014 everything below y=${p.belowY} moved ${p.dy > 0 ? "down" : "up"} ${Math.abs(p.dy)}px (${p.count} elements together). Look *above* that line for inserted/removed content.`);
  }
  if (snapshot.dom && !styleOnly) {
    if (snapshot.dom.noiseHint && (size || !withIdenticalDom)) {
    } else if (snapshot.dom.noiseHint) {
      if (snapshot.dom.styleCheck === "match") {
        const shape = diffShape({ ...snapshot, diffPercent: snapshot.diffPercent ?? snapshot.diffPercentage });
        if (shape.kind === "concentrated") {
          lines.push(`> **DOM and styles unchanged, but the diff is concentrated in one area** \u2014 ${describeRegions(shape)}: a bad capture, or a change the style check does not cover (${STYLE_CHECK_DOES_NOT_COVER}). Compare the images before approving.`);
        } else if (shape.kind === "large") {
          lines.push(`> **DOM and styles unchanged, but the diff is large** \u2014 ${formatDiffPercent(snapshot)}% of pixels differ, spread across the page: more than render noise usually changes (often fonts or rendering that differ between machines). Compare the images before approving.`);
        } else {
          lines.push("> **DOM unchanged** \u2014 pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.");
        }
      } else {
        lines.push("> **DOM unchanged, styles not compared** \u2014 could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.");
      }
    } else {
      const s = snapshot.dom.summary;
      if (s) {
        const parts = [];
        if (s.added > 0) parts.push(`${s.added} added`);
        if (s.removed > 0) parts.push(`${s.removed} removed`);
        if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute change${s.attributeChanges === 1 ? "" : "s"}`);
        if (s.textChanges) parts.push(`${s.textChanges} text change${s.textChanges === 1 ? "" : "s"}`);
        const alsoRestyled = styleChanges ? ` Computed styles also changed on ${styleChanges.count} element${styleChanges.count === 1 ? "" : "s"} (${styleChanges.elements.slice(0, 3).map((p) => `\`${p.split(" > ").slice(-1)[0]}\``).join(", ")}${styleChanges.count > 3 ? ", \u2026" : ""}).` : "";
        lines.push(`> **DOM changed** \u2014 ${parts.join(", ") || "structural difference"}.${alsoRestyled}`);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") + "\n\n" : "";
}
function renderSnapshotHints(snapshot) {
  const change = snapshotEnvironmentChange(snapshot);
  if (!change) return renderDomHintMarkdown(snapshot);
  const env = snapshot.environment;
  if (env.policy === "strict") {
    return `> **Environment changed (strict policy)** \u2014 ${change} since the baseline; environmentPolicy "strict" makes it changed whatever its pixels say. Approving re-baselines it in this environment.

` + renderDomHintMarkdown(snapshot);
  }
  if (snapshot.sizeMismatch && env.baseline && env.candidate && env.renderingDelta.includes("adapter.captureMethod")) {
    const from = describeCaptureMethod(env.baseline.adapter.captureMethod);
    const to = describeCaptureMethod(env.candidate.adapter.captureMethod);
    return `> **Capture method changed** \u2014 ${from} \u2192 ${to} since the baseline (${formatSizes(snapshot.sizeMismatch)}): the size change comes from how the screenshot was taken, not from the page. Re-baseline with this capture method, or capture the way the baseline was.

` + renderDomHintMarkdown(snapshot, { size: false, identicalDom: false });
  }
  if (isRenderingDrift(snapshot)) {
    const size = snapshot.sizeMismatch ? ` That also explains the size change (${formatSizeMismatch(snapshot.sizeMismatch)}).` : "";
    return `> **Rendering drift** \u2014 ${change} since the baseline, and the DOM and computed styles are identical: the machine changed, not the page. Re-baseline once the images are confirmed to match apart from rendering.${size}

` + renderDomHintMarkdown(snapshot, { size: false, identicalDom: false });
  }
  return renderDomHintMarkdown(snapshot) + `> The environment also changed since the baseline (${change}), which can add rendering differences of its own.

`;
}
function buildComment(results, artifactUrl, marker = UPSERT_MARKER, links = {}) {
  const { summary, snapshots } = results;
  const reportUrl = safeReportUrl(links.reportUrl);
  const summaryLine = [
    `**${summary.passed} passed**`,
    `**${summary.changed} changed**`,
    `**${summary.newSnapshots} new**`
  ].join(" | ");
  let comment = `${marker}${runMarkerLine(links.runKey)}

### TestivAI Visual Report

${summaryLine} \u2014 **${summary.total} total**

`;
  if (reportUrl) {
    const zip = artifactUrl ? ` \xB7 or [download it as a ZIP](${artifactUrl})` : "";
    comment += `> **[Open the visual report](${reportUrl})** \u2014 baseline, current and diff side by side${zip}

`;
  } else if (artifactUrl) {
    comment += `> [Download visual report ZIP](${artifactUrl}) \u2014 contains baseline, current, and diff images

`;
  }
  for (const group of environmentChangeGroups(snapshots).filter((g) => g.snapshots.length >= 2)) {
    const line = environmentChangeLine(group).replace(/^Environment changed since the baselines/, "**Environment changed since the baselines**");
    const names = group.snapshots.slice(0, 10).map((n) => `\`${n}\``).join(", ") + (group.snapshots.length > 10 ? ", \u2026" : "");
    comment += `> ${line} Snapshots: ${names}.

`;
  }
  const missing = results.missingBaselines ?? [];
  if (missing.length > 0) {
    comment += `> **${missing.length} baseline${missing.length === 1 ? "" : "s"} received no capture this run** \u2014 ${missing.slice(0, 5).map((n) => `\`${n}\``).join(", ")}${missing.length > 5 ? ", \u2026" : ""}. If a test was removed intentionally, delete its baseline; otherwise coverage just shrank.

`;
  }
  const changedSnapshots = snapshots.filter((s) => s.status === "changed");
  if (changedSnapshots.length > 0) {
    comment += "#### Changed Snapshots\n\n";
    for (const snapshot of changedSnapshots) {
      const diffPercent = formatDiffPercent(snapshot);
      const domHint = renderSnapshotHints(snapshot);
      const size = snapshot.sizeMismatch ? ` \xB7 ${formatSizeMismatch(snapshot.sizeMismatch)}` : "";
      const open = reportUrl ? ` \xB7 <a href="${attr(snapshotUrl(reportUrl, snapshot.name))}">open in report</a>` : "";
      comment += `<details>
<summary><code>${snapshot.name}</code> \u2014 ${diffPercent}% different${size}${open}</summary>

${domHint}
\`\`\`
/testivai approve ${snapshot.name}
\`\`\`

</details>

`;
    }
    comment += `> To approve all at once: comment \`/testivai approve --all\` on this PR

`;
  }
  const newSnapshots = snapshots.filter((s) => s.status === "new");
  if (newSnapshots.length > 0) {
    comment += "#### New Snapshots\n\n";
    for (const snapshot of newSnapshots) {
      const open = reportUrl ? ` \u2014 [open](${snapshotUrl(reportUrl, snapshot.name)})` : "";
      comment += `- \`${snapshot.name}\`${open}
`;
    }
    comment += "\n";
  }
  comment += "---\n> Content that changes between runs (timestamps, ads, rotating images) can show up as a pixel diff unless you hide it with `ignoreSelectors` or exclude it with `mask`. An identical DOM points to render noise only when the styles are verified unchanged and the diff is small and scattered, as the hint then says; otherwise a stylesheet-only change, a bad capture, or a change the style check does not cover is not ruled out. Reviewing with an AI agent? [`@testivai/mcp`](https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md) serves this report as structured data (`explain_snapshot`).\n\n*Generated by [TestivAI](https://github.com/testivai/testivai-oss)*\n";
  return comment;
}
function buildEmptyComment(artifactUrl, marker = UPSERT_MARKER, links = {}) {
  const reportUrl = safeReportUrl(links.reportUrl);
  const link = reportUrl ? `
> **[Open the visual report](${reportUrl})**${artifactUrl ? ` \xB7 or [download it as a ZIP](${artifactUrl})` : ""}
` : artifactUrl ? `
> [Download visual report ZIP](${artifactUrl})
` : "";
  return `${marker}${runMarkerLine(links.runKey)}

### TestivAI Visual Report

No visual snapshots were captured in this test run.
${link}
---
*Generated by [TestivAI](https://testiv.ai)*
`;
}

// src/publish/api.ts
var PAGE = 100;
var MAX_LIST_PAGES = 10;
function statusOf(error) {
  return typeof error === "object" && error !== null && typeof error.status === "number" ? error.status : void 0;
}
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("the artifact download returned no data");
}
function octokitApi(github, owner, repo) {
  const base = { owner, repo };
  let fullName = `${owner}/${repo}`;
  const list2 = async (route, params, pick, maxPages) => {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await github.request(route, { ...base, ...params, per_page: PAGE, page });
      const batch = pick(data);
      items.push(...batch);
      if (batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  };
  return {
    async repo() {
      const { data } = await github.request("GET /repos/{owner}/{repo}", base);
      fullName = data.full_name;
      const visibility = data.visibility === "public" || data.visibility === "internal" ? data.visibility : data.private === false ? "public" : "private";
      return { id: data.id, fullName: data.full_name, visibility, defaultBranch: data.default_branch };
    },
    async pages() {
      try {
        const { data } = await github.request("GET /repos/{owner}/{repo}/pages", base);
        return {
          found: true,
          buildType: typeof data.build_type === "string" ? data.build_type : void 0,
          ...typeof data.public === "boolean" ? { public: data.public } : {},
          htmlUrl: typeof data.html_url === "string" ? data.html_url : void 0
        };
      } catch (error) {
        if (statusOf(error) === 404) return { found: false };
        throw error;
      }
    },
    async openPrs() {
      const { items } = await list2("GET /repos/{owner}/{repo}/pulls", { state: "open" }, (d) => d, MAX_LIST_PAGES);
      return items.filter((p) => p.head?.repo?.full_name).map((p) => ({
        number: p.number,
        headRepo: p.head.repo.full_name,
        headRepoId: p.head.repo.id,
        headRef: p.head.ref,
        headSha: p.head.sha,
        author: p.user?.login ?? "",
        fork: String(p.head.repo.full_name).toLowerCase() !== fullName.toLowerCase(),
        title: typeof p.title === "string" ? p.title : void 0,
        createdAt: typeof p.created_at === "string" ? p.created_at : void 0
      }));
    },
    async artifacts(name, maxPages) {
      const { items, truncated } = await list2("GET /repos/{owner}/{repo}/actions/artifacts", { name }, (d) => d.artifacts ?? [], maxPages);
      const artifacts = items.filter((a) => a.workflow_run?.id).map((a) => ({
        id: a.id,
        runId: a.workflow_run.id,
        name: a.name,
        sizeBytes: a.size_in_bytes,
        expired: a.expired === true,
        createdAt: a.created_at,
        headRepoId: a.workflow_run.head_repository_id,
        headBranch: a.workflow_run.head_branch,
        ...typeof a.digest === "string" ? { digest: a.digest } : {}
      }));
      return { artifacts, truncated };
    },
    async run(id) {
      try {
        const { data } = await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { ...base, run_id: id });
        return {
          id: data.id,
          attempt: data.run_attempt ?? 1,
          headRepo: data.head_repository?.full_name ?? "",
          headBranch: data.head_branch ?? "",
          headSha: data.head_sha ?? "",
          event: data.event ?? "",
          status: data.status ?? "",
          createdAt: data.created_at ?? ""
        };
      } catch (error) {
        if (statusOf(error) === 404) return void 0;
        throw error;
      }
    },
    async download(artifactId) {
      const { data } = await github.request("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}", {
        ...base,
        artifact_id: artifactId,
        archive_format: "zip"
      });
      return toBytes(data);
    },
    async comments(pr) {
      const { items } = await list2("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { issue_number: pr }, (d) => d, MAX_LIST_PAGES);
      return items.map((c) => ({ id: c.id, body: c.body ?? "", author: c.user?.login ?? "" }));
    },
    async createComment(pr, body) {
      await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...base, issue_number: pr, body });
    },
    async updateComment(id, body) {
      await github.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { ...base, comment_id: id, body });
    }
  };
}

// src/publish/build.ts
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// ../node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs
var import_module = require("module");
var require2 = (0, import_module.createRequire)("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j = b[i2]; j < b[i2 + 1]; ++j) {
      r[j] = j - b[i2] << 5 | i2;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb3, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb3);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le = new u16(mb3);
  for (i2 = 1; i2 < mb3; ++i2) {
    le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb3);
    var rvb = 15 - mb3;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb3 - cd[i2];
        var v = le[cd[i2] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i2 = 1; i2 < a.length; ++i2) {
    if (a[i2] > m)
      m = a[i2];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i2 = 0; i2 < hcLen; ++i2) {
          clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i2 = 0; i2 < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i2++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i2++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i2 = sym - 257, b = fleb[i2];
          add = bits(dat, pos, (1 << b) - 1) + fl[i2];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
var Inflate = /* @__PURE__ */ (function() {
  function Inflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
    this.s = { i: 0, b: dict ? dict.length : 0 };
    this.o = new u8(32768);
    this.p = new u8(0);
    if (dict)
      this.o.set(dict);
  }
  Inflate2.prototype.e = function(c) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    if (!this.p.length)
      this.p = c;
    else if (c.length) {
      var n = new u8(this.p.length + c.length);
      n.set(this.p), n.set(c, this.p.length), this.p = n;
    }
  };
  Inflate2.prototype.c = function(final) {
    this.s.i = +(this.d = final || false);
    var bts = this.s.b;
    var dt = inflt(this.p, this.s, this.o);
    this.ondata(slc(dt, bts, this.s.b), this.d);
    this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
    this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
  };
  Inflate2.prototype.push = function(chunk, final) {
    this.e(chunk), this.c(final);
  };
  return Inflate2;
})();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i2 = 0; ; ) {
    var c = d[i2++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i2 + eb > d.length)
      return { s: r, r: slc(d, i2 - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i2++] & 63) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i2++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i2 = 0; i2 < dat.length; i2 += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i2, i2 + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
var UnzipPassThrough = /* @__PURE__ */ (function() {
  function UnzipPassThrough2() {
  }
  UnzipPassThrough2.prototype.push = function(chunk, final) {
    this.ondata(null, chunk, final);
  };
  UnzipPassThrough2.compression = 0;
  return UnzipPassThrough2;
})();
var UnzipInflate = /* @__PURE__ */ (function() {
  function UnzipInflate2() {
    var _this = this;
    this.i = new Inflate(function(dat, final) {
      _this.ondata(null, dat, final);
    });
  }
  UnzipInflate2.prototype.push = function(chunk, final) {
    try {
      this.i.push(chunk, final);
    } catch (e) {
      this.ondata(e, null, final);
    }
  };
  UnzipInflate2.compression = 8;
  return UnzipInflate2;
})();
var Unzip = /* @__PURE__ */ (function() {
  function Unzip2(cb) {
    this.onfile = cb;
    this.k = [];
    this.o = {
      0: UnzipPassThrough
    };
    this.p = et;
  }
  Unzip2.prototype.push = function(chunk, final) {
    var _this = this;
    if (!this.onfile)
      err(5);
    if (!this.p)
      err(4);
    if (this.c > 0) {
      var len = Math.min(this.c, chunk.length);
      var toAdd = chunk.subarray(0, len);
      this.c -= len;
      if (this.d)
        this.d.push(toAdd, !this.c);
      else
        this.k[0].push(toAdd);
      chunk = chunk.subarray(len);
      if (chunk.length)
        return this.push(chunk, final);
    } else {
      var f = 0, i2 = 0, is = void 0, buf = void 0;
      if (!this.p.length)
        buf = chunk;
      else if (!chunk.length)
        buf = this.p;
      else {
        buf = new u8(this.p.length + chunk.length);
        buf.set(this.p), buf.set(chunk, this.p.length);
      }
      var l = buf.length, oc = this.c, add = oc && this.d;
      var _loop_2 = function() {
        var sig = b4(buf, i2);
        if (sig == 67324752) {
          f = 1, is = i2;
          this_1.d = null;
          this_1.c = 0;
          var bf = b2(buf, i2 + 6), cmp_1 = b2(buf, i2 + 8), u = bf & 2048, dd = bf & 8, fnl = b2(buf, i2 + 26), es = b2(buf, i2 + 28);
          if (l > i2 + 30 + fnl + es) {
            var chks_3 = [];
            this_1.k.unshift(chks_3);
            f = 2;
            var lsc = b4(buf, i2 + 18), lsu = b4(buf, i2 + 22);
            var fn_1 = strFromU8(buf.subarray(i2 + 30, i2 += 30 + fnl), !u);
            var _a2 = z64hs(buf, i2, es, 2, lsc, lsu, 0), sc_1 = _a2[0], su_1 = _a2[1], z64 = _a2[3];
            if (dd)
              sc_1 = -1 - z64;
            i2 += es;
            this_1.c = sc_1;
            var d_1;
            var file_1 = {
              name: fn_1,
              compression: cmp_1,
              start: function() {
                if (!file_1.ondata)
                  err(5);
                if (!sc_1)
                  file_1.ondata(null, et, true);
                else {
                  var ctr = _this.o[cmp_1];
                  if (!ctr)
                    file_1.ondata(err(14, "unknown compression type " + cmp_1, 1), null, false);
                  d_1 = sc_1 < 0 ? new ctr(fn_1) : new ctr(fn_1, sc_1, su_1);
                  d_1.ondata = function(err2, dat3, final2) {
                    file_1.ondata(err2, dat3, final2);
                  };
                  for (var _i = 0, chks_4 = chks_3; _i < chks_4.length; _i++) {
                    var dat2 = chks_4[_i];
                    d_1.push(dat2, false);
                  }
                  if (_this.k[0] == chks_3 && _this.c)
                    _this.d = d_1;
                  else
                    d_1.push(et, true);
                }
              },
              terminate: function() {
                if (d_1 && d_1.terminate)
                  d_1.terminate();
              }
            };
            if (sc_1 >= 0)
              file_1.size = sc_1, file_1.originalSize = su_1;
            this_1.onfile(file_1);
          }
          return "break";
        } else if (oc) {
          if (sig == 134695760) {
            is = i2 += 12 + (oc == -2 && 8), f = 3, this_1.c = 0;
            return "break";
          } else if (sig == 33639248) {
            is = i2 -= 4, f = 3, this_1.c = 0;
            return "break";
          }
        }
      };
      var this_1 = this;
      for (; i2 < l - 4; ++i2) {
        var state_1 = _loop_2();
        if (state_1 === "break")
          break;
      }
      this.p = et;
      if (oc < 0) {
        var dat = f ? buf.subarray(0, is - 12 - (oc == -2 && 8) - (b4(buf, is - 16) == 134695760 && 4)) : buf.subarray(0, i2);
        if (add)
          add.push(dat, !!f);
        else
          this.k[+(f == 2)].push(dat);
      }
      if (f & 2)
        return this.push(buf.subarray(i2), final);
      this.p = buf.subarray(i2);
    }
    if (final) {
      if (this.c)
        err(13);
      this.p = null;
    }
  };
  Unzip2.prototype.register = function(decoder) {
    this.o[decoder.compression] = decoder;
  };
  return Unzip2;
})();

// src/publish/archive.ts
var MB = 1024 * 1024;
var DEFAULT_ARCHIVE_LIMITS = {
  maxEntries: 5e4,
  maxTotalBytes: 400 * MB,
  maxImageBytes: 50 * MB,
  maxJsonBytes: 20 * MB
};
var ArchiveRefused = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "ArchiveRefused";
  }
};
var SLICE = 16 * 1024;
var IMAGE_PATH = /^images\/(.+)\/(baseline|current|diff)\.png$/;
function isPlainPath(name) {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/")) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function kindOf(name) {
  if (name === "results.json") return "results";
  if (name === "testivai-run.json") return "runStamp";
  if (isPlainPath(name) && IMAGE_PATH.test(name)) return "image";
  return void 0;
}
function readReportArchive(zip, limits = DEFAULT_ARCHIVE_LIMITS) {
  const out = { images: /* @__PURE__ */ new Map() };
  let entries = 0;
  let total = 0;
  let refusal;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    if (refusal) return;
    entries += 1;
    if (entries > limits.maxEntries) {
      refusal = new ArchiveRefused(`the report has more than ${limits.maxEntries} entries`);
      return;
    }
    const kind = kindOf(file.name);
    if (!kind) {
      file.ondata = () => {
      };
      return;
    }
    const cap = kind === "image" ? limits.maxImageBytes : limits.maxJsonBytes;
    if (file.originalSize !== void 0 && file.originalSize > cap) {
      refusal = new ArchiveRefused(`${file.name} is ${file.originalSize} bytes, over the ${cap}-byte limit`);
      file.ondata = () => {
      };
      return;
    }
    const chunks = [];
    let size = 0;
    file.ondata = (err2, chunk, final) => {
      if (refusal) return;
      if (err2) {
        refusal = new ArchiveRefused(`${file.name} could not be decompressed (${err2.message})`);
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > cap) {
        refusal = new ArchiveRefused(`${file.name} inflates past the ${cap}-byte limit (stopped after ${size} bytes)`);
        file.terminate();
        return;
      }
      if (total > limits.maxTotalBytes) {
        refusal = new ArchiveRefused(`the report inflates past the ${limits.maxTotalBytes}-byte limit`);
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const data = concat(chunks, size);
        if (kind === "image") out.images.set(file.name, data);
        else out[kind] = data;
      }
    };
    file.start();
  };
  for (let offset = 0; offset < zip.length && !refusal; offset += SLICE) {
    const end = Math.min(offset + SLICE, zip.length);
    try {
      unzip.push(zip.subarray(offset, end), end === zip.length);
    } catch (error) {
      refusal = new ArchiveRefused(`the report is not a readable ZIP (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (refusal) throw refusal;
  return out;
}
function concat(chunks, size) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// src/publish/cache.ts
var import_crypto = require("crypto");
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var DIGEST = /^sha256:([0-9a-f]{64})$/i;
var message = (error) => error instanceof Error ? error.message : String(error);
function sha256Of(digest) {
  const m = typeof digest === "string" ? DIGEST.exec(digest) : null;
  return m ? m[1].toLowerCase() : void 0;
}
var hex = (bytes) => (0, import_crypto.createHash)("sha256").update(bytes).digest("hex");
function entryName(artifactId) {
  return Number.isSafeInteger(artifactId) && artifactId > 0 ? `${artifactId}.zip` : void 0;
}
function openReportCache(dir, { log, maxEntryBytes }) {
  const stats = { hits: 0, hitBytes: 0, stored: 0, removed: 0 };
  const used = /* @__PURE__ */ new Set();
  let usable = true;
  try {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    usable = false;
    log.warning(`The report cache ${dir} is not used (${message(error)}): every report is downloaded.`);
  }
  const remove = (file) => {
    try {
      fs.rmSync(file, { recursive: true, force: true });
    } catch (error) {
      log.warning(`The report cache could not remove ${path.basename(file)} (${message(error)}).`);
    }
  };
  return {
    stats,
    read(artifactId, digest) {
      const name = entryName(artifactId);
      const want = sha256Of(digest);
      if (!usable || !name || !want) return void 0;
      const file = path.join(dir, name);
      let bytes;
      try {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!stat) return void 0;
        if (!stat.isFile() || stat.size > maxEntryBytes) {
          log.info(`Report cache: ${name} is not a report it could use: downloaded again.`);
          remove(file);
          return void 0;
        }
        bytes = fs.readFileSync(file);
      } catch (error) {
        log.info(`Report cache: ${name} could not be read (${message(error)}): downloaded again.`);
        remove(file);
        return void 0;
      }
      if (hex(bytes) !== want) {
        log.warning(`Report cache: ${name} is not the ZIP of artifact ${artifactId} (its SHA-256 is not the digest GitHub lists): downloaded again.`);
        remove(file);
        return void 0;
      }
      used.add(name);
      stats.hits += 1;
      stats.hitBytes += bytes.byteLength;
      return bytes;
    },
    write(artifactId, digest, zip) {
      const name = entryName(artifactId);
      const want = sha256Of(digest);
      if (!usable || !name || !want || zip.byteLength > maxEntryBytes) return;
      if (hex(zip) !== want) {
        log.warning(`The report downloaded for artifact ${artifactId} is not the one GitHub lists (its SHA-256 is not the digest): not kept in the report cache.`);
        return;
      }
      const file = path.join(dir, name);
      try {
        remove(file);
        fs.writeFileSync(file, zip, { flag: "wx" });
        used.add(name);
        stats.stored += 1;
      } catch (error) {
        log.warning(`Report cache: ${name} could not be written (${message(error)}).`);
        remove(file);
      }
    },
    prune() {
      if (!usable) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        log.warning(`The report cache could not be listed (${message(error)}).`);
        return;
      }
      for (const entry of entries) {
        if (used.has(entry.name) && entry.isFile()) continue;
        remove(path.join(dir, entry.name));
        stats.removed += 1;
      }
    }
  };
}

// src/publish/comments.ts
var FORK_MARKER = "<!-- testivai-published-report -->";
var BOT_LOGIN = "github-actions[bot]";
function runIdOf(key) {
  const m = key ? /^(\d+)-\d+$/.exec(key) : null;
  return m ? Number(m[1]) : void 0;
}
function commentFor(published, comments, marker) {
  const reporter = comments.find((c) => c.body.includes(marker) && readRunKey(c.body) !== void 0);
  if (reporter) return updateReporterComment(published, reporter, marker);
  if (!published.fork) return { kind: "none", why: `no TestivAI comment for run ${published.runId} on the pull request` };
  return forkComment(published, comments);
}
function updateReporterComment(published, comment, marker) {
  const runKey = readRunKey(comment.body);
  const described = runIdOf(runKey);
  if (described !== published.runId) {
    return { kind: "none", why: `the TestivAI comment describes run ${described ?? runKey}, not run ${published.runId}` };
  }
  if (!published.outcome.ok) {
    return { kind: "none", why: `the report of run ${published.runId} could not be shown, so the comment keeps its ZIP link` };
  }
  const { data } = published.outcome;
  const links = { reportUrl: published.url, runKey };
  const body = data.snapshots.length === 0 ? buildEmptyComment(published.artifactUrl, marker, links) : buildComment(data, published.artifactUrl, marker, links);
  if (body === comment.body) return { kind: "none", why: "the comment already links the report" };
  return { kind: "update", id: comment.id, body };
}
function forkComment(published, comments) {
  const body = forkCommentBody(published);
  const own = comments.find((c) => c.author === BOT_LOGIN && c.body.includes(FORK_MARKER));
  if (!own) return { kind: "create", body };
  const described = runIdOf(readRunKey(own.body));
  if (described !== void 0 && described > published.runId) {
    return { kind: "none", why: `the comment already describes a newer run (${described})` };
  }
  if (own.body === body) return { kind: "none", why: "the comment already links the report" };
  return { kind: "update", id: own.id, body };
}
function counts(s) {
  const parts = [];
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.newSnapshots) parts.push(`${s.newSnapshots} new`);
  if (s.missing) parts.push(`${s.missing} missing`);
  parts.push(`${s.passed} passed`);
  return parts.join(" \xB7 ");
}
function forkCommentBody(p) {
  const sha = /^[0-9a-f]{7,64}$/i.test(p.headSha) ? ` \xB7 commit ${p.headSha.slice(0, 7)}` : "";
  const run = `CI run ${Math.trunc(p.runId)}, attempt ${Math.trunc(p.attempt)}${sha}`;
  const lines = ["### TestivAI visual report", ""];
  if (p.outcome.ok) {
    lines.push(`**[Open the visual report](${p.url})** \xB7 ${run} \xB7 ${counts(p.outcome.summary)}`);
    lines.push("");
    lines.push(
      "This pull request comes from a fork, so its CI run could not comment here; TestivAI published its report instead. The page was rebuilt from the run's results and screenshots: TestivAI checked their format, but cannot vouch for what they show."
    );
  } else {
    lines.push(`The report of ${run} could not be shown; [the published page](${p.url}) says why and links the run's report ZIP.`);
    lines.push("");
    lines.push("This pull request comes from a fork, so its CI run could not comment here.");
  }
  lines.push("", FORK_MARKER, `<!-- testivai-run:${Math.trunc(p.runId)}-${Math.trunc(p.attempt)} -->`);
  return lines.join("\n");
}

// src/publish/pages.ts
var CONSENT_VARIABLE = "TESTIVAI_PUBLIC_REPORTS";
function decidePublish(input) {
  const { pages, repoVisibility, publicReportsConsent } = input;
  if (!pages.found) {
    return {
      publish: false,
      reason: 'GitHub Pages is not enabled for this repository, so reports are not published; the PR comment keeps the report ZIP. An admin can enable it under Settings \u2192 Pages, with the source "GitHub Actions".'
    };
  }
  if (pages.buildType !== "workflow") {
    return {
      publish: false,
      reason: 'GitHub Pages here builds from a branch, so reports are not published. An admin can set Settings \u2192 Pages \u2192 Source to "GitHub Actions" for TestivAI to publish them.'
    };
  }
  const siteUrl = pagesAddress(pages.htmlUrl);
  if (!siteUrl) {
    return {
      publish: false,
      reason: pages.htmlUrl ? `GitHub reports the Pages site at ${pages.htmlUrl}, which is not served over https, so reports are not published: their links must be https. An admin can turn on Settings \u2192 Pages \u2192 Enforce HTTPS.` : "GitHub did not report an address for the Pages site, so reports are not published."
    };
  }
  if (pages.public === false) {
    return {
      publish: true,
      siteUrl,
      visibility: "private",
      reason: "The Pages site is private: only people with read access to this repository can open the reports."
    };
  }
  if (repoVisibility !== "public" && publicReportsConsent !== "true") {
    return {
      publish: false,
      reason: `This repository is ${repoVisibility} but its GitHub Pages site is public, so published reports (screenshots included) would be readable by anyone on the internet. Reports are not published. An admin can allow it by setting the variable ${CONSENT_VARIABLE}=true on the github-pages environment (Settings \u2192 Environments \u2192 github-pages), or make the site private (GitHub Enterprise Cloud: Settings \u2192 Pages \u2192 Visibility).`
    };
  }
  return {
    publish: true,
    siteUrl,
    visibility: "public",
    reason: repoVisibility === "public" ? "The Pages site is public, like this repository." : `The Pages site is public; an admin allowed publishing this ${repoVisibility} repository's reports there (${CONSENT_VARIABLE}=true).`
  };
}
function pagesAddress(raw) {
  if (!raw || /[\s"'<>()`\\]/.test(raw)) return void 0;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return void 0;
  }
  const githubIo = url.hostname === "github.io" || url.hostname.endsWith(".github.io");
  if (url.protocol === "http:" && githubIo) url = new URL(`https://${url.href.slice("http://".length)}`);
  if (url.protocol !== "https:") return void 0;
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

// src/publish/plan.ts
var MB2 = 1024 * 1024;
var mb = (bytes) => `${Math.round(bytes / MB2)} MB`;
function planSite(input) {
  const { limits } = input;
  const dropped = [];
  const reportOf = /* @__PURE__ */ new Map();
  for (const a of input.artifacts) {
    if (a.name !== limits.artifactName || a.expired) continue;
    const current = reportOf.get(a.runId);
    if (!current || a.createdAt > current.createdAt || a.createdAt === current.createdAt && a.id > current.id) {
      reportOf.set(a.runId, a);
    }
  }
  const finished = input.runs.filter((r) => r.status === "completed" && reportOf.has(r.id)).sort((a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id);
  const planned = (r, dir, fork) => {
    const report = reportOf.get(r.id);
    return { runId: r.id, attempt: r.attempt, artifactId: report.id, sizeBytes: report.sizeBytes, dir, headSha: r.headSha, createdAt: r.createdAt, fork };
  };
  const mainRun = finished.find((r) => r.headRepo === input.repo && r.headBranch === input.defaultBranch);
  let main = mainRun ? planned(mainRun, "main", false) : void 0;
  let prs = [];
  for (const pr of input.prs) {
    const runs = [];
    const opened = Date.parse(pr.createdAt ?? "");
    for (const r of finished) {
      if (runs.length >= limits.runsPerPr) break;
      if (r.headRepo !== pr.headRepo || r.headBranch !== pr.headRef) continue;
      if (Date.parse(r.createdAt) < opened) continue;
      const entry = planned(r, `pr/${Math.trunc(pr.number)}/${Math.trunc(r.id)}-${Math.trunc(r.attempt)}`, pr.fork);
      if (entry.sizeBytes > limits.maxPrBytes) {
        dropped.push({ runId: r.id, pr: pr.number, reason: `its report is ${mb(entry.sizeBytes)}, over the ${mb(limits.maxPrBytes)} limit for one run` });
        continue;
      }
      runs.push(entry);
    }
    if (runs.length > 0) prs.push({ pr, runs });
  }
  const size = () => (main?.sizeBytes ?? 0) + prs.reduce((n, p) => n + p.runs.reduce((m, r) => m + r.sizeBytes, 0), 0);
  let total = size();
  if (total > limits.maxSiteBytes) {
    const candidates = prs.flatMap((p) => p.runs.map((r, i2) => ({ pr: p.pr.number, run: r, latest: i2 === 0 })));
    candidates.sort((a, b) => {
      if (a.latest !== b.latest) return a.latest ? 1 : -1;
      if (a.run.fork !== b.run.fork) return a.run.fork ? -1 : 1;
      return a.run.createdAt < b.run.createdAt ? -1 : a.run.createdAt > b.run.createdAt ? 1 : a.run.runId - b.run.runId;
    });
    const drop = /* @__PURE__ */ new Set();
    for (const c of candidates) {
      if (total <= limits.maxSiteBytes) break;
      drop.add(c.run);
      total -= c.run.sizeBytes;
      dropped.push({ runId: c.run.runId, pr: c.pr, reason: `the site would be over its ${mb(limits.maxSiteBytes)} budget` });
    }
    prs = prs.map((p) => ({ pr: p.pr, runs: p.runs.filter((r) => !drop.has(r)) })).filter((p) => p.runs.length > 0);
    if (main && total > limits.maxSiteBytes) {
      dropped.push({ runId: main.runId, reason: `the site would be over its ${mb(limits.maxSiteBytes)} budget` });
      total -= main.sizeBytes;
      main = void 0;
    }
  }
  return { ...main ? { main } : {}, prs, dropped, totalBytes: size() };
}

// ../packages/witness/src/report/template.ts
var REPORT_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
function renderHtml(data, options = {}) {
  const { summary, snapshots, version, timestamp } = data;
  const changed = snapshots.filter((s) => s.status === "changed");
  const newSnapshots = snapshots.filter((s) => s.status === "new");
  const passed = snapshots.filter((s) => s.status === "passed");
  const missing = data.missingBaselines ?? [];
  const envGroups = environmentChangeGroups(snapshots).filter((g) => g.snapshots.length >= 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${options.csp ? `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
  ` : ""}<meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${options.noindex ? '<meta name="robots" content="noindex, nofollow">\n  ' : ""}<title>TestivAI Visual Report</title>
  <style>
    /* \u2500\u2500 Theme tokens \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
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

    /* Notices at the top of a published report (run, pull request, fork) */
    .report-notice { background: var(--info-bg); border: 1px solid var(--border-soft); border-left: 4px solid var(--info); border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }
    .report-notice.warning { background: var(--new-bg); border-left-color: var(--new); }
    .report-notice a { color: var(--link); }

    /* Snapshot card */
    .snapshot { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 14px; padding: 20px; margin-bottom: 16px; box-shadow: var(--shadow); }
    .snapshot-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .snapshot-name { font-size: 15px; font-weight: 650; color: inherit; text-decoration: none; }
    .snapshot-name:hover { text-decoration: underline; }
    .snapshot:target { outline: 2px solid var(--accent); outline-offset: 2px; }
    .snapshot-badge { padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: capitalize; }
    .badge-changed { background: var(--changed-bg); color: var(--changed); }
    .badge-new { background: var(--new-bg); color: var(--new); }
    .badge-passed { background: var(--passed-bg); color: var(--passed); }
    .snapshot-stats { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }

    /* Layered analysis panel \u2014 the same evidence agents get via MCP */
    .analysis { border: 1px solid var(--border-soft); background: var(--surface-2); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
    .analysis-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .analysis-title { font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--text-muted); }
    .analysis-mcp { font-size: 10px; color: var(--text-muted); }
    .analysis-mcp code { background: var(--code-bg); border-radius: 3px; padding: 1px 4px; }
    .verdict { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; font-weight: 550; margin-bottom: 8px; }
    .verdict.v-noise { background: var(--info-bg); color: var(--info); border: 1px solid var(--info); border-color: color-mix(in srgb, var(--info) 30%, transparent); }
    /* Identical DOM, styles not compared: unknown, so a warning look (dashed = not verified), never the info-blue noise style */
    .verdict.v-unverified { background: var(--new-bg); color: var(--new); border: 1px dashed color-mix(in srgb, var(--new) 55%, transparent); }
    /* Identical DOM and styles, but a diff concentrated in one area or large: not noise, a warning look */
    .verdict.v-unexplained { background: var(--new-bg); color: var(--new); border: 1px solid color-mix(in srgb, var(--new) 30%, transparent); }
    .verdict.v-style { background: var(--new-bg); color: var(--new); border: 1px solid color-mix(in srgb, var(--new) 30%, transparent); }
    .verdict.v-drift { background: var(--info-bg); color: var(--info); border: 1px solid color-mix(in srgb, var(--info) 30%, transparent); }
    .env-notice { background: var(--info-bg); border: 1px solid color-mix(in srgb, var(--info) 30%, transparent); border-radius: 10px; padding: 14px 16px; margin-bottom: 24px; font-size: 13px; color: var(--info); }
    .env-notice code { background: var(--code-bg); border-radius: 3px; padding: 1px 5px; font-size: 12px; }
    .env-hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .verdict.v-size { background: var(--changed-bg); color: var(--changed); border: 1px solid color-mix(in srgb, var(--changed) 30%, transparent); }
    .verdict.v-structural { background: var(--changed-bg); color: var(--changed); border: 1px solid color-mix(in srgb, var(--changed) 30%, transparent); }
    .verdict.v-shift { background: var(--info-bg); color: var(--info); border: 1px solid color-mix(in srgb, var(--info) 30%, transparent); }
    .verdict.v-new { background: var(--new-bg); color: var(--new); border: 1px solid color-mix(in srgb, var(--new) 30%, transparent); }
    .verdict.v-pass { background: var(--passed-bg); color: var(--passed); border: 1px solid color-mix(in srgb, var(--passed) 30%, transparent); }
    .verdict code { background: var(--code-bg); border-radius: 3px; padding: 1px 4px; font-size: 12px; }

    /* DOM / style signal */
    .dom-hint { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 9px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
    .dom-hint.noise { background: var(--info-bg); color: var(--info); }
    .dom-hint.unverified { background: var(--new-bg); color: var(--new); border: 1px dashed color-mix(in srgb, var(--new) 55%, transparent); }
    .dom-hint.unexplained { background: var(--new-bg); color: var(--new); }
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
      .section, .snapshot { scroll-margin-top: 64px; }
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
    <button class="menu-toggle" id="menuToggle" aria-label="Toggle navigation" aria-expanded="false">\u2630</button>
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
      ${summary.changed > 0 ? `<li><a href="#changed">Changed <span class="count">${summary.changed}</span></a></li>` : ""}
      ${summary.newSnapshots > 0 ? `<li><a href="#new">New <span class="count">${summary.newSnapshots}</span></a></li>` : ""}
      ${summary.passed > 0 ? `<li><a href="#passed">Passed <span class="count">${summary.passed}</span></a></li>` : ""}
    </ul>

    <div class="cta">
      <h3>Reviewing with an AI agent?</h3>
      <p>The <code>@testivai/mcp</code> server gives Claude Code, Cursor, and any MCP client this report as structured data \u2014 including <code>explain_snapshot</code>, which attributes each diff to selectors and explains why it happened.</p>
      <a href="https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md" target="_blank">Agent setup guide</a>
    </div>

    <div class="oss-notice">
      <h4>Pixel-exact mode</h4>
      <p>Playwright, WebdriverIO, Selenium and <code>testivai witness</code> captures are stabilized by default (animations, transitions, caret, web fonts). Other dynamic content (timestamps, ads, rotating images) still shows up as a diff until you configure it.</p>
      <p>Noise is labeled, not removed: <strong>DOM unchanged</strong> with matching computed styles means likely render noise only when the diff is also small and scattered; a diff concentrated in one area, or over ${NOISE_MAX_DIFF_PERCENT}% of pixels, gets its own verdict. When styles were not compared, a stylesheet-only change is not ruled out.</p>
      <p>To reduce noise:<br>
        \u2022 Add <code>ignoreSelectors</code> or <code>mask</code> for dynamic elements<br>
        \u2022 For variable-height regions, ignore them with <code>mode: "collapse"</code> (<code>@testivai/witness-playwright</code> only)<br>
        \u2022 Raise <code>threshold</code>, or set <code>maxDiffPercent</code> / <code>maxDiffPixels</code> / <code>shiftTolerance</code> in <code>.testivai/config.json</code>
      </p>
    </div>
  </aside>

  <main class="main">
    ${renderNotices(options.notices ?? [])}
    ${envGroups.map(
    (g) => `
    <div class="env-notice">
      <div>${escapeHtml(environmentChangeLine(g))}</div>
      ${g.snapshots.slice(0, 20).map((n) => `<code>${escapeHtml(n)}</code>`).join(" ")}${g.snapshots.length > 20 ? " \u2026" : ""}
    </div>`
  ).join("")}
    ${missing.length > 0 ? `
    <div class="missing-notice">
      <div class="m-title">${missing.length} baseline${missing.length === 1 ? "" : "s"} received no capture this run</div>
      ${missing.map((n) => `<code>${escapeHtml(n)}</code>`).join(" ")}
      <div class="m-hint">A deleted or renamed test silently stops guarding its page. If intentional, remove the baseline (and commit); if this was a filtered run (<code>--grep</code>), ignore this notice.</div>
    </div>` : ""}
    ${summary.total === 0 ? `
    <div class="empty">
      
      <h2>No snapshots found</h2>
      <p>Run your tests to capture snapshots, then re-run the report.</p>
    </div>` : ""}

    ${changed.length > 0 ? `
    <section class="section" id="changed">
      <h2 class="section-title changed">Changed (${changed.length})</h2>
      ${changed.map((s) => renderSnapshot(s)).join("\n")}
    </section>` : ""}

    ${newSnapshots.length > 0 ? `
    <section class="section" id="new">
      <h2 class="section-title new">New (${newSnapshots.length})</h2>
      ${newSnapshots.map((s) => renderSnapshot(s)).join("\n")}
    </section>` : ""}

    ${passed.length > 0 ? `
    <section class="section" id="passed">
      <h2 class="section-title passed">Passed (${passed.length})</h2>
      ${passed.map((s) => renderSnapshot(s)).join("\n")}
    </section>` : ""}
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
function renderNotices(notices) {
  return notices.map((n) => {
    const links = (n.links ?? []).filter((l) => isHttpsUrl(l.href)).map((l) => ` \xB7 <a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join("");
    return `<div class="report-notice ${n.tone === "warning" ? "warning" : "info"}">${escapeHtml(n.text)}${links}</div>`;
  }).join("\n    ");
}
function isHttpsUrl(value) {
  if (/[\s"'<>`\\]/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
function renderSnapshot(snapshot) {
  const badgeClass = snapshot.status === "changed" ? "badge-changed" : snapshot.status === "new" ? "badge-new" : "badge-passed";
  const hasBaseline = !!snapshot.baselinePath;
  const hasDiff = !!snapshot.diffPath;
  const hasCurrent = !!snapshot.currentPath;
  let gridClass = "diff-view";
  if (hasBaseline && hasDiff && hasCurrent) gridClass += "";
  else if (hasCurrent && !hasBaseline) gridClass += " one-col";
  else gridClass += " two-col";
  const anchor = snapshotAnchorId(snapshot.name);
  return `
    <div class="snapshot" id="${anchor}">
      <div class="snapshot-header">
        <a class="snapshot-name" href="#${anchor}" title="Link to this snapshot">${escapeHtml(snapshot.name)}</a>
        <span class="snapshot-badge ${badgeClass}">${snapshot.status}</span>
      </div>
      ${renderStats(snapshot)}
      ${renderAnalysis(snapshot)}
      <div class="${gridClass}">
        ${hasBaseline ? `<div class="diff-col"><label>Baseline</label><img src="${escapeHtml(snapshot.baselinePath ?? "")}" alt="Baseline"></div>` : ""}
        ${hasDiff ? `<div class="diff-col"><label>Diff <span class="heat-legend" title="Heatmap: color = difference magnitude">subtle <span class="heat-bar"></span> strong</span></label><img src="${escapeHtml(snapshot.diffPath ?? "")}" alt="Diff heatmap"></div>` : ""}
        ${hasCurrent ? `<div class="diff-col"><label>Current</label><img src="${escapeHtml(snapshot.currentPath ?? "")}" alt="Current"></div>` : ""}
      </div>
      ${snapshot.status === "changed" || snapshot.status === "new" ? `
      <div class="approve-cmd">
        <code>npx testivai approve ${escapeHtml(snapshot.name)}</code>
        <button class="copy-btn" data-cmd="npx testivai approve ${escapeHtml(snapshot.name)}">Copy</button>
      </div>` : ""}
    </div>`;
}
function renderStats(snapshot) {
  const parts = [];
  if (snapshot.status === "changed" || snapshot.autoPassed) {
    parts.push(
      `Diff: ${snapshot.diffPercent.toFixed(2)}% (${snapshot.diffCount} pixels)${snapshot.autoPassed ? ` \u2014 auto-passed: ${autoPassNote(snapshot)}` : ""}`
    );
  }
  if (snapshot.sizeMismatch) {
    parts.push(escapeHtml(formatSizeMismatch(snapshot.sizeMismatch)));
  }
  if (snapshot.baselineApprovedAt) {
    const d = new Date(snapshot.baselineApprovedAt);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`baseline approved ${d.toISOString().slice(0, 10)}`);
    }
  }
  if (parts.length === 0) return "";
  return `<div class="snapshot-stats">${parts.join(" \xB7 ")}</div>`;
}
function autoPassNote(snapshot) {
  if (snapshot.autoPassed === "noise") {
    if (snapshot.dom?.styleCheck !== "match") return "DOM unchanged, styles not compared, within noise tolerance";
    return diffShape(snapshot).kind === "concentrated" ? "DOM and computed styles unchanged, within noise tolerance, but the diff is concentrated in one area" : "DOM and computed styles unchanged, within noise tolerance";
  }
  if (snapshot.autoPassed === "shift") return "pure element shifts within layout tolerance";
  return "within configured diff tolerance";
}
function renderAnalysis(snapshot) {
  const verdict = renderVerdict(snapshot);
  const layers = [renderDomHint(snapshot), renderEnvironment(snapshot), renderRegions(snapshot), renderMasks(snapshot)].filter(Boolean).join("");
  if (!verdict && !layers) return "";
  return `
      <div class="analysis">
        <div class="analysis-head">
          <span class="analysis-title">Layered analysis</span>
          <span class="analysis-mcp">agents get this via <code>@testivai/mcp</code> \xB7 <code>explain_snapshot</code></span>
        </div>
        ${verdict}
        ${layers}
      </div>`;
}
function renderVerdict(snapshot) {
  if (snapshot.status === "new") return baseVerdict(snapshot);
  const change = snapshotEnvironmentChange(snapshot);
  if (change && snapshot.environment?.policy === "strict") {
    return `<div class="verdict v-size"><span>Environment changed (strict policy) \u2014 ${escapeHtml(change)} since the baseline. environmentPolicy is "strict", so this snapshot is changed whatever its pixels say (${snapshot.diffPercent.toFixed(2)}% differ). Approve it to re-baseline in this environment, or capture it in the baseline's.</span></div>`;
  }
  const env = snapshot.environment;
  if (change && env?.baseline && env.candidate && snapshot.sizeMismatch && env.renderingDelta.includes("adapter.captureMethod")) {
    const from = describeCaptureMethod(env.baseline.adapter.captureMethod);
    const to = describeCaptureMethod(env.candidate.adapter.captureMethod);
    const dom = snapshot.dom?.changed && snapshot.dom.summary ? ` The DOM also changed (${escapeHtml(summarizeDom(snapshot.dom.summary))}): review that on its own.` : "";
    return `<div class="verdict v-drift"><span>Capture method changed \u2014 ${escapeHtml(from)} \u2192 ${escapeHtml(to)} since the baseline (${escapeHtml(formatSizes(snapshot.sizeMismatch))}): the size change comes from how the screenshot was taken, not from the page. Re-baseline with this capture method, or capture the way the baseline was.${dom}</span></div>`;
  }
  if (change && isRenderingDrift(snapshot)) {
    const size = snapshot.sizeMismatch ? `; that also explains the size change (${escapeHtml(formatSizeMismatch(snapshot.sizeMismatch))})` : "";
    const next = snapshot.status === "changed" ? "Re-baseline once the images are confirmed to match apart from rendering." : `Auto-passed by the '${escapeHtml(snapshot.autoPassed ?? "")}' criterion; re-baseline in this environment so the tolerance keeps measuring the page, not the machine.`;
    return `<div class="verdict v-drift"><span>Rendering drift \u2014 the environment changed since the baseline (${escapeHtml(change)}), and the DOM and computed styles are identical: the machine changed, not the page${size}. ${next}</span></div>`;
  }
  const base = baseVerdict(snapshot);
  if (change && base && (snapshot.status === "changed" || snapshot.autoPassed)) {
    const note = ` The environment also changed since the baseline (${escapeHtml(change)}), which can add rendering differences of its own.`;
    return base.replace(/<\/span><\/div>$/, `${note}</span></div>`);
  }
  return base;
}
function baseVerdict(snapshot) {
  if (snapshot.status === "passed" && !snapshot.autoPassed) {
    if (snapshot.dom?.changed && snapshot.dom.summary) {
      return `<div class="verdict v-pass"><span>Passed \u2014 nothing visible changed, but the DOM differs (${escapeHtml(summarizeDom(snapshot.dom.summary))}): hidden or off-screen content, or markup with no painted effect. Nothing to approve; worth knowing if the change was meant to be visible.</span></div>`;
    }
    return "";
  }
  if (snapshot.status === "new") {
    return `<div class="verdict v-new"><span>First capture \u2014 no baseline yet. Review the image, then approve to make it the baseline.</span></div>`;
  }
  if (snapshot.sizeMismatch) {
    const change = `${escapeHtml(describeSizeChange(snapshot.sizeMismatch))} (${escapeHtml(formatSizes(snapshot.sizeMismatch))})`;
    if (sizeMismatchKind(snapshot.sizeMismatch) === "width") {
      return `<div class="verdict v-size"><span>Size changed \u2014 ${change} between the two captures, so this is not a page change. Re-capture at the baseline's viewport and device scale, or re-baseline if the new size is intended.</span></div>`;
    }
    const identical = Boolean(snapshot.dom && !snapshot.dom.changed);
    const dom = snapshot.dom?.changed && snapshot.dom.summary ? `; DOM ${escapeHtml(summarizeDom(snapshot.dom.summary))}` : identical ? "; DOM identical" : "";
    const reading = escapeHtml(explainHeightChange(snapshot.sizeMismatch, { dom: snapshot.dom, pageShift: snapshot.pageShift }));
    const closing = identical ? "Compare the images before approving." : "Compare the images and confirm the change is intended before approving.";
    return `<div class="verdict v-size"><span>Size changed \u2014 ${change}${dom}: ${reading}. ${closing}</span></div>`;
  }
  if (snapshot.autoPassed && snapshot.dom?.changed && snapshot.dom.summary) {
    return `<div class="verdict v-pass"><span>Auto-passed via the <code>${escapeHtml(snapshot.autoPassed)}</code> criterion \u2014 within the configured tolerance, but the DOM differs (${escapeHtml(summarizeDom(snapshot.dom.summary))}). Nothing to approve; check the tolerance is meant to cover a markup change.</span></div>`;
  }
  if (snapshot.dom?.styleCheck === "mismatch" && snapshot.dom.styleChanges && !snapshot.dom.changed) {
    const n = snapshot.dom.styleChanges.count;
    const first = snapshot.dom.styleChanges.elements[0];
    const el = first ? `<code>${escapeHtml(first.split(" > ").slice(-1)[0])}</code>` : "";
    return `<div class="verdict v-style"><span>Style-only change \u2014 a real change, not noise: ${n} element${n === 1 ? "" : "s"} restyled with identical DOM${el ? ` (${el}${n > 1 ? ", \u2026" : ""})` : ""}. Confirm it's intended before approving.</span></div>`;
  }
  if (snapshot.pageShift) {
    const p = snapshot.pageShift;
    return `<div class="verdict v-shift"><span>Layout shift \u2014 everything below y=${p.belowY} moved ${p.dy > 0 ? "down" : "up"} ${Math.abs(p.dy)}px (${p.count} elements together). Look <em>above</em> that line for inserted or removed content; the moved elements themselves are unchanged.</span></div>`;
  }
  if (snapshot.dom?.changed && snapshot.dom.summary) {
    return `<div class="verdict v-structural"><span>Structural change \u2014 the DOM differs (${escapeHtml(summarizeDom(snapshot.dom.summary))}). Review the diff and confirm the change is intended before approving.</span></div>`;
  }
  if (snapshot.dom?.noiseHint) {
    if (snapshot.dom.styleCheck === "match") {
      const shape = diffShape(snapshot);
      const next = snapshot.status === "changed" ? "Compare the images before approving." : "Compare the images before relying on the auto-pass.";
      if (shape.kind === "concentrated") {
        return `<div class="verdict v-unexplained"><span>Diff concentrated in one area \u2014 the DOM and computed styles are identical, but ${describeRegions(shape)}, changed. Render noise is small and scattered, so this is a bad capture, or a change the style check does not cover (${STYLE_CHECK_DOES_NOT_COVER}). ${next}</span></div>`;
      }
      if (shape.kind === "large") {
        return `<div class="verdict v-unexplained"><span>Large diff \u2014 the DOM and computed styles are identical, but ${snapshot.diffPercent.toFixed(2)}% of pixels differ, spread across the page: more than render noise usually changes. Often fonts or rendering that differ between the machines that captured the baseline and the current image; it can also be a bad capture or a change the style check does not cover (${STYLE_CHECK_DOES_NOT_COVER}). ${next}</span></div>`;
      }
      return `<div class="verdict v-noise"><span>Likely render noise \u2014 pixels differ but the DOM and computed styles are identical and the diff is small and scattered (anti-aliasing, font hinting). Worth a glance, not a block.</span></div>`;
    }
    return `<div class="verdict v-unverified"><span>Styles not compared \u2014 could be render noise or a stylesheet-only change: pixels differ and the DOM is identical, but computed styles were not compared (no comparable style digests on both sides), so a stylesheet-only change is not ruled out. Compare the images before approving.</span></div>`;
  }
  if (snapshot.autoPassed) {
    return `<div class="verdict v-pass"><span>Auto-passed via the <code>${escapeHtml(snapshot.autoPassed)}</code> criterion \u2014 reported for transparency, no action needed.</span></div>`;
  }
  return "";
}
function summarizeDom(s) {
  const parts = [];
  if (s.added > 0) parts.push(`${s.added} added`);
  if (s.removed > 0) parts.push(`${s.removed} removed`);
  if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute`);
  if (s.textChanges) parts.push(`${s.textChanges} text`);
  return parts.join(", ") || "structural difference";
}
function renderDomHint(snapshot) {
  if (!snapshot.dom) return "";
  const styleChanges = snapshot.dom.styleCheck === "mismatch" ? snapshot.dom.styleChanges : void 0;
  const restyled = styleChanges ? `${styleChanges.elements.slice(0, 3).map((p) => `<code>${escapeHtml(p.split(" > ").slice(-1)[0])}</code>`).join(", ")}${styleChanges.count > 3 ? ", \u2026" : ""}` : "";
  if (styleChanges && !snapshot.dom.changed) {
    const els = restyled;
    const n = styleChanges.count;
    return `
      <div class="dom-hint style-changed" title="DOM structure is identical but computed styles differ \u2014 a stylesheet-level change, not render noise.">
        <span class="label">Styles changed</span>
        <span class="summary">\u2014 ${n} element${n === 1 ? "" : "s"} restyled with identical DOM: ${els}.</span>
      </div>`;
  }
  if (snapshot.dom.noiseHint) {
    if (snapshot.dom.styleCheck === "match") {
      if (isRenderingDrift(snapshot)) {
        return `
      <div class="dom-hint noise" title="DOM tree and computed styles are identical, and the environment the page was captured in changed since the baseline.">
        <span class="label">DOM unchanged</span>
        <span class="summary">\u2014 styles verified unchanged; the environment changed since the baseline, so the pixel diff is rendering drift.</span>
      </div>`;
      }
      const shape = diffShape(snapshot);
      if (shape.kind === "concentrated") {
        return `
      <div class="dom-hint unexplained" title="DOM tree and computed styles are identical, but the pixel diff sits in one area, which render noise does not do.">
        <span class="label">DOM and styles unchanged, diff in one area</span>
        <span class="summary">\u2014 ${describeRegions(shape)}: a bad capture, or a change the style check does not cover. Compare the images.</span>
      </div>`;
      }
      if (shape.kind === "large") {
        return `
      <div class="dom-hint unexplained" title="DOM tree and computed styles are identical, but more pixels differ than render noise usually changes.">
        <span class="label">DOM and styles unchanged, large diff</span>
        <span class="summary">\u2014 ${snapshot.diffPercent.toFixed(2)}% of pixels differ, spread across the page. Compare the images.</span>
      </div>`;
      }
      return `
      <div class="dom-hint noise" title="DOM tree and computed styles are identical between baseline and candidate, and the diff is small and scattered; the pixel diff is likely render noise.">
        <span class="label">DOM unchanged</span>
        <span class="summary">\u2014 pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.</span>
      </div>`;
    }
    return `
      <div class="dom-hint unverified" title="DOM tree is identical between baseline and candidate, but computed styles were not compared, so a stylesheet-only change is not ruled out.">
        <span class="label">DOM unchanged, styles not compared</span>
        <span class="summary">\u2014 could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.</span>
      </div>`;
  }
  const s = snapshot.dom.summary;
  if (!s) return "";
  const parts = [];
  if (s.added > 0) parts.push(`${s.added} added`);
  if (s.removed > 0) parts.push(`${s.removed} removed`);
  if (s.attributeChanges > 0) parts.push(`${s.attributeChanges} attribute change${s.attributeChanges === 1 ? "" : "s"}`);
  if (s.textChanges) parts.push(`${s.textChanges} text change${s.textChanges === 1 ? "" : "s"}`);
  const alsoRestyled = styleChanges ? ` Computed styles also changed on ${styleChanges.count} element${styleChanges.count === 1 ? "" : "s"}: ${restyled}.` : "";
  return `
    <div class="dom-hint changed" title="Structural DOM changes detected alongside the pixel diff.">
      <span class="label">DOM changed</span>
      <span class="summary">\u2014 ${escapeHtml(parts.join(", ") || "structural difference")}.${alsoRestyled}</span>
    </div>`;
}
function renderEnvironment(snapshot) {
  const env = snapshot.environment;
  if (!env || env.delta.length === 0 || !env.baseline || !env.candidate) return "";
  const context = env.delta.filter((f) => !env.renderingDelta.includes(f));
  const parts = [];
  if (env.renderingDelta.length > 0) parts.push(describeEnvironmentChange(env.baseline, env.candidate, env.renderingDelta));
  if (context.length > 0) parts.push(`context: ${describeEnvironmentChange(env.baseline, env.candidate, context)}`);
  return `
      <div class="env-hint">Environment changed since the baseline \u2014 ${escapeHtml(parts.join(" \xB7 "))}</div>`;
}
function renderRegions(snapshot) {
  const regions = snapshot.regions ?? [];
  if (regions.length === 0 || snapshot.status === "new") return "";
  const describe = (r) => {
    const el = r.elements?.[0];
    if (!el) return `${r.width}\xD7${r.height} @ (${r.x}, ${r.y})`;
    const selector = escapeHtml(el.selector.split(" > ").slice(-1)[0]);
    if (r.classification === "shift" && r.shift) {
      const parts = [];
      if (r.shift.dy !== 0) parts.push(`${r.shift.dy > 0 ? "+" : ""}${r.shift.dy}px vertically`);
      if (r.shift.dx !== 0) parts.push(`${r.shift.dx > 0 ? "+" : ""}${r.shift.dx}px horizontally`);
      return `${selector} shifted ${parts.join(", ")} \u2014 content unchanged`;
    }
    return `${selector} changed (${r.width}\xD7${r.height} @ ${r.x}, ${r.y})`;
  };
  const chips = regions.map(
    (r, i2) => `<li><a href="#" class="region-chip${r.classification === "shift" ? " region-shift" : ""}" data-diff="${escapeHtml(snapshot.diffPath ?? "")}" title="${r.diffPixels} changed pixels${r.elements?.[0] ? " \u2014 " + escapeHtml(r.elements[0].selector) : ""}">#${i2 + 1} \xB7 ${describe(r)}</a></li>`
  ).join("");
  const shifted = regions.filter((r) => r.classification === "shift").length;
  const title = shifted > 0 ? `${regions.length} changed region${regions.length === 1 ? "" : "s"} (${shifted} shifted)` : `${regions.length} changed region${regions.length === 1 ? "" : "s"}`;
  const pageShift = snapshot.pageShift ? `<div class="page-shift">\u2195 Everything below y=${snapshot.pageShift.belowY} shifted ${snapshot.pageShift.dy > 0 ? "+" : ""}${snapshot.pageShift.dy}px (${snapshot.pageShift.count} elements moved together \u2014 typically an inserted banner or expanded section above).</div>` : "";
  return `
      <div class="regions">
        <div class="regions-title">${title}</div>
        <ul>${chips}</ul>
        ${pageShift}
      </div>`;
}
function renderMasks(snapshot) {
  const masks = snapshot.masks ?? [];
  const warnings = snapshot.maskWarnings ?? [];
  if (masks.length === 0 && warnings.length === 0) return "";
  const describe = (m) => {
    const src = m.source.type === "selector" ? `selector <code>${escapeHtml(String(m.source.spec))}</code>` : m.source.type === "edge" ? `edge <code>${escapeHtml(JSON.stringify(m.source.spec))}</code>` : `region <code>${escapeHtml(JSON.stringify(m.source.spec))}</code>`;
    return `${src} \u2192 ${m.width}\xD7${m.height} @ (${m.x}, ${m.y}) <em>(${escapeHtml(m.source.origin)})</em>`;
  };
  const maskBlock = masks.length > 0 ? `
      <div class="masks" title="Masked areas are excluded from the pixel diff and hatched in the diff image.">
        <span class="label">${masks.length} mask${masks.length === 1 ? "" : "s"} applied</span>
        \u2014 ${masks.map(describe).join("; ")}
      </div>` : "";
  const warningBlock = warnings.length > 0 ? `
      <div class="mask-warning">${warnings.map((w) => escapeHtml(w)).join("<br>")}</div>` : "";
  return maskBlock + warningBlock;
}
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ../packages/witness/src/report/validate.ts
var SUPPORTED_SCHEMA_MAJOR = 2;
var REPORT_DATA_LIMITS = {
  snapshots: 5e3,
  nameLength: 300,
  textLength: 2e3,
  regions: 1e3,
  elementsPerRegion: 10,
  styleElements: 200,
  masks: 500,
  maskWarnings: 200,
  maskSpecKeys: 50,
  missingBaselines: 5e3,
  environmentKeys: 20,
  environmentValueLength: 200,
  environmentFields: 100
};
function parseReportData(json) {
  try {
    return { ok: true, data: readReport(json) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.message };
    throw error;
  }
}
var Invalid = class extends Error {
};
function fail(path4, problem) {
  throw new Invalid(`${path4 || "results.json"}: ${problem}`);
}
function at(path4, key) {
  return path4 ? `${path4}.${key}` : key;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value, path4) {
  if (!isRecord(value)) fail(path4, "expected an object");
  return value;
}
function num(value, path4, opts = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path4, "expected a finite number");
  if (opts.min !== void 0 && value < opts.min) fail(path4, `expected at least ${opts.min}`);
  if (opts.whole && !Number.isInteger(value)) fail(path4, "expected a whole number");
  return value;
}
function count(value, path4) {
  return num(value, path4, { min: 0, whole: true });
}
function text(value, path4, max2 = REPORT_DATA_LIMITS.textLength, min = 0) {
  if (typeof value !== "string") fail(path4, "expected text");
  if (value.length < min) fail(path4, "expected non-empty text");
  if (value.length > max2) fail(path4, `longer than ${max2} characters`);
  return value;
}
function bool(value, path4) {
  if (typeof value !== "boolean") fail(path4, "expected true or false");
  return value;
}
function oneOf(value, path4, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path4, `expected one of ${allowed.join(", ")}`);
  }
  return value;
}
function list(value, path4, max2, item) {
  if (!Array.isArray(value)) fail(path4, "expected a list");
  if (value.length > max2) fail(path4, `more than ${max2} items`);
  return value.map((v, i2) => item(v, `${path4}[${i2}]`));
}
function optional(target, key, source, path4, read) {
  const value = source[key];
  if (value !== void 0) target[key] = read(value, at(path4, key));
}
function readReport(json) {
  const root = record(json, "");
  const version = text(root.version, "version", 32);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail("version", "expected a schema version like 2.4.0");
  const major = Number(match[1]);
  if (major > SUPPORTED_SCHEMA_MAJOR) {
    fail("version", `format ${version} is newer than this TestivAI can show (it reads ${SUPPORTED_SCHEMA_MAJOR}.x); open the report ZIP, or update TestivAI`);
  }
  if (major < SUPPORTED_SCHEMA_MAJOR) {
    fail("version", `format ${version} is older than this TestivAI can show (it reads ${SUPPORTED_SCHEMA_MAJOR}.x); open the report ZIP`);
  }
  const data = {
    version,
    timestamp: text(root.timestamp, "timestamp", 64),
    summary: readSummary(root.summary, "summary"),
    snapshots: list(root.snapshots, "snapshots", REPORT_DATA_LIMITS.snapshots, readSnapshot)
  };
  optional(
    data,
    "missingBaselines",
    root,
    "",
    (v, p) => list(v, p, REPORT_DATA_LIMITS.missingBaselines, (n, q) => text(n, q, REPORT_DATA_LIMITS.nameLength, 1))
  );
  optional(data, "environment", root, "", (v, p) => readEnvironmentBlock(v, p));
  return data;
}
function readSummary(value, path4) {
  const s = record(value, path4);
  const summary = {
    total: count(s.total, at(path4, "total")),
    passed: count(s.passed, at(path4, "passed")),
    changed: count(s.changed, at(path4, "changed")),
    newSnapshots: count(s.newSnapshots, at(path4, "newSnapshots"))
  };
  optional(summary, "missing", s, path4, count);
  return summary;
}
var STATUSES = ["passed", "changed", "new"];
function readSnapshot(value, path4) {
  const s = record(value, path4);
  const snapshot = {
    name: text(s.name, at(path4, "name"), REPORT_DATA_LIMITS.nameLength, 1),
    status: oneOf(s.status, at(path4, "status"), STATUSES),
    diffPercent: num(s.diffPercent, at(path4, "diffPercent"), { min: 0 }),
    diffCount: count(s.diffCount, at(path4, "diffCount")),
    totalPixels: count(s.totalPixels, at(path4, "totalPixels"))
  };
  optional(snapshot, "dom", s, path4, readDom);
  optional(snapshot, "regions", s, path4, (v, p) => list(v, p, REPORT_DATA_LIMITS.regions, readRegion));
  optional(snapshot, "masks", s, path4, (v, p) => list(v, p, REPORT_DATA_LIMITS.masks, readMask));
  optional(snapshot, "maskWarnings", s, path4, (v, p) => list(v, p, REPORT_DATA_LIMITS.maskWarnings, (w, q) => text(w, q)));
  optional(snapshot, "pageShift", s, path4, readPageShift);
  optional(snapshot, "autoPassed", s, path4, (v, p) => oneOf(v, p, ["threshold", "noise", "shift"]));
  optional(snapshot, "baselineApprovedAt", s, path4, (v, p) => text(v, p, 64));
  optional(snapshot, "sizeMismatch", s, path4, readSizeMismatch);
  optional(snapshot, "environment", s, path4, readSnapshotEnvironment);
  return snapshot;
}
function readSnapshotEnvironment(value, path4) {
  const e = record(value, path4);
  const fields = (v, p) => list(v, p, REPORT_DATA_LIMITS.environmentFields, (f, q) => text(f, q, 100, 1));
  const env = {
    delta: fields(e.delta, at(path4, "delta")),
    renderingDelta: fields(e.renderingDelta, at(path4, "renderingDelta"))
  };
  optional(env, "baseline", e, path4, readCaptureEnvironment);
  optional(env, "candidate", e, path4, readCaptureEnvironment);
  optional(env, "policy", e, path4, (v, p) => oneOf(v, p, ["strict"]));
  return env;
}
function readCaptureEnvironment(value, path4) {
  const block = readEnvironmentBlock(value, path4);
  const section = (name) => record(block[name], at(path4, name));
  text(section("os").platform, at(path4, "os.platform"), REPORT_DATA_LIMITS.environmentValueLength, 1);
  text(section("browser").name, at(path4, "browser.name"), REPORT_DATA_LIMITS.environmentValueLength, 1);
  text(section("adapter").captureMethod, at(path4, "adapter.captureMethod"), REPORT_DATA_LIMITS.environmentValueLength, 1);
  return block;
}
var ENVIRONMENT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
function readEnvironmentBlock(value, path4) {
  const plain = (v, p) => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return num(v, p);
    if (typeof v === "string") return text(v, p, REPORT_DATA_LIMITS.environmentValueLength);
    fail(p, "expected text, a number, true/false or null");
  };
  const keys = (o, p) => {
    const k = Object.keys(o);
    if (k.length > REPORT_DATA_LIMITS.environmentKeys) fail(p, `more than ${REPORT_DATA_LIMITS.environmentKeys} fields`);
    for (const key of k) if (!ENVIRONMENT_KEY.test(key)) fail(p, `field name ${JSON.stringify(key.slice(0, 50))} is not a plain name`);
    return k;
  };
  const block = record(value, path4);
  const out = {};
  for (const sectionName of keys(block, path4)) {
    const sectionPath = at(path4, sectionName);
    const section = block[sectionName];
    if (!isRecord(section)) {
      out[sectionName] = plain(section, sectionPath);
      continue;
    }
    const inner = {};
    for (const field of keys(section, sectionPath)) {
      const fieldPath = at(sectionPath, field);
      const v = section[field];
      if (sectionName === "render" && field === "viewport") {
        const vp = record(v, fieldPath);
        inner[field] = { width: num(vp.width, at(fieldPath, "width"), { min: 0 }), height: num(vp.height, at(fieldPath, "height"), { min: 0 }) };
      } else {
        inner[field] = plain(v, fieldPath);
      }
    }
    out[sectionName] = inner;
  }
  return out;
}
function readDom(value, path4) {
  const d = record(value, path4);
  const dom = {
    changed: bool(d.changed, at(path4, "changed")),
    noiseHint: bool(d.noiseHint, at(path4, "noiseHint")),
    summary: d.summary === void 0 || d.summary === null ? null : readDomSummary(d.summary, at(path4, "summary"))
  };
  optional(dom, "styleCheck", d, path4, (v, p) => oneOf(v, p, ["match", "mismatch", "unavailable"]));
  optional(dom, "styleChanges", d, path4, (v, p) => {
    const c = record(v, p);
    return {
      count: count(c.count, at(p, "count")),
      elements: list(c.elements, at(p, "elements"), REPORT_DATA_LIMITS.styleElements, (e, q) => text(e, q))
    };
  });
  return dom;
}
function readDomSummary(value, path4) {
  const s = record(value, path4);
  const summary = {
    added: count(s.added, at(path4, "added")),
    removed: count(s.removed, at(path4, "removed")),
    attributeChanges: count(s.attributeChanges, at(path4, "attributeChanges"))
  };
  optional(summary, "textChanges", s, path4, count);
  return summary;
}
function readRegion(value, path4) {
  const r = record(value, path4);
  const region = {
    x: num(r.x, at(path4, "x")),
    y: num(r.y, at(path4, "y")),
    width: num(r.width, at(path4, "width"), { min: 0 }),
    height: num(r.height, at(path4, "height"), { min: 0 }),
    diffPixels: num(r.diffPixels, at(path4, "diffPixels"), { min: 0 }),
    diffPercent: num(r.diffPercent, at(path4, "diffPercent"), { min: 0 })
  };
  optional(region, "classification", r, path4, (v, p) => oneOf(v, p, ["shift", "change"]));
  optional(region, "shift", r, path4, (v, p) => {
    const s = record(v, p);
    return { dx: num(s.dx, at(p, "dx")), dy: num(s.dy, at(p, "dy")) };
  });
  optional(
    region,
    "elements",
    r,
    path4,
    (v, p) => list(v, p, REPORT_DATA_LIMITS.elementsPerRegion, (e, q) => {
      const el = record(e, q);
      return { selector: text(el.selector, at(q, "selector")), role: oneOf(el.role, at(q, "role"), ["shifted", "changed"]) };
    })
  );
  return region;
}
function readMask(value, path4) {
  const m = record(value, path4);
  const source = record(m.source, at(path4, "source"));
  const sourcePath = at(path4, "source");
  const mask = {
    x: num(m.x, at(path4, "x")),
    y: num(m.y, at(path4, "y")),
    width: num(m.width, at(path4, "width"), { min: 0 }),
    height: num(m.height, at(path4, "height"), { min: 0 }),
    source: {
      type: oneOf(source.type, at(sourcePath, "type"), ["selector", "region", "edge"]),
      spec: readMaskSpec(source.spec, at(sourcePath, "spec")),
      origin: oneOf(source.origin, at(sourcePath, "origin"), ["config", "call"])
    }
  };
  return mask;
}
function readMaskSpec(value, path4) {
  if (typeof value === "string") return text(value, path4);
  const spec = record(value, path4);
  const keys = Object.keys(spec);
  if (keys.length > REPORT_DATA_LIMITS.maskSpecKeys) fail(path4, `more than ${REPORT_DATA_LIMITS.maskSpecKeys} keys`);
  const out = {};
  for (const key of keys) {
    text(key, `${path4} key`, 50, 1);
    const v = spec[key];
    out[key] = typeof v === "number" ? num(v, at(path4, key)) : text(v, at(path4, key), 200);
  }
  return out;
}
function readPageShift(value, path4) {
  const p = record(value, path4);
  return { dy: num(p.dy, at(path4, "dy")), belowY: num(p.belowY, at(path4, "belowY")), count: count(p.count, at(path4, "count")) };
}
function readSizeMismatch(value, path4) {
  const s = record(value, path4);
  const size = (v, p) => {
    const d = record(v, p);
    return { width: num(d.width, at(p, "width"), { min: 1 }), height: num(d.height, at(p, "height"), { min: 1 }) };
  };
  return { baseline: size(s.baseline, at(path4, "baseline")), candidate: size(s.candidate, at(path4, "candidate")) };
}

// src/report-artifact.ts
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
function staleReport(stamp, env) {
  if (!stamp || !env.GITHUB_RUN_ID || stamp.runId !== env.GITHUB_RUN_ID) return null;
  const thisAttempt = Number(env.GITHUB_RUN_ATTEMPT || "1");
  return stamp.runAttempt < thisAttempt ? { reportAttempt: stamp.runAttempt, thisAttempt } : null;
}

// src/publish/png.ts
var PNG_LIMITS = {
  /** Longest side, in pixels: a 20 000 px tall page at device scale factor 2 is 40 000. */
  maxSide: 1e5,
  /** Width × height: 250 megapixels is about 1 GB to decode. */
  maxPixels: 25e7
};
var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var IHDR = [73, 72, 68, 82];
function checkPng(bytes) {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i2) => bytes[i2] !== b)) {
    return { ok: false, reason: "not a PNG" };
  }
  if (bytes.length < 8 + 8 + 13) return { ok: false, reason: "not a PNG (no IHDR header)" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || IHDR.some((b, i2) => bytes[12 + i2] !== b)) {
    return { ok: false, reason: "not a PNG (no IHDR header)" };
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const size = `a PNG of ${width}\xD7${height} pixels`;
  if (width === 0 || height === 0) return { ok: false, reason: size };
  if (width > PNG_LIMITS.maxSide || height > PNG_LIMITS.maxSide) {
    return { ok: false, reason: `${size}, over the ${PNG_LIMITS.maxSide}-pixel limit for a side` };
  }
  if (width * height > PNG_LIMITS.maxPixels) {
    return { ok: false, reason: `${size}, over the ${PNG_LIMITS.maxPixels / 1e6}-megapixel limit` };
  }
  return { ok: true, width, height };
}

// src/publish/site.ts
var KINDS = ["baseline", "current", "diff"];
var PATH_FIELD = { baseline: "baselinePath", current: "currentPath", diff: "diffPath" };
var PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
function buildRunReport(input) {
  const { site, run, archive } = input;
  const base = { runId: run.runId, dir: run.dir, url: `${site.url}${run.dir}/` };
  const page = `${run.dir}/index.html`;
  const read = readResults(archive);
  if (!read.ok) {
    return { files: [{ path: page, data: fallbackPage(input, read.reason) }], outcome: { ...base, ok: false, reason: read.reason } };
  }
  const { data, raw } = read;
  const files = [];
  const omittedImages = [];
  const archiveImages = archive.images;
  data.snapshots.forEach((snapshot, i2) => {
    const rawSnapshot = raw.snapshots[i2];
    for (const kind of KINDS) {
      const field = PATH_FIELD[kind];
      const from = rawSnapshot[field];
      if (typeof from !== "string" || !from.endsWith(`/${kind}.png`)) continue;
      const bytes = archiveImages.get(from);
      if (!bytes) continue;
      const check = checkPng(bytes);
      if (!check.ok) {
        omittedImages.push(`${from} (${check.reason})`);
        continue;
      }
      const to = `images/${i2}/${kind}.png`;
      files.push({ path: `${run.dir}/${to}`, data: bytes });
      snapshot[field] = to;
    }
  });
  const notices = runNotices(input);
  if (omittedImages.length > 0) {
    const n = omittedImages.length;
    const shown = omittedImages.slice(0, 5).join(", ");
    const more = n > 5 ? `, and ${n - 5} more` : "";
    notices.push({
      text: `${n} image${n === 1 ? " was" : "s were"} left out, as ${n === 1 ? "it is" : "they are"} not a PNG a browser can show: ${shown}${more}.`,
      tone: "warning"
    });
  }
  if (archive && "runStamp" in archive && archive.runStamp) {
    const stale = staleReport(parseRunStamp(new TextDecoder().decode(archive.runStamp)), {
      GITHUB_RUN_ID: String(run.runId),
      GITHUB_RUN_ATTEMPT: String(run.attempt)
    });
    if (stale) {
      notices.push({ text: `This report is from attempt ${stale.reportAttempt} of the run; attempt ${stale.thisAttempt} did not upload one.` });
    }
  }
  files.push({ path: page, data: renderHtml(data, { notices, noindex: true, csp: true }) });
  return { files, outcome: { ...base, ok: true, summary: data.summary, data, omittedImages } };
}
function readResults(archive) {
  if ("refused" in archive) return { ok: false, reason: `The report was not read: ${archive.refused}.` };
  if (!archive.results) return { ok: false, reason: "The report has no results.json." };
  let raw;
  try {
    raw = JSON.parse(new TextDecoder().decode(archive.results));
  } catch {
    return { ok: false, reason: "results.json is not valid JSON." };
  }
  const parsed = parseReportData(raw);
  if (!parsed.ok) return { ok: false, reason: `results.json cannot be shown: ${parsed.reason}` };
  return { ok: true, data: parsed.data, raw };
}
var prUrl = (site, n) => `${site.serverUrl}/${site.repo}/pull/${n}`;
var runUrl = (site, id) => `${site.serverUrl}/${site.repo}/actions/runs/${id}`;
function shortSha(sha) {
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 7) : "";
}
function when(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : "";
}
function commitAndTime(run) {
  const sha = shortSha(run.headSha);
  const time = when(run.createdAt);
  return [...sha ? [`commit ${sha}`] : [], ...time ? [time] : []];
}
function runLine(site, run, pr) {
  const [commit, time] = commitAndTime(run);
  return [pr ? `Pull request #${pr.number}` : site.defaultBranch, commit, `CI run ${run.runId}, attempt ${run.attempt}`, time].filter(Boolean).join(" \xB7 ");
}
function runNotices({ site, run, pr, artifactUrl }) {
  const notices = [
    {
      text: runLine(site, run, pr),
      links: [...pr ? [{ href: prUrl(site, pr.number), label: "pull request" }] : [], { href: runUrl(site, run.runId), label: "CI run" }]
    },
    {
      text: "Published by TestivAI from this run's report",
      links: [
        ...pr ? [{ href: `${site.url}pr/${pr.number}/`, label: "this pull request's runs" }] : [],
        { href: site.url, label: "all reports" },
        { href: artifactUrl, label: "report ZIP (GitHub sign-in)" }
      ]
    }
  ];
  if (pr?.fork) {
    notices.push({
      text: `From a fork (${pr.author}): this report was produced by code in the pull request, so its results and screenshots are the fork's. TestivAI checked their format and rebuilt this page from them, but cannot vouch for what they show.`,
      tone: "warning"
    });
  }
  return notices;
}
function counts2(s) {
  const parts = [];
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.newSnapshots) parts.push(`${s.newSnapshots} new`);
  if (s.missing) parts.push(`${s.missing} missing`);
  parts.push(`${s.passed} passed`);
  return parts.join(" \xB7 ");
}
function outcomeText(outcome) {
  if (!outcome) return "not published";
  return outcome.ok ? counts2(outcome.summary) : `could not be shown: ${outcome.reason}`;
}
function esc(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function href(value) {
  return esc(value);
}
function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)}</title>
  <style>
    :root { --bg: #f6f8fa; --surface: #ffffff; --border: #d0d7de; --text: #1f2328; --muted: #59636e; --accent: #0e7490; --link: #0969da; --changed: #cf222e; --new: #bc4c00; --passed: #1a7f37; --warn-bg: #bc4c0014; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #00d4ff; --link: #58a6ff; --changed: #f85149; --new: #f0883e; --passed: #3fb950; --warn-bg: #f0883e22; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
    h1 { font-size: 22px; margin: 0 0 4px; color: var(--accent); overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin: 28px 0 10px; }
    p { margin: 8px 0; }
    a { color: var(--link); }
    .muted { color: var(--muted); font-size: 14px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; overflow-wrap: anywhere; }
    .tag { display: inline-block; font-size: 12px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--new); color: var(--new); margin-left: 6px; }
    .notice { background: var(--warn-bg); border: 1px solid var(--border); border-left: 4px solid var(--new); border-radius: 10px; padding: 12px 14px; margin: 16px 0; overflow-wrap: anywhere; }
    code { font-family: 'SF Mono', ui-monospace, monospace; font-size: 13px; }
  </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
function fallbackPage(input, reason) {
  const { site, run, pr, artifactUrl } = input;
  const links = [
    ...pr ? [`<a href="${href(prUrl(site, pr.number))}">pull request</a>`] : [],
    `<a href="${href(runUrl(site, run.runId))}">CI run</a>`,
    `<a href="${href(artifactUrl)}">report ZIP (GitHub sign-in)</a>`,
    ...pr ? [`<a href="${href(`${site.url}pr/${pr.number}/`)}">this pull request's runs</a>`] : [],
    `<a href="${href(site.url)}">all reports</a>`
  ];
  return layout(
    "TestivAI report not shown",
    `  <h1>This report could not be shown</h1>
  <p class="muted">${esc(runLine(site, run, pr))}</p>
  <div class="notice">${esc(reason)}</div>
  <p>The run's own report is in its ZIP. ${links.join(" \xB7 ")}</p>`
  );
}
function buildIndexPages({ site, plan, outcomes, runsPerPr, include }) {
  const files = [];
  const about = `Published by TestivAI: the last ${runsPerPr} runs of each open pull request, and the latest run on ${esc(site.defaultBranch)}. A closed pull request's reports go with the next publish.`;
  const sections = [];
  if (plan.main) {
    const m = plan.main;
    sections.push(`  <h2>${esc(site.defaultBranch)}</h2>
  <ul><li><a href="main/">Latest run on ${esc(site.defaultBranch)}</a> \xB7 ${esc(outcomeText(outcomes.get(m.runId)))}<br><span class="muted">${esc(runLine(site, m))}</span></li></ul>`);
  }
  if (plan.prs.length > 0) {
    const items = plan.prs.map(({ pr, runs }) => {
      const latest = runs[0];
      const title = pr.title ? ` ${esc(truncate(pr.title, 200))}` : "";
      const fork = pr.fork ? `<span class="tag">fork \xB7 ${esc(pr.author)}</span>` : "";
      return `<li><strong>#${pr.number}</strong>${title}${fork}<br><a href="${href(`${latest.dir}/`)}">Latest run</a> \xB7 ${esc(outcomeText(outcomes.get(latest.runId)))} \xB7 <a href="${href(`pr/${pr.number}/`)}">all ${runs.length} run${runs.length === 1 ? "" : "s"}</a></li>`;
    });
    sections.push(`  <h2>Open pull requests</h2>
  <ul>${items.join("\n  ")}</ul>`);
  }
  if (sections.length === 0) {
    sections.push("  <p>Nothing is published yet: no open pull request or run on the default branch has a report.</p>");
  }
  if (include) {
    sections.push(`  <h2>Also on this site</h2>
  <ul><li><a href="${href(`${include}/`)}">${esc(include)}/</a></li></ul>`);
  }
  files.push({
    path: "index.html",
    data: layout(`Visual reports \xB7 ${site.repo}`, `  <h1>Visual reports \xB7 ${esc(site.repo)}</h1>
  <p class="muted">${about}</p>
${sections.join("\n")}`)
  });
  for (const { pr, runs } of plan.prs) {
    const items = runs.map(
      (r) => `<li><a href="${href(`${r.dir.slice(`pr/${pr.number}/`.length)}/`)}">CI run ${r.runId}, attempt ${r.attempt}</a> \xB7 ${esc(outcomeText(outcomes.get(r.runId)))}<br><span class="muted">${esc(commitAndTime(r).join(" \xB7 "))}</span></li>`
    );
    const dropped = plan.dropped.filter((d) => d.pr === pr.number).map((d) => `<li>Run ${d.runId} is not published: ${esc(d.reason)}</li>`);
    const title = pr.title ? ` \xB7 ${esc(truncate(pr.title, 200))}` : "";
    const fork = pr.fork ? `<div class="notice">From a fork (${esc(pr.author)}): these reports were produced by code in the pull request. TestivAI checked their format and rebuilt the pages from them, but cannot vouch for what they show.</div>` : "";
    files.push({
      path: `pr/${pr.number}/index.html`,
      data: layout(
        `Pull request #${pr.number} \xB7 visual reports`,
        `  <h1>Pull request #${pr.number}${title}</h1>
  <p class="muted"><a href="${href(prUrl(site, pr.number))}">Open the pull request</a> \xB7 <a href="${href(site.url)}">all reports</a>. Its last ${runsPerPr} runs with a report, newest first.</p>
  ${fork}
  <ul>${items.join("\n  ")}</ul>${dropped.length ? `
  <h2>Not published</h2>
  <ul>${dropped.join("\n  ")}</ul>` : ""}`
      )
    });
  }
  files.push({
    path: "404.html",
    data: layout(
      "Report not found",
      `  <h1>This report is no longer published</h1>
  <p>Reports stay published for the last ${runsPerPr} runs of each open pull request and the latest run on ${esc(site.defaultBranch)}; an older run's report, or a closed pull request's, is removed with the next publish. Its ZIP may still be on the run's page on GitHub, until the artifact expires.</p>
  <p><a href="${href(site.url)}">All published reports for ${esc(site.repo)}</a></p>`
    )
  });
  return files;
}
function truncate(value, max2) {
  return value.length > max2 ? `${value.slice(0, max2 - 1)}\u2026` : value;
}

// src/publish/build.ts
var MB3 = 1024 * 1024;
var PUBLISH_LIMITS = {
  /** The whole site; GitHub Pages refuses a site over 1 GB. */
  maxSiteBytes: 900 * MB3,
  /** One run's report ZIP. */
  maxPrBytes: 150 * MB3,
  /** Pages of 100 artifacts read, newest first. */
  maxArtifactPages: 10
};
function safeSitePath(root, rel) {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:html|png)$/.test(rel)) throw new Error(`not a site path: ${JSON.stringify(rel)}`);
  return path2.join(root, rel);
}
var mb2 = (bytes) => `${Math.round(bytes / MB3)} MB`;
var mb1 = (bytes) => `${(bytes / MB3).toFixed(1)} MB`;
var sizeOf = (f) => typeof f.data === "string" ? Buffer.byteLength(f.data) : f.data.byteLength;
var RESERVED = /* @__PURE__ */ new Set(["pr", "main"]);
function readInclude(include, maxBytes, log) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(include.name) || RESERVED.has(include.name)) {
    throw new Error(`include-name must be a lowercase folder name (letters, digits, '-', '_'), not pr or main; got ${JSON.stringify(include.name)}`);
  }
  if (!fs2.existsSync(include.dir) || !fs2.lstatSync(include.dir).isDirectory()) throw new Error(`include-dir ${include.dir} is not a folder`);
  const files = [];
  let bytes = 0;
  const walk = (rel) => {
    for (const entry of fs2.readdirSync(path2.join(include.dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) log.warning(`include-dir: ${child} is a symbolic link: skipped.`);
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files.push(child);
        bytes += fs2.statSync(path2.join(include.dir, child)).size;
      }
    }
  };
  walk("");
  if (bytes > maxBytes) throw new Error(`include-dir ${include.dir} is ${mb2(bytes)}, over the site's ${mb2(maxBytes)} budget`);
  return { files, bytes };
}
async function buildSite(api, options) {
  const { log } = options;
  const limits = { ...PUBLISH_LIMITS, ...options.limits };
  const include = options.include ? readInclude(options.include, limits.maxSiteBytes, log) : void 0;
  const repo = await api.repo();
  const decision = decidePublish({ pages: await api.pages(), repoVisibility: repo.visibility, publicReportsConsent: options.consent });
  if (!decision.publish || !decision.siteUrl || !decision.visibility) return { published: false, reason: decision.reason };
  log.info(decision.reason);
  const prs = await api.openPrs();
  const { artifacts, truncated } = await api.artifacts(options.artifactName, limits.maxArtifactPages);
  if (truncated) {
    log.warning(`Read the newest ${artifacts.length} artifacts only; a pull request whose last report is older than those is not published.`);
  }
  const wanted = /* @__PURE__ */ new Map();
  for (const pr of prs) wanted.set(`${pr.headRepoId}:${pr.headRef}`, { limit: options.runsPerPr + 1, runs: /* @__PURE__ */ new Set() });
  wanted.set(`${repo.id}:${repo.defaultBranch}`, { limit: 2, runs: /* @__PURE__ */ new Set() });
  const newestFirst = [...artifacts].sort((a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id);
  for (const a of newestFirst) {
    if (a.name !== options.artifactName || a.expired) continue;
    const slot = wanted.get(`${a.headRepoId}:${a.headBranch}`);
    if (slot && slot.runs.size < slot.limit) slot.runs.add(a.runId);
  }
  const runIds = [...new Set([...wanted.values()].flatMap((w) => [...w.runs]))];
  const runs = (await mapLimit(runIds, 8, (id) => api.run(id))).filter((r) => r !== void 0);
  const candidate = new Set(runIds);
  const plan = planSite({
    prs,
    runs,
    artifacts: artifacts.filter((a) => candidate.has(a.runId)),
    defaultBranch: repo.defaultBranch,
    repo: repo.fullName,
    limits: { runsPerPr: options.runsPerPr, maxSiteBytes: limits.maxSiteBytes, maxPrBytes: limits.maxPrBytes, artifactName: options.artifactName }
  });
  for (const d of plan.dropped) log.info(`Run ${d.runId}${d.pr ? ` (#${d.pr})` : ""} is not published: ${d.reason}.`);
  fs2.rmSync(options.siteDir, { recursive: true, force: true });
  fs2.mkdirSync(options.siteDir, { recursive: true });
  const site = { url: decision.siteUrl, repo: repo.fullName, serverUrl: options.serverUrl, defaultBranch: repo.defaultBranch };
  const artifactUrl = (r) => `${options.serverUrl}/${repo.fullName}/actions/runs/${r.runId}/artifacts/${r.artifactId}`;
  const order = [
    ...plan.main ? [{ run: plan.main }] : [],
    ...plan.prs.map((p) => ({ run: p.runs[0], pr: p.pr })),
    ...plan.prs.flatMap((p) => p.runs.slice(1).map((run) => ({ run, pr: p.pr })))
  ];
  const outcomes = /* @__PURE__ */ new Map();
  const left = /* @__PURE__ */ new Set();
  let bytes = 0;
  let files = 0;
  if (include && options.include) {
    for (const rel of include.files) {
      const to = path2.join(options.siteDir, options.include.name, rel);
      fs2.mkdirSync(path2.dirname(to), { recursive: true });
      fs2.copyFileSync(path2.join(options.include.dir, rel), to);
    }
    bytes += include.bytes;
    files += include.files.length;
    log.info(`Published ${options.include.dir} as ${options.include.name}/: ${include.files.length} files.`);
  }
  const cache = options.cacheDir ? openReportCache(options.cacheDir, { log, maxEntryBytes: limits.maxPrBytes }) : void 0;
  const digests = new Map(artifacts.map((a) => [a.id, a.digest]));
  const downloads = { count: 0, bytes: 0 };
  for (const { run, pr } of order) {
    const archive = await fetchArchive(api, run, { cache, digest: digests.get(run.artifactId), downloads });
    const built = buildRunReport({ site, run, ...pr ? { pr } : {}, artifactUrl: artifactUrl(run), archive });
    const size = built.files.reduce((n, f) => n + sizeOf(f), 0);
    if (bytes + size > limits.maxSiteBytes) {
      left.add(run);
      plan.dropped.push({ runId: run.runId, ...pr ? { pr: pr.number } : {}, reason: `the site would be over its ${mb2(limits.maxSiteBytes)} budget` });
      log.warning(`Run ${run.runId} is not published: the site would be over its ${mb2(limits.maxSiteBytes)} budget.`);
      continue;
    }
    writeFiles(options.siteDir, built.files);
    bytes += size;
    files += built.files.length;
    outcomes.set(run.runId, built.outcome);
    log.info(`${built.outcome.url}: ${built.outcome.ok ? "published" : `could not be shown (${built.outcome.reason})`}`);
  }
  cache?.prune();
  const downloaded = `Reports: ${downloads.count} downloaded (${mb1(downloads.bytes)})`;
  log.info(
    cache ? `${downloaded}, ${cache.stats.hits} from the cache (${mb1(cache.stats.hitBytes)}); ${cache.stats.stored} added to the cache, ${cache.stats.removed} removed from it.` : `${downloaded}.`
  );
  const published = {
    ...plan,
    ...plan.main && left.has(plan.main) ? { main: void 0 } : {},
    prs: plan.prs.map((p) => ({ pr: p.pr, runs: p.runs.filter((r) => !left.has(r)) })).filter((p) => p.runs.length > 0)
  };
  const index = buildIndexPages({ site, plan: published, outcomes, runsPerPr: options.runsPerPr, ...options.include ? { include: options.include.name } : {} });
  writeFiles(options.siteDir, index);
  bytes += index.reduce((n, f) => n + sizeOf(f), 0);
  files += index.length;
  const state = {
    siteUrl: decision.siteUrl,
    visibility: decision.visibility,
    prs: published.prs.map(({ pr, runs: [latest] }) => {
      const outcome = outcomes.get(latest.runId);
      return {
        pr: pr.number,
        fork: pr.fork,
        runId: latest.runId,
        attempt: latest.attempt,
        headSha: latest.headSha,
        url: outcome.url,
        artifactUrl: artifactUrl(latest),
        outcome: outcome.ok ? { ok: true, summary: outcome.summary, data: outcome.data } : { ok: false, reason: outcome.reason }
      };
    })
  };
  const stats = {
    downloaded: downloads.count,
    downloadedBytes: downloads.bytes,
    fromCache: cache?.stats.hits ?? 0,
    cacheChanged: cache !== void 0 && cache.stats.stored + cache.stats.removed > 0
  };
  return { published: true, reason: decision.reason, state, files, bytes, downloads: stats };
}
async function fetchArchive(api, run, from) {
  let zip = from.cache?.read(run.artifactId, from.digest);
  if (!zip) {
    try {
      zip = await api.download(run.artifactId);
    } catch (error) {
      return { refused: `the report could not be downloaded (${error instanceof Error ? error.message : String(error)})` };
    }
    from.downloads.count += 1;
    from.downloads.bytes += zip.byteLength;
    from.cache?.write(run.artifactId, from.digest, zip);
  }
  try {
    return readReportArchive(zip);
  } catch (error) {
    if (error instanceof ArchiveRefused) return { refused: error.message };
    throw error;
  }
}
function writeFiles(root, files) {
  for (const f of files) {
    const to = safeSitePath(root, f.path);
    fs2.mkdirSync(path2.dirname(to), { recursive: true });
    fs2.writeFileSync(to, f.data);
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i2 = next++;
      out[i2] = await fn(items[i2]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function finishPublish(api, options) {
  const { log } = options;
  let { state } = options;
  const deployed = pagesAddress(options.pageUrl);
  if (deployed && deployed !== state.siteUrl) {
    log.warning(`GitHub deployed the site at ${deployed}, not ${state.siteUrl} as its settings said before; the comments link ${deployed}.`);
    state = { ...state, siteUrl: deployed, prs: state.prs.map((p) => ({ ...p, url: deployed + p.url.slice(state.siteUrl.length) })) };
  }
  let verified = "skipped";
  if (state.visibility !== "public") {
    log.info("The site is private: it is not opened from here (it needs a GitHub sign-in).");
  } else if (!deployed) {
    log.info("The deploy reported no address, so the site is not opened from here.");
  } else {
    const fetchFn = options.fetch ?? ((url) => fetch(url, { redirect: "follow" }));
    const retries = options.retries ?? 6;
    verified = false;
    for (let attempt = 1; attempt <= retries && !verified; attempt++) {
      try {
        verified = (await fetchFn(deployed)).status === 200;
      } catch {
        verified = false;
      }
      if (!verified && attempt < retries) await new Promise((r) => setTimeout(r, options.delayMs ?? 1e4));
    }
    if (verified) log.info(`The site answers at ${deployed}.`);
    else log.warning(`The site did not answer at ${deployed} after ${retries} tries. GitHub reported the deploy as done, so the links are added anyway.`);
  }
  if (!options.comment) return { verified, siteUrl: state.siteUrl };
  for (const published of state.prs) {
    try {
      const action = commentFor(published, await api.comments(published.pr), options.marker);
      if (action.kind === "create") {
        await api.createComment(published.pr, action.body);
        log.info(`#${published.pr}: posted the report link.`);
      } else if (action.kind === "update") {
        await api.updateComment(action.id, action.body);
        log.info(`#${published.pr}: added the report links to the TestivAI comment.`);
      } else {
        log.info(`#${published.pr}: comment left as is (${action.why}).`);
      }
    } catch (error) {
      log.warning(
        `#${published.pr}: could not update the comment (${error instanceof Error ? error.message : String(error)}). The workflow needs pull-requests: write for the report links.`
      );
    }
  }
  return { verified, siteUrl: state.siteUrl };
}

// src/publish.ts
function parseRunsPerPr(value) {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1 || n > 10) throw new Error(`runs-per-pr must be a whole number from 1 to 10, not ${JSON.stringify(value)}`);
  return n;
}
function parseComment(value) {
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`comment must be true or false, not ${JSON.stringify(value)}`);
}
function parseCache(value) {
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`cache must be true or false, not ${JSON.stringify(value)}`);
}
function parseInclude(env) {
  const dir = (env.INCLUDE_DIR ?? "").trim();
  if (!dir) return void 0;
  const name = (env.INCLUDE_NAME ?? "").trim();
  if (!name) throw new Error("include-name is required with include-dir: the folder the pages go in on the site, such as demo");
  return { dir: path3.resolve(env.GITHUB_WORKSPACE || process.cwd(), dir), name };
}
async function build({ github, context, core, env }) {
  const runsPerPr = parseRunsPerPr(env.RUNS_PER_PR ?? "3");
  if (!env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is not set: this runs as a GitHub Actions step");
  const root = path3.join(env.RUNNER_TEMP, "testivai-pages");
  const siteDir = path3.join(root, "site");
  const stateFile = path3.join(root, "state.json");
  const include = parseInclude(env);
  const cacheDir = parseCache(env.CACHE ?? "true") ? env.CACHE_DIR?.trim() || path3.join(root, "cache") : void 0;
  const result = await buildSite(octokitApi(github, context.repo.owner, context.repo.repo), {
    artifactName: env.ARTIFACT_NAME || "testivai-visual-report",
    runsPerPr,
    consent: env.PUBLIC_REPORTS,
    siteDir,
    serverUrl: context.serverUrl,
    ...include ? { include } : {},
    ...cacheDir ? { cacheDir } : {},
    log: core
  });
  if (!result.published) {
    core.notice(result.reason);
    core.setOutput("published", "false");
    core.setOutput("cache-save", "false");
    return;
  }
  core.setOutput("cache-save", result.downloads.cacheChanged ? "true" : "false");
  fs3.writeFileSync(stateFile, JSON.stringify(result.state));
  core.info(`Built the site: ${result.files} files, ${Math.round(result.bytes / 1024)} KB.`);
  core.setOutput("published", "true");
  core.setOutput("site-dir", siteDir);
  core.setOutput("state-file", stateFile);
  core.setOutput("page-url", result.state.siteUrl);
}
async function finish({ github, context, core, env }) {
  const comment = parseComment(env.COMMENT ?? "true");
  if (!env.STATE_FILE) throw new Error("STATE_FILE is not set: the build step did not publish");
  const state = JSON.parse(fs3.readFileSync(env.STATE_FILE, "utf8"));
  const { siteUrl } = await finishPublish(octokitApi(github, context.repo.owner, context.repo.repo), {
    state,
    pageUrl: env.PAGE_URL,
    comment,
    marker: resolveUpsertMarker(resolveStatusContext(env.STATUS_CONTEXT ?? "")),
    log: core
  });
  core.setOutput("page-url", siteUrl);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  build,
  finish,
  parseCache,
  parseComment,
  parseInclude,
  parseRunsPerPr
});
