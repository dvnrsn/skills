---
name: review-and-fix
description: Coordinate a review-then-fix loop over one or more open PRs using subagents. Read-only reviewers in parallel (from Claude Code, a Claude reviewer and a Codex reviewer per PR), the coordinator verifies and merges findings and batches decisions for the user, fixers apply changes in isolated worktrees, then reviewers run again until nothing blocking remains; optionally squash-merges when told "merge at will". Works from Claude Code and Codex. Use when asked to "review and fix", "review then execute", "spin up reviewers and fixers", "run the review loop", to get PRs merge-ready with subagents, or the shorthand "rnf" (typed on its own). Adds a security lens on risky PRs; "rnf +sec" forces it on, "rnf +sec deep" adds a separate Opus security reviewer, "rnf no sec" turns it off. "rnf lite" uses the cheap pass: one Sonnet reviewer plus Codex. Review only, no fixes: "review" or "review lite" (typed on their own). In Claude Code these run as saved workflows (review-and-fix, pr-review, pr-review-lite).
---

You are the coordinator. Subagents do the reading, reviewing, and editing. You verify, decide what goes to the user, and track state. Don't review or fix code yourself beyond spot-checks.

## Running in Claude Code vs Codex

The steps below are tool-neutral. Map them to your host:

- **Claude Code.** Reviewers: per PR, a Claude reviewer (Agent tool, `rnf-reviewer` type, `run_in_background`) plus a Codex reviewer (`codex exec`, recipe in step 1), launched together. Fixers: Agent tool, `rnf-fixer` type, with `isolation: "worktree"`, in the background. Continue a finished agent with SendMessage.
- **Codex.** Codex has a native multi-agent tool (`multi_agent` feature: `spawn_agent`, `send_input`, `wait_agent`, `close_agent`), but spawned agents share the parent's working directory and have no worktree isolation. So run each reviewer and fixer as a `codex exec` child process in its own git worktree, in the background, and read its `-o` output file when it exits. Reviewers use the step 1 recipe. Fixers: `git worktree add -b rnf-pr-<N> <scratch>/fix-pr-<N> origin/<branch>`, then `codex exec -s workspace-write -C <scratch>/fix-pr-<N> --add-dir <repo>/.git --ephemeral -o <scratch>/fix-pr-<N>.md "<fixer brief>"` (`--add-dir` because a worktree's git metadata lives in the main repo's `.git`). The workspace-write sandbox usually has no network, so the coordinator pushes from the worktree after reading the report. There is no Claude reviewer on this path; run the security reviewer (step 0) as another read-only `codex exec` with its own brief, and the verifier as a `codex exec -s workspace-write` in its own worktree (no network or browser there, so criteria that need the running app come back "not exercised").

`<scratch>` is the coordinator's scratchpad (Claude Code lists one) or a fresh `mktemp -d` directory.

## Claude Code: run it as a workflow

In Claude Code, steps 0 to 6 are saved Workflow scripts in `~/.claude/workflows/`. The user invoking this skill (or typing one of the triggers below) is their opt-in to running a workflow, so call the Workflow tool directly; don't ask first. The steps below stay the reference for what the scripts do and for the Codex host.

| The user types | Workflow `name` | Extra `args` |
| --- | --- | --- |
| `rnf` | `review-and-fix` | |
| `rnf lite` | `review-and-fix` | `lite: true` (one Sonnet reviewer plus Codex; `codex: false` drops Codex; plus `verify` when the user gives a test command) |
| `rnf +sec` / `rnf +sec deep` / `rnf no sec` | `review-and-fix` | `security: "on"` / `"deep"` / `"off"` |
| `rnf` plus "merge at will" | `review-and-fix` | `merge: true` |
| `review` | `pr-review` | |
| `review lite` | `pr-review-lite` | (Codex runs by default, `codex: false` drops it; `security: "on"` with `+sec`; `verify` when the user gives a test command) |

Always pass `date` (today, YYYY-MM-DD; scripts can't read the clock), plus `prs` (required: a JSON array of PR numbers like `[123]`, never a bare string or omitted; pass `all: true` instead only when the user asks for every open PR of theirs), `repo` (absolute path, default the current directory) and `project` (a short name for the repo) when known.

Pass what you already know as `scope: {"<PR>": {intent, taskText, base, branch, head, criteria}}` (for a single PR, top-level `intent`, `taskText`, `base`, `branch`, `head` work too). The workflows have no scope agent and never read your issue tracker: read the linked task or issue yourself (for example `gh issue view`, or your tracker's tools) and pass its title and description verbatim as `taskText`; without it every PR gets the "No spec" decision. `intent` is a few sentences on what the PR should do, and `criteria` 2 to 5 checkable acceptance criteria (otherwise the first slice reviewer writes them). Refs, the diff file list and CI state come from one Haiku runner (`gh pr view`, `git diff --numstat`, `gh pr checks`), skipped only when `scope` also carries `base`, `branch`, `head`, `title` and `files` (and `jigs`, an array, unless `verify` or `jigs: false` is passed) for every PR.

`security` defaults to `auto` on the full review and to off on lite: `auto` turns on the security lens in the slice reviewers when a changed path hits a security trigger (auth, sessions, middleware, API and server code, migrations and schema, uploads, redirects, env and secrets, CI workflows, Docker, dependencies, payments), `on` forces the lens, and `deep` adds a separate Opus security reviewer per PR; use `deep` only for real auth, production data or secret changes. `maxRounds` (review-and-fix, default 2, max 3) counts review rounds, so the default is one review plus one re-review of the fixes, and `maxRounds: 1` is review only. `rereviewMode: "full"` adds Codex to re-review rounds. Pass `asks: {"<PR>": ["<the user's verbatim message>"]}` when the user asked for things the task does not say. On a rerun after the user answers decisions, pass them as `settled: {"<PR>": ["<decision as a settled fact>"]}` so reviewers stop raising them and fixers treat them as facts. `verify` is a shell command, or a map `{"<PR>": "<command>"}`: one cheap verifier per PR runs it in a detached worktree of the PR head and marks the criteria it covers as passed or failed with an output summary; review-and-fix passes it to every round. Without it criteria stay "not exercised".

### Verification jigs

When no `verify` is passed for a PR, the refs runner also reads `verification/jigs.json` at the PR head, an optional per-repo registry of verification commands (format in the README). The workflow matches each jig's `triggers` globs (picomatch style, `{a,b}` braces) against the PR's changed files in code, and for each matching jig one verifier runs its `needs`, then its `command` (exit 0 is a pass), then a teardown, in a detached worktree of the PR head. Teardown is a `teardown` array if the jig has one, else each `<x>:up` need implies `<x>:down`, and it runs even after a failure. One PR's jigs run one at a time; no jig matches means no extra agent. A failing jig is a Verify finding like a failing `verify` command, a passing jig counts as proof, the agent label is `verify <jig id> #<PR>`, and any clip path it prints comes back in `clips`. An explicit `verify` wins over jigs for that PR, and `jigs: false` skips them. Re-review rounds match jigs against the fixer diff only. A repo without `verification/jigs.json` simply gets no jigs.

What each one does:

- `pr-review`: the diff is split by files into slices (1 slice under about 400 changed lines, 2 under about 1000, else 3; lock and generated files are skipped), sorted by path so a directory stays together. One Sonnet reviewer per slice runs that slice's `git diff` itself, reads surrounding code only as needed, covers correctness, conventions and (with the lens on) security, and triages its own findings into fix now, decisions and out of scope. Codex is the independent second opinion: one `codex exec --output-schema` run over the whole diff per PR, started by a Haiku runner. Findings are deduped in code (same file and nearby lines with overlapping wording); Codex findings that match a reviewer finding add "Codex" to its reviewers, and Codex-only ones are sorted by rule (pre-existing or speculative to out of scope, scope to a decision, the rest to fix now with `spotChecked: false`). A failing CI check becomes a fix-now finding, and "No spec" and "Missing proof" are enforced in code. No in-review browser check: `browserCheck` says what a separate one should prove. `heads: {"<PR>": "<sha>"}` reviews a past head. Read-only.
- `pr-review-lite`: the same script (body kept identical, only the default differs) with one slice plus the Codex pass (`codex: false` turns Codex off), and security off unless asked. Same output shape. Read-only. Codex is on in lite because in 22 runs where both ran, Codex alone found 11 P2s with no P3 noise while Claude alone found 4 P2s, 1 P1 and 58 P3s; it costs about 35k tokens.
- `review-and-fix`: round 1 with `pr-review` (`lite: true` for the lite path, which keeps Codex unless `codex: false`), fixers in isolated worktrees on every PR with fix-now findings and no blocking decision, then a re-review of only the fixer diff (`git diff <pre-fix head> <new head>`) by one slice reviewer and no Codex, until no P0 to P2 fix-now finding remains or `maxRounds` review rounds pass. Then one final pass for cheap P3 fix-now items, and the step 6 merge only with `merge: true`. Decisions are collected and returned in `decisionsForUser`, never decided by the workflow.

Turn budgets: slice reviewers get about 8 turns, fixers about 12 and runners about 4 in their briefs, backed by hard `maxTurns` caps in the agent definitions (reviewer 10, fixer 16, runner 8). An agent that hits its cap returns nothing and shows up in `reviewerGaps`. Agent labels start with a stable role (`runner`, `slice-sonnet`, `codex`, `security-opus`, `verify`, `fixer`).

Target cost: about 150k tokens for a full review-and-fix run on a PR of about 9 files, under about 80k for a small PR.

### Adversarial review rules

Both review workflows apply four rules on top of the bug hunt:

- **Intent comes from the task.** The coordinator reads the linked task or issue and passes `taskText` in `scope` (title and description verbatim, about 4000 characters max); `asks` adds the user's own words the task lacks. Every reviewer brief carries both as the source of truth for intent, separate from the implementer-written PR body. No task and no asks becomes the decision "No spec to review against" (settle it with an entry containing "spec").
- **Scope expansion goes to the user.** Diff work that neither `taskText` nor `asks` calls for becomes a "keep, split out, or drop" decision with a recommendation, never fix-now and never silently accepted. Gaps between them and the PR body are findings.
- **Complexity is a defect.** Reviewers actively look for `simplify` findings (single-caller abstractions, unused configurability, a duplicated helper, defensive branches for impossible states, a smaller diff that does the same). Reviewers rank them above polish and put cheap, clearly right ones in fix-now.
- **Claims need evidence.** PR body claims with no test, command output or clip behind them are `unproven` findings. A PR that changes behavior with no exercised criterion cannot be `ready`: it becomes `needs-decision` with "Missing proof" as the decision (the workflow enforces this in code too when no test file is in the diff and no `verify` passed). Settle it with a `settled` entry containing "proof" (for example "proof accepted: checked by hand on staging").

Findings carry a `category` (bug, security, scope, simplify, unproven, convention, polish).

### Lean agent types

The scripts run every agent as one of the `rnf-*` types in `~/.claude/agents/`: `rnf-reviewer`, `rnf-runner` and `rnf-fixer`. Their `tools` lists keep MCP schemas and the skills list out of each agent's context (about 13k tokens at startup instead of about 51k in one setup with several MCP servers). CLAUDE.md files still load. Because there are no skills, reviewers review by hand instead of through `/code-review` and `/security-review`. If the types are missing, the workflows fail at the first agent: install them first.

### Browser proof (outside review)

Reviews don't run the app. When a PR's `browserCheck` is set and the change needs proof in the running app, launch one background subagent per PR after the review returns: the repo's way of running the app locally plus a recording skill such as `record-clip`, exercising what `browserCheck` names. It never sets platform env vars locally (`VERCEL*`, `NODE_ENV=production`): a local process that thinks it is staging or production may report to production monitoring or touch production data. A failure becomes a fix-now item on the next round; it never blocks the review.

After the workflow returns, the coordinator still does the parts that need the user: report each PR briefly (step 2), spot-check fix-now items with `spotChecked: false` (Codex-only findings) before relaying them, post each round's `commentDrafts` on its PR, ask the batched `decisionsForUser` in one round (step 3) and rerun with `settled` if fixes depend on them, relay returned `clips` and `userSteps`, and give the step 7 hand-off.

## 0. Scope

Identify every PR in scope (`gh pr list --author @me`, or the ones the user named). For each, note branch, base, head sha, whether it's stacked on another PR, and the ticket or spec it implements (linked issue or task, or the goal from the conversation). If two PRs touch the same files, note the overlap now: it decides fix order later.

### Verification target

For each PR, write 2 to 5 checkable acceptance criteria, taken from the linked task's acceptance criteria and the PR body (e.g. "an admin can undo a discount and the total updates"; "a user gets 403 on another user's record"). If a PR has no clear target, don't guess one: put it in the step 3 questions.

### Review depth

The Claude reviewer reviews every PR. Pick its effort per PR and state it next to the security decision:

- `low` or `medium`: UI, styling, copy, docs, small refactors.
- `high`: the PR hits any security trigger below, or the diff is large.
- `max`: auth, payments/pricing math, migrations, or anything hard to roll back.

### Security pass

Decide per PR whether it gets a security reviewer, and state the decision with a one-line reason in your plan and status output (e.g. "#412: security pass, new endpoint takes a record ID from the URL").

- Run it when the diff touches any of: auth, sessions, roles, or permission/visibility checks (e.g. admin vs regular user access); new or changed API endpoints, especially ones taking request input or IDs from URLs; DB queries, migrations, raw SQL; file uploads, file paths, redirects, HTML rendered from user content; secrets, env config, CI workflows, Docker, infra; new dependencies or major dependency upgrades; payments, pricing, or personal data.
- Skip it for pure UI/styling, docs, and test-only PRs.
- Overrides: "rnf +sec" runs it on every PR in the run; "rnf no sec" turns it off.

It scopes to the PR diff and complements repo-level scanners and security audit jobs; it doesn't replace them.

## 1. Review round (parallel, read-only)

Launch every reviewer in a single message, in the background. From Claude Code that is two per PR (the Claude reviewer and the Codex reviewer), plus the security reviewer on PRs that qualify for one (step 0). Each reviewer brief contains:

- PR number, branch, base, head sha, repo path. "Read-only: no edits, commits, pushes, or GitHub comments."
- How to review it. Claude reviewer: read the repo CLAUDE.md, `git diff origin/<base>...origin/<branch>`, and the changed files with `git show origin/<branch>:<path>` (the local checkout may be behind), check the diff against the PR intent and conventions below, and report in the required format. Codex reviewer: local only, `git diff origin/<base>...HEAD` and the files in its worktree; it doesn't fetch remote PR metadata, so the brief itself carries the intent and the base ref.
- What the PR is supposed to do, in a few sentences, plus the spec/ticket so the reviewer checks the code against intent, not just style.
- A ranked focus list specific to this PR: security/authorization first, then correctness, then data/migration safety, then conventions. Name the risky areas you already suspect (guards, migrations, uploads, anything touching auth or money).
- Overlapping PRs: name them and ask the reviewer to note merge interactions without reviewing them.
- The user's conventions that apply (from global and repo CLAUDE.md / AGENTS.md), so the reviewer checks them.
- Required output: ranked findings (P0 to P3) with file:line, a concrete failure scenario, and a suggested fix; only verified findings, speculation labeled; an explicit "nothing blocking" when that's the verdict.

Codex reviewer recipe (coordinator runs it; `git fetch origin` first):

```sh
git worktree add --detach <scratch>/codex-pr-<N> origin/<branch>
codex exec -s read-only -C <scratch>/codex-pr-<N> --ephemeral \
  -o <scratch>/codex-pr-<N>.md "<review brief>" < /dev/null   # run in the background
git worktree remove --force <scratch>/codex-pr-<N>  # after it exits
```

Use `codex exec`, not `codex review --base`: `codex review` has no `-o`, `-s`, or `-C`, so it can't be pinned read-only to the worktree or write a clean report file, and its built-in prompt doesn't carry the PR intent and focus list. Always redirect stdin from `/dev/null`: in a background shell `codex exec` otherwise waits forever on "Reading additional input from stdin...". If the Bash sandbox blocks `codex` (network or `~/.codex` writes), rerun that one command outside the sandbox rather than dropping the Codex reviewer.

Security reviewer (Claude Code): an Agent of the `rnf-reviewer` type on Opus, in the background. Brief: same PR details, read-only rule, and intent as above; read `git diff origin/<base>...origin/<branch>` and trace request input through the changed code for authz gaps, session and login flaws, injection, open redirects, secret handling and data exposure. Report findings in the required format or an explicit "no security findings". On a stacked PR, drop findings from the lower PR's commits.

Security reviewer (Codex host): Codex has no `/security-review`, so run the Codex reviewer recipe with a hand-written brief that follows the same approach: authz bypasses, injection, unsafe file/redirect/HTML handling, secret exposure, risky dependency or CI changes. High confidence, low noise: each finding needs a concrete attack path through the changed code; skip theoretical hardening, pre-existing issues the diff doesn't touch, and style. Same P0 to P3 output format, or an explicit "no security findings".

CI and browser proof: reviewers don't run tests, typecheck or build; read `gh pr checks N` and turn a failing check into a finding. Proof in the running app is the separate background browser check above, never part of the review round, and never with platform env vars (`VERCEL*`, `NODE_ENV=production`) set locally. A criterion nobody exercised is "not exercised", never a pass.

On a second or later round, also list what the previous fixes were meant to do and ask for a "fixes verified" checklist plus anything the fixes introduced. The Claude reviewer then reviews only the fixer diff (`git diff <pre-fix head sha> origin/<branch>`).

## 2. Verify and triage (coordinator)

As each PR's reviews land (wait for all of that PR's reviewers before triaging it):

- Merge the reports into one list. Dedupe findings that describe the same defect, keep the higher priority, and mark which reviewer(s) found each (Claude, Codex, Security, Verify). Each failed criterion becomes a Verify finding. Security and Verify findings go through the same verification, triage, and fixer loop as the rest. Agreement raises confidence; it doesn't replace verification.
- Spot-check every P0/P1/P2 yourself with one targeted read (`git show origin/<branch>:<file> | sed -n ...`, a grep), whichever reviewer found it. Don't relay a blocking finding you haven't confirmed. Say which ones you checked.
- Sort findings into: fix now (blocking, or cheap and clearly right), product decisions for the user, and out of scope (pre-existing bugs that deserve their own PR or ticket, or polish not worth the churn).
- Pre-existing bugs that the PR makes worse go to a separate PR and ticket, not folded into the feature PR, unless the user says otherwise.
- Report each review to the user briefly as it lands: what blocks, what's fine, what's optional, and where the reviewers disagreed.
- Post each finished review on its GitHub PR (`gh pr comment N`): only the ideas, meaning the verified findings as suggestions with file:line and which reviewer(s) found each, and open questions. No recap of the PR, no verdict line, no list of what was checked. Leave out unconfirmed speculation. On someone else's PR, keep it to the code: no asks about their process. Follow any comment conventions the user has (a signature, for example). Post as a comment, not a GitHub approve/request-changes review, unless the user asks. On re-review rounds, post the "fixes verified" checklist the same way.

## 3. Batch decisions

Collect every product or scope decision from all reviews into one round of questions, each with a recommended answer. Typical ones: a PR with no clear verification target, a "not exercised" criterion (the user accepts it or checks it themselves), data retention, where a fix belongs, whether to tell a stakeholder. Things that are expensive to change later (an unreleased migration, a public API shape) must be decided before fixers start. Ask in plain text if the user has said the question UI is hard to read in their terminal.

Don't start fixers whose work depends on an open decision. Independent fixers can start right away.

## 4. Fix round (one fixer per PR, isolated)

Launch fixers in isolated worktrees, in the background, parallel where PRs don't overlap (Claude Code: Agent tool with `isolation: "worktree"`; Codex: `codex exec -s workspace-write` per the host section). For stacked or overlapping PRs, fix the lower PR first, then have one fixer rebase the upper PR onto it and apply its own fixes.

Each fixer brief contains:

- PR number, branch, head sha, and how to get onto it in a fresh worktree.
- The verified findings to fix, each with file:line, the failure scenario, and the intended fix. State decisions the user made as settled facts.
- What not to touch (files owned by an overlapping PR).
- Commit strategy: `git commit --fixup=<sha>` (or `--fixup=amend:<sha>` when the original message becomes wrong) onto the commit each fix belongs to, or a new commit for genuinely new work; push normally without force. Only a rebase (stacked PR) gets `--force-with-lease`, followed by autosquash so the branch ends as a few clean commits with accurate messages.
- Update the PR description when scope grows (load the user's PR-writing skill if one exists). For any step only the user can do (production migration, token permissions, secrets), say it plainly in the PR body.
- Run the repo's typecheck once before pushing if the change is risky.
- The user's writing, comment, style, and attribution rules from CLAUDE.md, restated briefly.
- Before committing, reread the fixer's own diff only: delete or tighten comments that restate the code and drop needless suppressions. Don't reshape code beyond the findings; list anything else as open items in the report instead.
- Report back: commits pushed (sha + subject), what changed per finding, check results, anything skipped or uncertain.

### Rules every agent brief needs (learned the hard way)

- Hooks may rewrite `git` (e.g. a token-saving command proxy like rtk) and the worktree isolation check then blocks it. Tell agents to fall back to `/usr/bin/git`.
- A branch can be checked out in only one worktree. Tell fixers to work on a local branch name of their own and push with `git push origin HEAD:<remote-branch>`.
- Parallel agents share the scratchpad. Tell each to use a scratch path unique to it (inside its worktree) for commit messages and PR bodies.
- Worktrees lack untracked env files. If typecheck fails only on missing env/secret types, copy the example env file in, run it, delete it, and revert any regenerated generated-types file.
- `git commit --fixup` can't be combined with `-F`. If the sandbox blocks other forms, writing the `fixup! <original subject>` line by hand works with autosquash.
- Never deploy, never touch production data, never start a dev server unless the user's rules allow it (the background browser check may run the app locally and must bring it down when done). Hand production steps to the user.

## 5. Re-review until clean

After fixes land, run step 1 again on every PR that changed. Rerun the security reviewer on a PR only if it had security findings or the fixes touched step 0 trigger areas. Repeat steps 2 to 4 for anything new. A PR is done only when every verification criterion passes (or is "not exercised" and the user accepted it in step 3) and no blocking findings remain. Cap it at two review rounds per PR by default (one re-review, of the fixer diff only), three when the user asks for more; if something still blocks after that, stop and hand it to the user with the open findings.

Optional P3s: fix the cheap, clearly-right ones in one small final fixer pass; mention the rest and drop them. A verified P3 that a fixer can do in under about 30 minutes (a dead allowlist entry, a missing filter, a missing test) is fix-now, not a PR comment: leaving clearly-right fixes as optional comments defeats the point of the loop. Post a finding as "optional" only when it's a judgment call the user or a teammate has to make, and say in it whose call it is.

**Say what each review pass covered.** After a fixer pass, leave one short PR comment naming the re-review's scope and what was skipped and why, e.g. "Re-review: fixer diff only (abc123..def456), one Sonnet reviewer, nothing new. Codex and full-PR re-review skipped: fix is a few lines plus a test; round 1 covered the rest with Codex." Use the same line in the report to the user. Keep it short, but make the care visible: what was checked, by whom, and the reason for anything skipped, so a reader sees a deliberate quality call rather than a shortcut.

## 6. Merge (only when told "merge at will" or similar)

Without that instruction, stop at step 7 and let the user merge. With it, for each PR that is done per step 5 and whose CI is green (`gh pr checks N`), in merge order:

- Autosquash any fixup commits first if the branch still has them, and wait for CI on the new head.
- `gh pr ready N` if it's a draft.
- `gh pr merge N --squash --match-head-commit <head sha> --subject "<subject>" --body "<body>"` with a hand-written subject and body (what the PR does and why, not the commit list), following the user's and repo's commit message rules.
- Retarget any stacked PR onto the base before merging it.

The harness permission classifier may block merges. If it does, stop: don't retry or work around it. Tell the user which PRs are ready and give the exact merge command for each.

## 7. Hand-off

End with:

- A table of PRs: number, what it does, state (merged, ready, needs fixup squash, stacked on #N, blocked on a user step).
- Per PR, the verification target and the evidence for each criterion (pass, fail, or not exercised and why), so merge decisions rest on proof.
- Merge order, including autosquash of fixup commits, stacked PR retargeting, and any step that must happen before a merge (production migration, token permission).
- Steps only the user can do, as exact commands or dashboard paths.
- New tickets created along the way, with links.

Report outcomes faithfully. If a check was skipped or only partly run (no browser testing, typecheck run with a temporary env file, a Codex reviewer that failed to run), say so.
