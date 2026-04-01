#!/usr/bin/env node
/**
 * claude-review.js
 *
 * Fetches the PR diff, sends it to Claude for a SOLID / clean-code review,
 * and posts the results as inline GitHub PR review comments.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   – Anthropic API key
 *   GITHUB_TOKEN        – GitHub token with pull-requests:write
 *   GITHUB_REPOSITORY   – "owner/repo"
 *   PR_NUMBER           – pull request number (integer)
 *   BLOCKING            – "true" | "false"  (exit 1 on critical issues?)
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { Octokit } = require("@octokit/rest");

// ─── Config ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER, 10);
const BLOCKING = process.env.BLOCKING === "true";

const MODEL = "claude-opus-4-5";
const MAX_DIFF_CHARS = 80_000; // truncate huge diffs to stay within context

const SEVERITY_EMOJI = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  info: "🔵",
};

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior software engineer performing a pull request review.
Analyse the provided git diff and evaluate the code changes against these criteria:

SOLID Principles:
- Single Responsibility: each class/module/function has one reason to change
- Open/Closed: open for extension, closed for modification
- Liskov Substitution: subtypes must be substitutable for their base types
- Interface Segregation: clients should not depend on interfaces they don't use
- Dependency Inversion: depend on abstractions, not concretions

Clean Code:
- Meaningful, intention-revealing names (no cryptic abbreviations)
- Functions are small and do one thing
- No dead code, commented-out code, or TODO left unaddressed
- No magic numbers/strings — use named constants
- DRY (Don't Repeat Yourself) — no unnecessary duplication

TypeScript Best Practices:
- Avoid \`any\` — use precise types or generics
- Prefer interfaces/types over raw object literals in signatures
- Use readonly where mutation is not intended
- Null/undefined handling is explicit (optional chaining, nullish coalescing)

Error Handling:
- Errors are caught at appropriate boundaries
- Error messages are informative
- Async errors are properly awaited / caught
- No swallowed exceptions

Complexity:
- Cyclomatic complexity is low; long chains of conditionals are refactored
- Deep nesting is avoided (max 3 levels)
- Functions and methods are short (prefer < 30 lines)

IMPORTANT — respond ONLY with a single valid JSON object matching this schema exactly:
{
  "summary": "<2-4 sentence overall assessment of the PR>",
  "overall_severity": "critical" | "major" | "minor" | "info",
  "issues": [
    {
      "file": "<relative file path>",
      "line": <line number as integer, or null if file-level>,
      "severity": "critical" | "major" | "minor" | "info",
      "category": "solid" | "clean-code" | "typescript" | "error-handling" | "complexity",
      "principle": "<e.g. Single Responsibility, DRY, Meaningful Names …>",
      "title": "<short one-line issue title>",
      "description": "<what is wrong and why it matters>",
      "suggestion": "<concrete code-level fix or refactoring suggestion>"
    }
  ]
}

Do not include any text outside the JSON object.
If the diff looks clean and you have no issues, return an empty issues array.`;

// ─── Helpers ───────────────────────────────────────────────────────────────

function validateEnv() {
  const missing = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GITHUB_REPOSITORY"].filter(
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

async function fetchPRDiff(octokit, owner, repo, pullNumber) {
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });
  // Octokit returns the diff as a string when mediaType.format = "diff"
  return String(response.data);
}

async function fetchPRDetails(octokit, owner, repo, pullNumber) {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return data;
}

async function callClaude(anthropic, diff) {
  const truncated =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — too large]"
      : diff;

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 8096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Please review the following git diff:\n\n\`\`\`diff\n${truncated}\n\`\`\``,
      },
    ],
  });

  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  return text;
}

function parseClaudeResponse(raw) {
  // Strip markdown code fences if Claude wrapped the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Claude JSON response: ${err.message}\n\nRaw output:\n${raw}`);
  }
}

/**
 * Convert a unified-diff line number to a position within the diff hunk
 * (required by the GitHub review comments API).
 * Returns null if the line cannot be mapped.
 */
function buildDiffPositionMap(diff) {
  const map = new Map(); // "file:line" -> position
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

function buildSummaryTable(issues, overallSeverity, summary) {
  const counts = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const issue of issues) {
    counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  }

  const rows = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `| ${SEVERITY_EMOJI[sev]} ${sev} | ${n} |`)
    .join("\n");

  return [
    `## 🤖 Claude AI Code Review`,
    ``,
    `**Overall: ${SEVERITY_EMOJI[overallSeverity] ?? "🔵"} ${overallSeverity}**`,
    ``,
    summary,
    ``,
    `### Issue Summary`,
    ``,
    `| Severity | Count |`,
    `|----------|-------|`,
    rows || `| ✅ none | 0 |`,
    ``,
    `---`,
    `*Reviewed with \`${MODEL}\` · Categories: SOLID, clean code, TypeScript, error handling, complexity*`,
  ].join("\n");
}

async function postReview(octokit, owner, repo, pullNumber, pr, reviewData, diff) {
  const posMap = buildDiffPositionMap(diff);
  const comments = [];

  for (const issue of reviewData.issues) {
    if (!issue.file || issue.line == null) continue;

    const position = posMap.get(`${issue.file}:${issue.line}`);
    if (position == null) continue; // line not in diff — skip inline comment

    const emoji = SEVERITY_EMOJI[issue.severity] ?? "🔵";
    const body = [
      `${emoji} **[${issue.severity.toUpperCase()}] ${issue.title}**`,
      ``,
      `**Principle:** ${issue.principle}`,
      `**Category:** ${issue.category}`,
      ``,
      issue.description,
      ``,
      `**Suggestion:**`,
      issue.suggestion,
    ].join("\n");

    comments.push({
      path: issue.file,
      position,
      body,
    });
  }

  const summaryBody = buildSummaryTable(
    reviewData.issues,
    reviewData.overall_severity,
    reviewData.summary
  );

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: pr.head.sha,
    body: summaryBody,
    event: "COMMENT",
    comments,
  });

  console.log(
    `Posted review with ${comments.length} inline comment(s). Overall severity: ${reviewData.overall_severity}`
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();
  const { owner, repo } = parseRepo();

  const anthropic = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  console.log(`Fetching PR #${PR_NUMBER} from ${owner}/${repo}…`);
  const [diff, pr] = await Promise.all([
    fetchPRDiff(octokit, owner, repo, PR_NUMBER),
    fetchPRDetails(octokit, owner, repo, PR_NUMBER),
  ]);

  if (!diff || diff.trim().length === 0) {
    console.log("No diff found — nothing to review.");
    process.exit(0);
  }

  console.log(`Diff size: ${diff.length} chars. Sending to Claude…`);
  const rawResponse = await callClaude(anthropic, diff);

  let reviewData;
  try {
    reviewData = parseClaudeResponse(rawResponse);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Claude returned ${reviewData.issues.length} issue(s).`);
  await postReview(octokit, owner, repo, PR_NUMBER, pr, reviewData, diff);

  // Exit 1 only when blocking mode is on AND critical/major issues exist
  if (BLOCKING) {
    const blockingIssues = reviewData.issues.filter((i) =>
      ["critical", "major"].includes(i.severity)
    );
    if (blockingIssues.length > 0) {
      console.error(
        `Blocking: Claude found ${blockingIssues.length} critical/major issue(s).`
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
