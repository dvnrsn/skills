# skills

Claude Code skills I use day to day, cleaned up for anyone to use. Each folder is one skill: copy it into `~/.claude/skills/` (every project) or a project's `.claude/skills/` (that project only).

| Skill | What it does |
|---|---|
| [record-clip](record-clip/) | Records an agent's browser check as a short Playwright video with a visible cursor and click rings, asserts every claim the clip makes, and saves it as an `.mp4` in a dated folder. |
| [review-and-fix](review-and-fix/) | Coordinates a review-then-fix loop over open PRs: parallel read-only Claude and Codex reviewers, findings verified and deduped, decisions batched for you, fixers in isolated worktrees, re-review until nothing blocks, optional squash-merge. Includes the subagent types and saved workflows it runs (install steps in its README). |

MIT licensed.
