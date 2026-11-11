# review-and-fix

A Claude Code skill that gets open pull requests merge-ready with subagents. You stay in one session as the coordinator; read-only reviewers find problems, the coordinator verifies them and batches the decisions only you can make, fixers apply the rest in isolated git worktrees, and reviewers check the fixes until nothing blocking remains. It can squash-merge at the end when you tell it to "merge at will". Type `rnf` to start it.

It also runs from Codex (as `codex exec` child processes in their own worktrees), and `SKILL.md` describes both hosts.

## How the loop works

1. **Scope.** The coordinator lists the PRs, their branches, bases, heads, stacking and file overlaps, and the task or issue each one implements. It passes the task text verbatim to every reviewer as the source of truth for intent, ahead of the implementer-written PR body.
2. **Review (parallel, read-only).** Per PR, the diff is split by files into up to 3 slices; one Sonnet reviewer per slice covers correctness, repo conventions and (on risky paths) security, and triages its own findings. Codex gives one independent pass over the whole diff. An optional Opus security reviewer runs with `+sec deep`, and an optional verifier runs a test command you pass (or a matching verification jig) in a detached worktree. Failing CI checks become findings.
3. **Merge findings in code.** Duplicates across reviewers are merged by file, line and wording; Codex-only findings are sorted by rule and marked not spot-checked so the coordinator confirms them before relaying.
4. **Decide.** Scope creep, missing specs, missing proof and other product calls come back as one batch of questions with recommended answers. Fixers that depend on an open decision wait.
5. **Fix.** One fixer per PR in an isolated worktree, using fixup commits, stacked PRs in order.
6. **Re-review.** One reviewer checks only the fixer diff and confirms each fix. The loop stops when no P0 to P2 finding remains or after 2 review rounds (3 on request), then a final cheap pass handles clearly right P3s.
7. **Merge (opt-in) and hand-off.** With "merge at will", clean PRs with green CI are squash-merged in stack order. Otherwise you get a table of PRs, the evidence behind each acceptance criterion, the merge order and any steps only you can do.

On top of the bug hunt, reviewers apply four adversarial rules: intent comes from the task, scope expansion goes to you as a decision, needless complexity is a defect, and claims need evidence (a behavior change with nothing exercising it can't be "ready").

Variants:

| You type | What runs |
| --- | --- |
| `rnf` | full review, fix, re-review loop |
| `rnf lite` | the cheap pass: one Sonnet reviewer plus Codex per PR |
| `rnf +sec` / `rnf +sec deep` / `rnf no sec` | force the security lens on, add an Opus security reviewer, or turn security off (default: on when changed paths look risky) |
| `rnf` plus "merge at will" | also squash-merge clean PRs |
| `review` / `review lite` | review only, no fixes |

## Cost

The current design uses lean, single-purpose reviewers: small agent types without MCP tools or skills in context, per-slice briefs with turn budgets, a Haiku runner for mechanical work, and dedupe and routing in code instead of in a model. That redesign cut token use by about 75% compared with the earlier version while still catching every P0 to P2 finding. A full review-and-fix run on a PR of about 9 files targets about 150k tokens, a small PR under about 80k. Codex stays on in the lite pass because, across 22 runs where both ran, Codex alone found 11 P2s with no P3 noise while the Claude reviewer alone found 4 P2s, 1 P1 and 58 P3s; it costs about 35k tokens per PR.

## Install

The skill has three parts. From the `review-and-fix` folder of a clone of this repo, copy each into `~/.claude`:

```sh
mkdir -p ~/.claude/skills/review-and-fix ~/.claude/agents ~/.claude/workflows
cp SKILL.md ~/.claude/skills/review-and-fix/
cp agents/*.md ~/.claude/agents/
cp workflows/*.js ~/.claude/workflows/
```

- `SKILL.md`: the coordinator's instructions (`~/.claude/skills/review-and-fix/`, or a project's `.claude/skills/review-and-fix/` for one project).
- `agents/`: the `rnf-reviewer`, `rnf-fixer` and `rnf-runner` subagent types (`~/.claude/agents/`). The workflows fail at the first agent without them.
- `workflows/`: the saved Claude Code workflows `review-and-fix`, `pr-review` and `pr-review-lite` (`~/.claude/workflows/`). `pr-review-lite.js` is `pr-review.js` with a different default and its own metadata; keep the bodies identical if you edit one.

Restart Claude Code after copying so it picks up the new agents and workflows.

## Requirements

- Claude Code with subagents, worktree isolation and the Workflow tool (saved workflows in `~/.claude/workflows/`). On a Claude Code build without workflows, the coordinator can follow the numbered steps in `SKILL.md` by hand with the Agent tool.
- git with worktree support, and a repo whose `origin` is on GitHub.
- The GitHub CLI (`gh`), authenticated, for PR refs, checks, comments and merges.
- The Codex CLI (`codex`), signed in, for the second-opinion reviewer. Optional: pass `codex: false` (or say so) to run without it.
- `jq`, used by the refs runner to read verification jigs.

## Verification jigs (optional)

A repo can add `verification/jigs.json` to tell the workflow how to prove changes in certain paths. When a PR has no explicit `verify` command, each jig whose `triggers` match a changed file runs in a detached worktree of the PR head:

```json
{
  "jigs": [
    {
      "id": "api-e2e",
      "covers": "API endpoints respond and enforce auth",
      "triggers": ["src/api/**", "src/auth/**/*.{ts,tsx}"],
      "needs": ["npm ci", "npm run stack:up"],
      "command": "npm run test:e2e -- --grep api",
      "teardown": ["npm run stack:down"]
    }
  ]
}
```

`command` exiting 0 is a pass. `teardown` is optional; without it, each `<x>:up` entry in `needs` implies `<x>:down`. Teardown runs even after a failure. Repos without the file get no jigs.

## License

MIT, see `LICENSE`.
