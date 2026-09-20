# devtools — Reusable PR Review System

A reusable GitHub Actions workflow that adds automated TypeScript checking, ESLint auto-fix, Claude AI code review, and AI-generated PR descriptions to any repository in your organisation.

---

## What's included

| File | Purpose |
|------|---------|
| `.github/workflows/pr-review-reusable.yml` | Reusable workflow — call this from any repo |
| `scripts/claude-review.js` | Fetches PR diff → Claude AI review → inline comments |
| `scripts/post-eslint-annotations.js` | Reads ESLint JSON report → inline PR annotations |
| `scripts/generate-pr-description.js` | Generates What/How/Testing description from diff |
| `config/pull_request_template.md` | Standard PR template to copy into target repos |
| `config/example-caller-workflow.yml` | Copy-paste starter for new repos |
| `templates/implementation-plan.html` | Progress-tracking page every project must have in `docs/` — see step 6 |
| `scripts/init-project.sh` | One-shot initializer for a new repo: `.claude/`, `BACKLOG.md`, `CLAUDE.md`, the PR workflow and the implementation plan |

---

## Quick setup

### 1. Create this devtools repository

```bash
gh repo create YOUR_ORG/devtools --private
git clone https://github.com/YOUR_ORG/devtools
# copy this project's files in, then push
```

### 2. Add the Anthropic API key as an organisation secret

In GitHub → **Organisation Settings → Secrets and variables → Actions**, add:

```
ANTHROPIC_API_KEY = sk-ant-...
```

By storing it at org level you only need to do this once. Each repo that calls the reusable workflow will automatically inherit it.

> The built-in `GITHUB_TOKEN` is automatically available to every workflow — no extra configuration needed.

### 3. Add the caller workflow to each repo

Copy `config/example-caller-workflow.yml` into the target repo at:

```
.github/workflows/pr-checks.yml
```

Then replace `YOUR_ORG` with your actual GitHub organisation name:

```yaml
uses: YOUR_ORG/devtools/.github/workflows/pr-review-reusable.yml@main
```

### 4. Add the PR template

Copy `config/pull_request_template.md` to the target repo at:

```
.github/pull_request_template.md
```

GitHub will automatically populate new PRs with this template.

### 5. Enable branch protection rules (recommended)

In each target repo → **Settings → Branches → Add rule** for `main`/`master`:

- ✅ Require status checks to pass before merging
  - Add `TypeScript Check`
  - Add `ESLint`
  - Add `Claude AI Review` *(optional — start advisory)*
- ✅ Require branches to be up to date before merging
- ✅ Require pull request reviews before merging

### 6. Add the implementation plan

Every project tracks its progress in `docs/implementation-plan.html` — Matan opens it directly instead of asking where things stand. `scripts/init-project.sh` creates it for a new repo from `templates/implementation-plan.html` (substituting `{{PROJECT_NAME}}` and `{{PREFIX}}`); for an existing repo, copy the template by hand.

The rules live in a comment at the top of the template and in `~/.claude/CLAUDE.md` (New Project Initialization, Step 5). In short: update it in the same batch of work as closing any ticket, mark a finished phase with `class="phase done"` (light green background), and keep the **You are here** marker directly after the last finished phase. A project spanning several repos keeps one unified plan, byte-identical in each.

---

## Workflow inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `typescript_blocking` | boolean | `true` | Fail the PR if `tsc --noEmit` finds errors |
| `eslint_blocking` | boolean | `true` | Fail the PR if unfixable ESLint errors remain after auto-fix |
| `claude_blocking` | boolean | `false` | Fail the PR if Claude flags critical or major issues |
| `node_version` | string | `"20"` | Node.js version used by all jobs |
| `working_directory` | string | `"."` | Subdirectory to run checks in (useful for monorepos) |

---

## What each job does

### TypeScript (`typescript_blocking: true`)

Runs `npx tsc --noEmit`. Fails the workflow when errors are found and `typescript_blocking` is `true`. Reports a warning and continues when `false`.

### ESLint (`eslint_blocking: true`)

1. Runs `npx eslint --fix` on the entire working directory.
2. Commits any auto-fixable changes back to the PR branch with the message `fix(lint): auto-fix ESLint issues [skip ci]`.
3. Posts inline annotations for any remaining errors/warnings via `post-eslint-annotations.js`.
4. Fails the workflow if unfixable errors remain (when `eslint_blocking` is `true`).

### Claude AI Review (`claude_blocking: false`)

Claude (`claude-opus-4-5`) reviews the PR diff for:

- **SOLID principles** — SRP, OCP, LSP, ISP, DIP
- **Clean code** — naming, function size, DRY, magic values, dead code
- **TypeScript best practices** — `any` usage, type safety, readonly, null handling
- **Error handling** — caught at right boundaries, async errors, swallowed exceptions
- **Complexity** — cyclomatic complexity, deep nesting, long functions

Claude responds in structured JSON. The script posts:
- An inline comment per issue with severity, category, principle, and a concrete suggestion
- A summary review comment with an issue count table

Exits 1 (and blocks the PR) only when `claude_blocking: true` **and** critical/major issues are found.

### PR Description Generator (always non-blocking)

Fires on every PR. Logic:

1. **Check existing body** — if `PR_BODY` is non-empty and longer than 50 characters, logs "Description exists, skipping." and exits 0.
2. **Generate** — fetches the full diff, sends it to Claude (`claude-opus-4-5`), which returns a JSON object:
   ```json
   { "what": "...", "how": "...", "testing": "..." }
   ```
3. **Update** — constructs a markdown PR body (What / How / Testing / Checklist) and calls `pulls.update()`.
4. **Notify** — posts a comment: *"🤖 I generated a PR description from the diff. Please review and adjust if needed."*

This job always exits 0. It never blocks a PR.

---

## Recommended rollout strategy

Start with low friction and graduate to stricter gates as the team gains confidence.

### Phase 1 — Advisory only (week 1–2)

```yaml
with:
  typescript_blocking: false
  eslint_blocking: false
  claude_blocking: false
```

The checks run and post comments, but nothing blocks merging. Use this phase to tune ESLint rules and see what Claude flags before it has teeth.

### Phase 2 — TypeScript and ESLint blocking (week 3–4)

```yaml
with:
  typescript_blocking: true
  eslint_blocking: true
  claude_blocking: false
```

Type errors and unfixable lint errors now block PRs. Claude feedback is still advisory. Address any pre-existing type issues in the codebase.

### Phase 3 — Full enforcement (week 5+)

```yaml
with:
  typescript_blocking: true
  eslint_blocking: true
  claude_blocking: true
```

Claude critical/major findings now block merging. At this point add `Claude AI Review` to the required status checks list in branch protection.

---

## Monorepo usage

If your `package.json` (and `tsconfig.json`, `.eslintrc`) are not in the repo root:

```yaml
with:
  working_directory: "packages/my-service"
```

The TypeScript and ESLint jobs will `cd` into that directory before running. The Claude review and description generator always operate on the full PR diff regardless of `working_directory`.

---

## Secrets reference

| Secret | Scope | Description |
|--------|-------|-------------|
| `ANTHROPIC_API_KEY` | Org-level (recommended) or repo-level | Used by Claude review and description jobs |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions | Used for API calls and pushing ESLint fixes |

---

## Frequently asked questions

**Q: Will the ESLint auto-fix commit trigger another CI run?**
The commit message includes `[skip ci]`, which tells GitHub Actions (and most other CI providers) to skip triggering a new workflow run.

**Q: What if the PR diff is very large?**
Both `claude-review.js` and `generate-pr-description.js` truncate the diff at 80 000 and 60 000 characters respectively before sending to Claude, and append `[diff truncated]` so Claude is aware. Very large PRs should be split up anyway.

**Q: Can I use this without TypeScript?**
Yes — if the project has no `tsconfig.json`, `tsc --noEmit` will exit with an error. Either set `typescript_blocking: false` or add a minimal `tsconfig.json` stub.

**Q: How do I disable a specific job?**
Each job can be made advisory by setting its `_blocking` input to `false`. There is no input to skip a job entirely from the caller; to do that, create a second reusable workflow that omits the unwanted job.
