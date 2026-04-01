#!/usr/bin/env node
/**
 * generate-pr-description.js
 *
 * Generates a structured PR description from the diff using Claude.
 * Only runs when the existing PR body is empty or shorter than 50 chars.
 * Always exits 0 — never blocks a PR.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   – Anthropic API key
 *   GITHUB_TOKEN        – GitHub token with pull-requests:write
 *   GITHUB_REPOSITORY   – "owner/repo"
 *   PR_NUMBER           – pull request number (integer)
 *   PR_BODY             – current PR body (passed from workflow context)
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { Octokit } = require("@octokit/rest");

// ─── Config ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER, 10);
const PR_BODY = process.env.PR_BODY ?? "";

const MODEL = "claude-opus-4-5";
const DESCRIPTION_THRESHOLD = 50; // chars
const MAX_DIFF_CHARS = 60_000;

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a technical writer helping engineers write clear, concise pull request descriptions.
Given a git diff, analyse the changes and return ONLY a JSON object with three keys:

{
  "what": "1-2 sentence summary of what this PR does",
  "how": "2-4 sentences on the implementation approach — what was added/changed and key decisions",
  "testing": "what tests were added, estimated coverage impact, or 'No tests added' if none found in diff"
}

Rules:
- Be specific and technical — name the files, functions, modules, or patterns involved
- Do NOT use filler phrases like 'This PR...', 'In this change...', or 'The purpose of this PR'
- Keep each section to approximately 60 words maximum
- For 'testing': scan the diff for test files (*.test.*, *.spec.*, __tests__/) and mention them explicitly
- Return ONLY the JSON object — no markdown, no prose outside the JSON`;

// ─── Helpers ───────────────────────────────────────────────────────────────

function validateEnv() {
  const missing = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GITHUB_REPOSITORY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    // Non-blocking — exit 0
    process.exit(0);
  }
  if (isNaN(PR_NUMBER)) {
    console.error("PR_NUMBER must be a valid integer");
    process.exit(0);
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
  return String(response.data);
}

async function callClaude(anthropic, diff) {
  const truncated =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]"
      : diff;

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Generate a PR description for this diff:\n\n\`\`\`diff\n${truncated}\n\`\`\``,
      },
    ],
  });

  const message = await stream.finalMessage();
  return message.content.find((b) => b.type === "text")?.text ?? "";
}

function parseDescriptionJSON(raw) {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  return JSON.parse(cleaned);
}

function buildPRBody(desc) {
  return [
    `## What`,
    desc.what,
    ``,
    `## How`,
    desc.how,
    ``,
    `## Testing`,
    desc.testing,
    ``,
    `## Checklist`,
    `- [ ] Self-reviewed the diff`,
    `- [ ] No console.logs left in`,
    `- [ ] Types are correct (no \`any\` added without justification)`,
    `- [ ] Tests added or updated if needed`,
  ].join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();
  const { owner, repo } = parseRepo();

  // ── Gate: skip if description already exists ──────────────────────────
  const existingBody = PR_BODY.trim();
  if (existingBody.length > DESCRIPTION_THRESHOLD) {
    console.log(
      `Description exists (${existingBody.length} chars > ${DESCRIPTION_THRESHOLD}) — skipping.`
    );
    process.exit(0);
  }

  console.log(
    `PR body is short/empty (${existingBody.length} chars). Generating description…`
  );

  const anthropic = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  // ── Fetch diff ────────────────────────────────────────────────────────
  const diff = await fetchPRDiff(octokit, owner, repo, PR_NUMBER);

  if (!diff || diff.trim().length === 0) {
    console.log("Empty diff — nothing to describe.");
    process.exit(0);
  }

  // ── Call Claude ───────────────────────────────────────────────────────
  console.log(`Diff size: ${diff.length} chars. Calling Claude…`);
  const rawResponse = await callClaude(anthropic, diff);

  let desc;
  try {
    desc = parseDescriptionJSON(rawResponse);
  } catch (err) {
    console.error(`Failed to parse Claude response as JSON: ${err.message}`);
    console.error("Raw response:", rawResponse);
    // Non-blocking
    process.exit(0);
  }

  if (!desc.what || !desc.how || !desc.testing) {
    console.error("Claude response missing required fields (what/how/testing).");
    process.exit(0);
  }

  // ── Build and update PR body ──────────────────────────────────────────
  const newBody = buildPRBody(desc);

  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: PR_NUMBER,
    body: newBody,
  });

  console.log("PR description updated successfully.");

  // ── Notify the author ─────────────────────────────────────────────────
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: PR_NUMBER,
    body: [
      `🤖 I generated a PR description from the diff. Please review and adjust if needed.`,
      ``,
      `*(Auto-generated by \`generate-pr-description.js\` because the PR body was empty or very short.)*`,
    ].join("\n"),
  });

  console.log("Notification comment posted.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  // Always non-blocking
  process.exit(0);
});
