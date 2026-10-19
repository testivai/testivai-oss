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
  reply: () => reply
});
module.exports = __toCommonJS(approve_exports);

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
function parseRunStamp(text) {
  let raw;
  try {
    raw = JSON.parse(text);
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
var RERUN_NOTE = "CI runs again on this commit when the approve step pushes with a personal access token or GitHub App token. With the default `GITHUB_TOKEN`, GitHub starts no run for this push: push another commit to re-run CI.";
function buildApproveReply({ approved, skipped, count, actor, run, reportUrl, serverUrl, repo }) {
  if (count === 0) {
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
  const lines = [`**${count} baseline${count === 1 ? "" : "s"} approved** by @${actor}${from}`, ""];
  if (report) lines.push(`> **[Open the visual report](${report})** of that run: baseline, current and diff side by side`, "");
  lines.push(approved.map((n) => report ? `- \`${n}\` \xB7 [open in report](${report}#${snapshotAnchorId(n)})` : `- \`${n}\``).join("\n"));
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
  const count = Number.parseInt(env.COUNT ?? "", 10) || 0;
  const run = approvedRun(env.ARTIFACT_DIR ? readRunStamp(env.ARTIFACT_DIR) : null, env.RUN_ID);
  let reportUrl;
  if (count > 0 && run?.attempt !== void 0) {
    try {
      reportUrl = findReportUrl(await listComments(github, context), { pr: context.issue.number, runKey: `${run.id}-${run.attempt}` });
      core.info(reportUrl ? `Linking run ${run.id}'s published report: ${reportUrl}` : `Run ${run.id}, attempt ${run.attempt} has no published report linked in a TestivAI comment.`);
    } catch (error) {
      core.warning(`Could not read the pull request's comments for the report link (${error instanceof Error ? error.message : String(error)}); the reply goes without it.`);
    }
  }
  const body = buildApproveReply({
    approved: words(env.APPROVED),
    skipped: words(env.SKIPPED),
    count,
    actor: env.ACTOR ?? "",
    ...run ? { run } : {},
    ...reportUrl ? { reportUrl } : {},
    serverUrl: context.serverUrl || "https://github.com",
    repo: `${context.repo.owner}/${context.repo.repo}`
  });
  await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  approvedRun,
  buildApproveReply,
  findReportUrl,
  reply
});
