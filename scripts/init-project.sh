#!/bin/zsh

if [ ! -d ".git" ]; then
  echo "Not a git repo — skipping DevSquad init"
  exit 0
fi

if [ -f ".claude/squad.log" ]; then
  echo "DevSquad already initialized in this repo — skipping"
  exit 0
fi

echo ""
echo "DevSquad — Project Initializer"
echo "──────────────────────────────"
echo ""

read "PROJECT_NAME?Project name (e.g. IdeaPA): "
read "PREFIX?Ticket prefix (e.g. IDP): "
read "DESCRIPTION?One-line project description: "

echo ""
echo "Initializing $PROJECT_NAME ($PREFIX)..."
echo ""

mkdir -p .claude docs wireframes design logs src/__tests__

echo '{"last": 0}' > .claude/ticket-counter.json
echo '{}' > .claude/locks.json
touch .claude/squad.log .claude/messages.md .claude/suggestions.md

if [ ! -f ".gitignore" ]; then touch .gitignore; fi
grep -q "^/logs" .gitignore || echo "/logs" >> .gitignore
grep -q "^.env" .gitignore || echo ".env" >> .gitignore

DEVTOOLS_WORKFLOW=~/WebstormProjects/devtools/.github/workflows/pr-review.yml
if [ -f "$DEVTOOLS_WORKFLOW" ]; then
  mkdir -p .github/workflows
  cp "$DEVTOOLS_WORKFLOW" .github/workflows/pr-review.yml
  echo "  ✓ Copied pr-review.yml from devtools"
else
  echo "  ⚠ pr-review.yml not found in devtools — skipping"
fi

DEVTOOLS_PLAN=~/WebstormProjects/devtools/templates/implementation-plan.html
if [ -f "$DEVTOOLS_PLAN" ]; then
  sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{PREFIX}}|$PREFIX|g" "$DEVTOOLS_PLAN" > docs/implementation-plan.html
  echo "  ✓ Created docs/implementation-plan.html from devtools template"
else
  echo "  ⚠ implementation-plan.html template not found in devtools — skipping"
fi

cat > BACKLOG.md << BACKLOG
# Backlog — $PROJECT_NAME
Prefix: $PREFIX

## Active
_no tickets yet_

## Done
_nothing merged yet_
BACKLOG

cat > CLAUDE.md << CLAUDEMD
# $PROJECT_NAME — Project Context

## Project
$DESCRIPTION

## Ticket prefix
$PREFIX

## Stack notes
<!-- Add any deviations from global defaults here -->
<!-- If nothing deviates, delete this section -->

## Active agents
product, designer, fe-dev, be-dev

## Implementation plan
Progress is tracked in \`docs/implementation-plan.html\` — Matan opens it directly.
Update it in the same batch of work as closing any ticket: add the ticket with an
outcome + PR link and flip its badge; give a phase whose tickets are all done
\`class="phase done"\` (light green); keep the "You are here" marker directly after
the last finished phase. See the rules comment at the top of the file.
CLAUDEMD

GLOBAL_CLAUDE=~/.claude/CLAUDE.md
if [ -f "$GLOBAL_CLAUDE" ] && ! grep -q "$PROJECT_NAME" "$GLOBAL_CLAUDE"; then
  printf "\n### %s\n%s\n- Prefix: \`%s\`\n- Stack: see project CLAUDE.md\n" \
    "$PROJECT_NAME" "$DESCRIPTION" "$PREFIX" >> "$GLOBAL_CLAUDE"
  echo "  ✓ Registered in ~/.claude/CLAUDE.md"
fi

echo ""
echo "────────────────────────────────────────"
echo "✓ $PROJECT_NAME ($PREFIX) initialized"
echo ""
echo "  .claude/          ✓"
echo "  BACKLOG.md        ✓"
echo "  CLAUDE.md         ✓"
echo "  /wireframes       ✓"
echo "  /design           ✓"
echo "  /logs             ✓ (gitignored)"
echo "  pr-review.yml     ✓"
echo "  docs/implementation-plan.html ✓"
echo ""
echo "Start with:"
echo ""
echo "  claude --agent product 'initialize $PROJECT_NAME'"
echo ""
