export const meta = {
  name: 'review-and-fix',
  description: 'Review open PRs with pr-review (sliced diff, Codex second opinion), fix fix-now findings in isolated worktrees, re-review only the fixer diff (1 re-review round by default), collect decisions for the user, squash-merge only when told to',
  whenToUse: 'The rnf skill. Needs the rnf-* agent types in ~/.claude/agents. Args: date (required), prs, repo, project, scope ({"<PR>": {intent, taskText, base, branch, head, criteria}}; top-level intent/taskText for a single PR), lite (one slice plus Codex), codex (false turns Codex off in round 1), security (auto|on|off|deep), maxRounds (review rounds, 1 to 3, default 2: one review plus one re-review), rereviewMode (lite|full; full adds Codex to re-reviews), settled, asks ({"<PR>": ["<verbatim user message>"]}, passed to every review round), merge, verify (command or {"<PR>": "<command>"}, passed to every review round), jigs (false to skip the verification/jigs.json jigs that run when no verify is given)',
  phases: [
    { title: 'Review', detail: 'round 1 via pr-review (lite: one slice plus Codex); re-review rounds: one slice reviewer on the fixer diff, no Codex' },
    { title: 'Fix', detail: 'one fixer per PR in an isolated worktree; overlapping and stacked PRs in order' },
    { title: 'Polish', detail: 'one final pass for cheap P3 fix-now items on clean PRs' },
    { title: 'Merge', detail: 'only with merge: true; squash-merge clean PRs with green CI, in merge order' },
  ],
}

const A = typeof args === 'string' ? (args.trim().startsWith('{') ? JSON.parse(args) : { prs: args }) : (args || {})
const toPrs = v => v == null ? [] : (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map(p => String(p).replace(/^#/, '')).filter(Boolean)
if (!toPrs(A.prs).length && A.all !== true) throw new Error('args.prs is required (e.g. [952] or "952,953"); pass all: true to review every open PR')
if (!A.date || !/^\d{4}-\d{2}-\d{2}$/.test(A.date)) throw new Error('args.date (YYYY-MM-DD) is required')
const MAX_ROUNDS = Math.min(3, Math.max(1, Number(A.maxRounds) || 2))
const FIRST_MODE = A.lite ? 'lite' : 'full'
const REREVIEW_MODE = A.rereviewMode === 'full' ? 'full' : 'lite'
const SECURITY = A.security || 'auto'
const SETTLED = A.settled || {}
const MERGE = A.merge === true

const GIT_RULE = 'If a git command is blocked or rewritten by a hook (some command-rewriting hooks break the worktree isolation check), use /usr/bin/git directly.'
const NO_PROD = 'Never deploy, never touch or query production data or production systems; hand any production step to the user as an exact command.'
const ATTRIBUTION = 'Follow the user\'s and the repo\'s commit message and attribution rules (CLAUDE.md, AGENTS.md, CONTRIBUTING).'

const isBlockingSeverity = s => s === 'P0' || s === 'P1' || s === 'P2'

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean' },
    preFixHead: { type: 'string', description: 'origin head sha before your first commit' },
    newHead: { type: ['string', 'null'], description: 'origin head sha after your push' },
    forcePushed: { type: 'boolean', description: 'true only for a stacked-PR rebase with --force-with-lease' },
    commits: {
      type: 'array',
      items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] },
    },
    perFinding: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'skipped'] },
          change: { type: 'string', description: 'what changed, file:line, or why skipped' },
        },
        required: ['title', 'status', 'change'],
      },
    },
    checks: { type: 'string', description: 'typecheck/tests run and results, or "none run"' },
    prBodyUpdated: { type: 'boolean' },
    userSteps: { type: 'array', items: { type: 'string' }, description: 'steps only the user can do (production migration, secrets, token permissions)' },
    openItems: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['pushed', 'preFixHead', 'newHead', 'forcePushed', 'commits', 'perFinding', 'checks', 'prBodyUpdated', 'userSteps', 'openItems', 'notes'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    mergeSha: { type: ['string', 'null'] },
    blockedBy: { type: ['string', 'null'], description: 'CI red, permission classifier, head moved, pre-merge step, etc.' },
    command: { type: ['string', 'null'], description: 'exact merge command for the user when not merged' },
    notes: { type: 'string' },
  },
  required: ['merged', 'mergeSha', 'blockedBy', 'command', 'notes'],
}

const SCOPE_KEYS = ['intent', 'taskText', 'base', 'branch', 'head', 'criteria', 'title']

// Re-review rounds drop head, files and jigs: the fixer moved the head, so pr-review re-reads refs.
function scopeArg(prs, rereview) {
  const out = { ...(A.scope || {}) }
  if (prs.length === 1 && SCOPE_KEYS.some(k => A[k] != null)) {
    out[prs[0]] = { ...Object.fromEntries(SCOPE_KEYS.filter(k => A[k] != null).map(k => [k, A[k]])), ...(out[prs[0]] || out[String(prs[0])] || {}) }
  }
  if (!rereview) return out
  return Object.fromEntries(Object.entries(out).map(([k, v]) => {
    const { head, files, checks, jigs, ...rest } = v || {}
    return [k, rest]
  }))
}

async function runReview(mode, prs, extra) {
  const name = 'pr-review'
  const rereview = !!extra.rereview
  const childArgs = {
    date: A.date,
    prs: prs.map(String),
    ...(A.all === true && !prs.length ? { all: true } : {}),
    lite: mode === 'lite',
    ...(rereview ? { codex: REREVIEW_MODE === 'full' } : A.codex === false ? { codex: false } : {}),
    security: SECURITY,
    settled: SETTLED,
    scope: scopeArg(prs.map(Number), rereview),
    ...(A.asks ? { asks: A.asks } : {}),
    ...(A.project ? { project: A.project } : {}),
    ...(A.verify ? { verify: A.verify } : {}),
    ...(A.jigs === false ? { jigs: false } : {}),
    ...extra,
  }
  try {
    return await workflow(name, childArgs)
  } catch (e) {
    log(`${name} failed: ${e && e.message ? e.message : e}`)
    return null
  }
}

const state = {}
const roundsLog = []
let repoPath = A.repo
let project = A.project

function record(review, round) {
  if (!review) return
  repoPath = review.repoPath || repoPath
  project = review.project || project
  roundsLog.push({ round, mode: review.mode, prs: review.prs.map(t => t.pr), failed: review.failed || [], unresolved: review.unresolved || [] })
  if ((review.unresolved || []).length) log(`Round ${round}: unresolved ${review.unresolved.join('; ')}`)
  for (const t of review.prs) {
    const s = state[t.pr] || (state[t.pr] = { pr: t.pr, rounds: [], fixes: [], decisions: [], status: 'open', userSteps: [], openItems: [] })
    if (!s.criteria && t.criteria && t.criteria.length) s.criteria = t.criteria
    if (!s.browserCheck && t.browserCheck) s.browserCheck = t.browserCheck
    s.rounds.push({ round, mode: t.mode, verdict: t.verdict, summary: t.summary, fixesVerified: t.fixesVerified || [], commentDraft: t.commentDraft, reviewerGaps: t.reviewerGaps })
    s.last = t
    if (t.mode === 'full') { s.lastFull = t; s.lastFullRound = round }
    for (const d of t.decisions) {
      if (s.decisions.some(x => x.question === d.question)) continue
      s.decisions.push({ ...d, round })
    }
  }
  for (const n of review.failed || []) {
    const s = state[n] || (state[n] = { pr: n, rounds: [], fixes: [], decisions: [], status: 'open', userSteps: [], openItems: [] })
    s.status = 'review-failed'
  }
}

function isClean(t) {
  return !t.fixNow.some(f => isBlockingSeverity(f.severity)) && !t.criteria.some(c => c.result === 'fail')
}

function blockingDecision(t) {
  return t.decisions.find(d => d.blocksFixes || d.expensiveLater) || null
}

function hadSecurityFindings(t) {
  return t.fixNow.some(f => f.category === 'security' || f.reviewers.includes('Security'))
}

function fixGroups(prNumbers) {
  const set = new Set(prNumbers)
  const parent = Object.fromEntries(prNumbers.map(n => [n, n]))
  const find = n => (parent[n] === n ? n : (parent[n] = find(parent[n])))
  for (const n of prNumbers) {
    const t = state[n].last
    for (const o of [...t.overlaps, t.stackedOn].filter(x => x && set.has(x))) parent[find(n)] = find(o)
  }
  const groups = {}
  for (const n of prNumbers) (groups[find(n)] = groups[find(n)] || []).push(n)
  const depth = n => {
    let d = 0
    let cur = state[n].last.stackedOn
    while (cur && state[cur] && d < 20) { d++; cur = state[cur].last.stackedOn }
    return d
  }
  return Object.values(groups).map(g => g.sort((a, b) => depth(a) - depth(b) || a - b))
}

function fixerPrompt(n, findings, rebaseOnto, final) {
  const t = state[n].last
  const settled = SETTLED[n] || []
  const others = (t.overlaps || []).filter(o => o !== n)
  const list = findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} at ${f.file}${f.line ? ':' + f.line : ''} (found by ${f.reviewers.join(', ')}${f.spotChecked === false ? '; not spot-checked: confirm it with one read before changing code, skip it if it is wrong' : ''})
   Scenario: ${f.scenario}
   Intended fix: ${f.suggestedFix}`).join('\n')
  return `You are the fixer for PR #${n} "${t.title}" in ${repoPath}. Branch ${t.branch}, base ${t.base}, expected head ${t.head}.${final ? ' This is the final polish pass: only the cheap P3 items below.' : ''}
${GIT_RULE} ${NO_PROD}

Get onto it: \`/usr/bin/git fetch origin\`, check that origin/${t.branch} is still at ${t.head} (if it moved, stop and report pushed: false with the new sha in notes), then \`/usr/bin/git checkout -b rnf-fix-${n} origin/${t.branch}\`. A branch can be checked out in only one worktree, so keep that local name and push with \`/usr/bin/git push origin HEAD:${t.branch}\`.
${rebaseOnto ? `This PR is stacked on #${rebaseOnto.pr}, which just got fixes: first rebase onto origin/${rebaseOnto.branch} (\`/usr/bin/git rebase origin/${rebaseOnto.branch}\`), resolve conflicts, and push that rebase with \`--force-with-lease=${t.branch}:${t.head}\`. That is the only force-push allowed; set forcePushed true.\n` : ''}
Verified findings to fix:
${list}
${settled.length ? `Decisions the user made (settled facts): ${settled.join('; ')}\n` : ''}${others.length ? `Do not touch files owned by overlapping PRs ${others.map(o => '#' + o).join(', ')} beyond what a finding requires.\n` : ''}
Rules:
- Commit strategy: \`git commit --fixup=<sha>\` (or \`--fixup=amend:<sha>\` when the original message becomes wrong) onto the commit each fix belongs to, or a new commit for genuinely new work. --fixup cannot be combined with -F; if the sandbox blocks other forms, write the \`fixup! <original subject>\` subject by hand. Push normally, never force (the stacked rebase above is the only exception). Do not autosquash now.
- ${ATTRIBUTION}
- Use a scratch path unique to you inside this worktree (untracked) for commit messages and PR bodies; parallel agents share the session scratchpad.
- Before committing, reread your own diff only: delete comments that restate the code, tighten the rest, drop needless lint or type suppressions. Do not reshape code beyond the findings; list anything else you would change in openItems.
- Follow the comment, style and writing rules in the user's and the repo's CLAUDE.md.
- If the change is risky, run the repo's typecheck once before pushing. Worktrees lack untracked env files: if typecheck fails only on missing env or secret types, copy the example env file in, run it, delete it, and revert any regenerated generated-types file. Do not start dev servers.
- If the fix grows the PR's scope, update the PR description (\`gh pr edit ${n} --body-file <file>\`; follow a PR-writing skill if the user has one). Say any step only the user can do (production migration, secrets, token permissions) plainly in the PR body and in userSteps.
- No GitHub comments or reviews, no issue tracker writes; the coordinator handles those.
- If a finding turns out wrong or needs a product call, skip it and say why in perFinding.
Budget: about 12 turns including the final structured output call; batch independent reads and edits into one turn (parallel tool calls), and report what you have rather than run out.
Report commits pushed (sha + subject), what changed per finding (one perFinding entry per finding above, same title), check results, and anything skipped or uncertain.`
}

async function fixOne(n, findings, rebaseOnto, final, phaseName) {
  const res = await agent(fixerPrompt(n, findings, rebaseOnto, final), { label: `fixer #${n}${final ? ' polish' : ''}`, phase: phaseName, schema: FIX_SCHEMA, isolation: 'worktree', agentType: 'rnf-fixer' })
  const s = state[n]
  if (!res) {
    s.fixes.push({ final, failed: true })
    return null
  }
  s.fixes.push({ final, ...res })
  s.userSteps.push(...res.userSteps)
  s.openItems.push(...res.openItems)
  return res
}

async function fixRound(prNumbers, phaseName, findingsFor, final) {
  const changed = {}
  await parallel(fixGroups(prNumbers).map(group => async () => {
    for (const n of group) {
      const t = state[n].last
      const lower = t.stackedOn && changed[t.stackedOn] ? { pr: t.stackedOn, branch: state[t.stackedOn].last.branch } : null
      const res = await fixOne(n, findingsFor(n), lower, final, phaseName)
      if (res && res.pushed) changed[n] = res
    }
  }))
  return changed
}

phase('Review')
let review = await runReview(FIRST_MODE, toPrs(A.prs), A.repo ? { repo: A.repo } : {})
record(review, 1)
if (!review || !review.prs.length) {
  return { date: A.date, prs: [], rounds: roundsLog, note: review ? 'no PRs in scope' : 'first review failed to run' }
}

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const toFix = []
  for (const s of Object.values(state)) {
    if (s.status !== 'open' || !s.last) continue
    const t = s.last
    if (isClean(t)) { s.status = 'clean'; continue }
    const bd = blockingDecision(t)
    if (bd) { s.status = 'waiting-on-decision'; s.blockedOn = bd.question; continue }
    if (round === MAX_ROUNDS) { s.status = 'still-blocking-after-cap'; continue }
    if (!t.fixNow.length) { s.status = 'blocking-nothing-to-fix'; continue }
    toFix.push(s.pr)
  }
  if (!toFix.length) break

  phase('Fix')
  log(`Round ${round}: fixing ${toFix.map(n => '#' + n).join(', ')}`)
  const changed = await fixRound(toFix, 'Fix', n => state[n].last.fixNow, false)
  for (const n of toFix) if (!changed[n]) state[n].status = 'fixer-made-no-change'

  const again = Object.keys(changed).map(Number)
  if (!again.length) break

  phase('Review')
  const rereview = Object.fromEntries(again.map(n => [n, {
    preFixHead: changed[n].preFixHead,
    hadSecurityFindings: hadSecurityFindings(state[n].last),
    fixes: changed[n].perFinding.filter(f => f.status === 'fixed').map(f => `${f.title}: ${f.change}`),
  }]))
  review = await runReview(REREVIEW_MODE, again, { repo: repoPath, rereview })
  record(review, round + 1)
  const reviewed = new Set(review ? review.prs.map(t => t.pr) : [])
  for (const n of again) if (!reviewed.has(n)) state[n].status = 'review-failed'
}

for (const s of Object.values(state)) if (s.status === 'open' && s.last && isClean(s.last)) s.status = 'clean'

const polish = Object.values(state).filter(s => s.status === 'clean' && s.last.fixNow.length).map(s => s.pr)
if (polish.length) {
  phase('Polish')
  log(`Final P3 pass on ${polish.map(n => '#' + n).join(', ')} (not re-reviewed)`)
  const changed = await fixRound(polish, 'Polish', n => state[n].last.fixNow, true)
  for (const n of Object.keys(changed)) state[n].polishedHead = changed[n].newHead
}

const merges = {}
if (MERGE) {
  phase('Merge')
  const mergeable = Object.values(state).filter(s =>
    s.status === 'clean' &&
    s.last.verdict !== 'needs-decision' &&
    !s.last.decisions.length &&
    !s.last.reviewerGaps.length &&
    !(s.lastFull && s.lastFull.criteria.some(c => c.result === 'fail')),
  )
  const skipped = Object.values(state).filter(s => !mergeable.includes(s)).map(s => s.pr)
  if (skipped.length) log(`Not merging ${skipped.map(n => '#' + n).join(', ')}: not clean, open decisions, or reviewer gaps`)
  const depth = s => { let d = 0, cur = s.last.stackedOn; while (cur && state[cur] && d < 20) { d++; cur = state[cur].last.stackedOn } return d }
  const order = mergeable.sort((a, b) => depth(a) - depth(b) || a.pr - b.pr)
  for (const s of order) {
    const t = s.last
    if (t.stackedOn && state[t.stackedOn] && !(merges[t.stackedOn] && merges[t.stackedOn].merged)) {
      merges[s.pr] = { merged: false, mergeSha: null, blockedBy: `stacked on #${t.stackedOn}, which did not merge`, command: null, notes: '' }
      continue
    }
    const lastFix = [...s.fixes].reverse().find(f => f.pushed && f.newHead)
    const head = lastFix ? lastFix.newHead : t.head
    merges[s.pr] = await agent(`Squash-merge PR #${s.pr} "${t.title}" in ${repoPath}. The user said "merge at will" and the review loop found it clean. ${GIT_RULE} ${NO_PROD}
Branch ${t.branch}, base ${t.base}, expected head ${head}.${t.stackedOn ? ` It was stacked on #${t.stackedOn}, now merged: retarget it first with \`gh pr edit ${s.pr} --base <the base #${t.stackedOn} merged into>\` and rebase onto that base.` : ''}
Steps:
1. \`/usr/bin/git fetch origin\`. If origin/${t.branch} is not at ${head} (someone else pushed), stop: merged false, blockedBy "head moved".
2. If the branch has fixup! commits (or needs the stacked rebase), in a fresh local branch: \`GIT_SEQUENCE_EDITOR=: /usr/bin/git rebase -i --autosquash origin/${t.stackedOn ? '<new base>' : t.base}\`, check the result has a few clean commits with accurate messages, then \`/usr/bin/git push --force-with-lease=${t.branch}:${head} origin HEAD:${t.branch}\` (the only force-push allowed here). Use the new head sha from now on.
3. Wait for CI on the current head: \`gh pr checks ${s.pr} --watch\` (up to about 20 minutes). Not green: stop, merged false, blockedBy with the failing check.
4. If the PR body names a step that must happen before merge (production migration, token permission, secrets), stop: merged false, blockedBy says which.
5. \`gh pr ready ${s.pr}\` if it is a draft.
6. \`gh pr merge ${s.pr} --squash --match-head-commit <head sha> --subject "<subject>" --body "<body>"\`: a hand-written subject and body (what the PR does and why, not the commit list), the body ending with a plain line naming the model you are running as. No other attribution.
If the harness permission classifier blocks the merge, stop: do not retry or work around it. Return merged false, blockedBy "permission classifier", and command with the exact gh pr merge command for the user.`, { label: `runner merge #${s.pr}`, phase: 'Merge', schema: MERGE_SCHEMA, agentType: 'rnf-runner', model: 'sonnet', effort: 'low' })
    if (merges[s.pr] && merges[s.pr].blockedBy === 'permission classifier') {
      log('Merge blocked by the permission classifier; stopping merges')
      break
    }
  }
}

const prs = Object.values(state).map(s => {
  const t = s.last || {}
  const lastCriteria = t.criteria && t.criteria.length ? t.criteria : null
  return {
    pr: s.pr,
    title: t.title,
    branch: t.branch,
    base: t.base,
    stackedOn: t.stackedOn,
    status: s.status,
    blockedOn: s.blockedOn || null,
    reviewRounds: s.rounds.length,
    lastReviewMode: t.mode,
    verdict: t.verdict,
    summary: t.summary,
    openFixNow: t.fixNow || [],
    outOfScope: t.outOfScope || [],
    criteria: lastCriteria || s.criteria || [],
    criteriaFrom: lastCriteria ? `${t.mode} review, round ${s.rounds.length}` : s.criteria ? 'round 1 (before later fixes)' : 'none',
    checks: t.checks || [],
    verifyCaveats: t.verifyCaveats || 'no verifier ran',
    browserCheck: s.browserCheck || null,
    decisions: s.decisions,
    fixes: s.fixes,
    userSteps: s.userSteps,
    openItems: s.openItems,
    commentDrafts: s.rounds.map(r => ({ round: r.round, mode: r.mode, body: r.commentDraft, fixesVerified: r.fixesVerified })),
    polishedHead: s.polishedHead || null,
    merge: merges[s.pr] || null,
  }
})

return {
  date: A.date,
  project,
  repoPath,
  rounds: roundsLog,
  prs,
  decisionsForUser: prs.flatMap(p => p.decisions.map(d => ({ pr: p.pr, ...d }))),
  clips: prs.flatMap(p => state[p.pr].rounds.length && state[p.pr].last ? (state[p.pr].last.clips || []).map(c => ({ pr: p.pr, branch: p.branch, ...c })) : []),
}
