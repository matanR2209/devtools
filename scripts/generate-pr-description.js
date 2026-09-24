#!/usr/bin/env node
/**
 * generate-pr-description.js
 *
 * Fills in <Claude to complete> placeholders in the PR body and sets a
 * conventional-commit PR title from the diff.
 * Skips if all placeholders are already replaced (body has real content).
 * Always exits 0 — never blocks a PR.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   – Anthropic API key
 *   GITHUB_TOKEN        – GitHub token with pull-requests:write
 *   GITHUB_REPOSITORY   – "owner/repo"
 *   PR_NUMBER           – pull request number (integer)
 *   PR_BODY             – current PR body (passed from workflow context)
 *   PR_TITLE            – current PR title (passed from workflow context)
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
const PR_TITLE = process.env.PR_TITLE ?? "";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_DIFF_CHARS = 60_000;
const PLACEHOLDER = "<Claude to complete>";

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a technical writer helping engineers write clear, concise pull request descriptions.
Given a git diff, analyse the changes and return ONLY a JSON object with four keys:

{
  "title": "conventional commit PR title, e.g. feat: add user authentication",
  "what": "1-2 sentence summary of what this PR does",
  "how": "2-4 sentences on the implementation approach — what was added/changed and key decisions",
  "testing": "what tests were added, estimated coverage impact, or 'No tests added' if none found in diff"
}

Rules:
- title must follow conventional commits: feat/fix/chore/refactor/docs/test/perf/ci, colon, short description in lowercase
- title must be specific, e.g. "feat: add WebSocket reconnection with exponential backoff" not "feat: update code"
- Be specific and technical in all fields — name the files, functions, modules, or patterns involved
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

function hasPlaceholders(body) {
  return body.includes(PLACEHOLDER);
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
        content: `Generate a PR title and description for this diff:\n\n\`\`\`diff\n${truncated}\n\`\`\``,
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

/**
 * Replace each <Claude to complete> placeholder in the template body
 * with the corresponding generated content, preserving all surrounding
 * structure (headers, HTML comments, checklist).
 */
function fillPlaceholders(body, desc) {
  let remaining = body;
  const sections = ["what", "how", "testing"];
  for (const key of sections) {
    remaining = remaining.replace(PLACEHOLDER, desc[key]);
  }
  return remaining;
}

function titleNeedsUpdate(currentTitle) {
  if (!currentTitle || currentTitle.trim() === "") return true;
  // If title looks like a branch name or GitHub default (no colon), replace it
  const conventionalPrefixes = /^(feat|fix|chore|refactor|docs|test|perf|ci|build|style)(\(.+\))?:/;
  return !conventionalPrefixes.test(currentTitle.trim());
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();
  const { owner, repo } = parseRepo();

  const bodyNeedsWork = hasPlaceholders(PR_BODY);
  const titleNeedsWork = titleNeedsUpdate(PR_TITLE);

  if (!bodyNeedsWork && !titleNeedsWork) {
    console.log("PR body and title already filled in — skipping.");
    process.exit(0);
  }

  console.log(
    `Generating: body=${bodyNeedsWork}, title=${titleNeedsWork}…`
  );

  const anthropic = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const diff = await fetchPRDiff(octokit, owner, repo, PR_NUMBER);
  if (!diff || diff.trim().length === 0) {
    console.log("Empty diff — nothing to describe.");
    process.exit(0);
  }

  console.log(`Diff size: ${diff.length} chars. Calling Claude…`);
  const rawResponse = await callClaude(anthropic, diff);

  let desc;
  try {
    desc = parseDescriptionJSON(rawResponse);
  } catch (err) {
    console.error(`Failed to parse Claude response as JSON: ${err.message}`);
    console.error("Raw response:", rawResponse);
    process.exit(0);
  }

  if (!desc.what || !desc.how || !desc.testing || !desc.title) {
    console.error("Claude response missing required fields.");
    process.exit(0);
  }

  // ── Fill placeholders in the existing template body ───────────────────
  const newBody = bodyNeedsWork ? fillPlaceholders(PR_BODY, desc) : PR_BODY;

  // ── Update PR title and body ──────────────────────────────────────────
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: PR_NUMBER,
    ...(bodyNeedsWork ? { body: newBody } : {}),
    ...(titleNeedsWork ? { title: desc.title } : {}),
  });

  console.log(`PR updated — title: "${desc.title}"`);

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: PR_NUMBER,
    body: [
      `🤖 I filled in the PR description and title from the diff. Please review and adjust if needed.`,
      ``,
      `**Title set to:** \`${desc.title}\``,
      ``,
      `*(Auto-generated by \`generate-pr-description.js\`)*`,
    ].join("\n"),
  });

  console.log("Notification comment posted.");
}

main().catch((err) => {
  console.error(
    `PR description generation failed — status: ${err.status ?? "n/a"}, message: ${err.message}`
  );
  process.exit(0);
});
