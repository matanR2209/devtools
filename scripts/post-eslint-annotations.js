#!/usr/bin/env node
/**
 * post-eslint-annotations.js
 *
 * Reads eslint-report.json (produced by `eslint --format json --output-file`)
 * and posts inline GitHub PR review comments for each error and warning.
 * Finishes by posting a summary comment with total counts.
 *
 * Required env vars:
 *   GITHUB_TOKEN        – GitHub token with pull-requests:write
 *   GITHUB_REPOSITORY   – "owner/repo"
 *   PR_NUMBER           – pull request number (integer)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");

// ─── Config ────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER, 10);

const REPORT_PATH = path.resolve(process.cwd(), "eslint-report.json");

const SEVERITY_LABEL = { 1: "⚠️ warning", 2: "🔴 error" };
const SEVERITY_EMOJI = { 1: "⚠️", 2: "🔴" };

// ─── Helpers ───────────────────────────────────────────────────────────────

function validateEnv() {
  const missing = ["GITHUB_TOKEN", "GITHUB_REPOSITORY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (isNaN(PR_NUMBER)) {
    console.error("PR_NUMBER must be a valid integer");
    process.exit(1);
  }
}

function parseRepo() {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  return { owner, repo };
}

function loadReport() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.log(`ESLint report not found at ${REPORT_PATH} — skipping.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
  } catch (err) {
    console.error(`Failed to parse ${REPORT_PATH}: ${err.message}`);
    return null;
  }
}

/**
 * Build a position map from the PR diff so we can place inline comments.
 * Returns a Map: "relative/file/path:lineNumber" -> diffPosition
 */
async function fetchDiffPositionMap(octokit, owner, repo, pullNumber) {
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });
  const diff = String(response.data);

  const map = new Map();
  const fileRegex = /^\+\+\+ b\/(.+)$/;
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  let currentFile = null;
  let position = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = fileRegex.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      position = 0;
      continue;
    }
    const hunkMatch = hunkRegex.exec(line);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10) - 1;
      position++;
      continue;
    }
    if (currentFile) {
      position++;
      if (!line.startsWith("-")) {
        newLine++;
        map.set(`${currentFile}:${newLine}`, position);
      }
    }
  }
  return map;
}

/**
 * Convert an absolute filesystem path to a repo-relative path
 * using the cwd as the repo root (consistent with how the workflow runs).
 */
function toRelativePath(absolutePath) {
  return path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

function buildSummaryBody(totalErrors, totalWarnings, fileCount) {
  const lines = [
    `## 🔍 ESLint Report`,
    ``,
    `| | Count |`,
    `|---|---|`,
    `| 🔴 Errors | ${totalErrors} |`,
    `| ⚠️ Warnings | ${totalWarnings} |`,
    `| 📄 Files affected | ${fileCount} |`,
    ``,
  ];

  if (totalErrors === 0 && totalWarnings === 0) {
    lines.push("✅ No ESLint issues found after auto-fix pass.");
  } else if (totalErrors === 0) {
    lines.push(
      `⚠️ ${totalWarnings} warning(s) remain after auto-fix. Consider addressing them.`
    );
  } else {
    lines.push(
      `🔴 ${totalErrors} error(s) could not be auto-fixed and require manual attention.`
    );
  }

  lines.push(``, `---`, `*Annotations posted by \`post-eslint-annotations.js\`*`);
  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();
  const { owner, repo } = parseRepo();

  const report = loadReport();
  if (!report) {
    process.exit(0);
  }

  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  // Fetch PR head SHA for the review
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: PR_NUMBER,
  });

  const posMap = await fetchDiffPositionMap(octokit, owner, repo, PR_NUMBER);

  let totalErrors = 0;
  let totalWarnings = 0;
  let filesWithIssues = 0;
  const comments = [];

  for (const fileResult of report) {
    if (fileResult.errorCount === 0 && fileResult.warningCount === 0) continue;

    totalErrors += fileResult.errorCount;
    totalWarnings += fileResult.warningCount;
    filesWithIssues++;

    const relPath = toRelativePath(fileResult.filePath);

    for (const msg of fileResult.messages) {
      const position = posMap.get(`${relPath}:${msg.line}`);
      if (position == null) continue; // line not in diff

      const severityLabel = SEVERITY_LABEL[msg.severity] ?? "🔵 info";
      const ruleId = msg.ruleId ? ` (\`${msg.ruleId}\`)` : "";

      const body = [
        `${severityLabel}${ruleId}`,
        ``,
        msg.message,
        msg.fix ? `\n*This was auto-fixable — check that the committed fix is correct.*` : "",
      ]
        .filter((l) => l !== "")
        .join("\n");

      comments.push({
        path: relPath,
        position,
        body,
      });
    }
  }

  const summaryBody = buildSummaryBody(totalErrors, totalWarnings, filesWithIssues);

  console.log(
    `Posting ESLint review: ${totalErrors} error(s), ${totalWarnings} warning(s), ` +
      `${comments.length} inline comment(s)…`
  );

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: PR_NUMBER,
    commit_id: pr.head.sha,
    body: summaryBody,
    event: "COMMENT",
    comments,
  });

  console.log("ESLint annotations posted successfully.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  // Non-fatal — don't block the workflow
  process.exit(0);
});
