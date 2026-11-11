export const meta = {
  name: 'pr-review',
  description: 'Review open PRs on a token budget: the diff is split by files into up to 3 slices, one Sonnet reviewer per slice covers correctness (and security when triggered) and triages its own findings, Codex gives one independent pass over the whole diff, findings are deduped in code',
  whenToUse: 'Called from the review-and-fix workflow and skill (or directly) to review open PRs; returns triage objects, never comments, fixes or merges. Needs the rnf-* agent types in ~/.claude/agents. Args: date (required), prs, repo, project, scope ({"<PR>": {intent, taskText, base, branch, head, criteria}}; top-level intent/taskText/base/branch/head work for a single PR), security (auto|on|off|deep), lite, codex, rereview, settled, asks ({"<PR>": ["<verbatim user message>"]}), heads ({"<PR>": "<sha>"} to review a past head), verify (command or {"<PR>": "<command>"}), jigs (false to skip the verification/jigs.json jigs that run when no verify is given)',
  phases: [
    { title: 'Refs', detail: 'one Haiku runner: gh pr view, git diff --numstat and gh pr checks for every PR; skipped when the coordinator passes refs and files', model: 'haiku' },
    { title: 'Review', detail: 'per PR: one Sonnet reviewer per diff slice (self-triaged), Codex over the whole diff via a Haiku runner, Opus security only with security: "deep", a verifier only with verify or a matching verification/jigs.json jig' },
  ],
}

// pr-review-lite.js is this file with DEFAULT_LITE = true and its own meta: keep the bodies identical (diff them after editing).
const DEFAULT_LITE = false

const A = typeof args === 'string' ? (args.trim().startsWith('{') ? JSON.parse(args) : { prs: args }) : (args || {})
const toPrs = v => v == null ? [] : (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map(p => String(p).replace(/^#/, '')).filter(Boolean)
if (!toPrs(A.prs).length && A.all !== true) throw new Error('args.prs is required (e.g. [952] or "952,953"); pass all: true to review every open PR')
const LITE = A.lite === undefined ? DEFAULT_LITE : A.lite === true
if (!LITE && (!A.date || !/^\d{4}-\d{2}-\d{2}$/.test(A.date))) throw new Error('args.date (YYYY-MM-DD) is required')
const PRS = toPrs(A.prs).map(Number)
const REPO_IS_SLUG = /^[\w.-]+\/[\w.-]+$/.test(A.repo || '')
const REPO_PATH = A.repo && A.repo.startsWith('/') ? A.repo : null
const SECURITY = A.security || (LITE ? 'off' : 'auto')
const REREVIEW = A.rereview || {}
const SETTLED = A.settled || {}
const ASKS = A.asks || {}
const HEADS = A.heads || {}
const VERIFY = A.verify || null
const JIGS = A.jigs !== false
const CODEX = A.codex !== false
const byPr = (map, n) => (map && (map[n] || map[String(n)])) || null

const SCOPE_IN = { ...(A.scope || {}) }
const SCOPE_KEYS = ['intent', 'taskText', 'base', 'branch', 'head', 'criteria', 'title']
if (PRS.length === 1 && SCOPE_KEYS.some(k => A[k] != null)) {
  const top = Object.fromEntries(SCOPE_KEYS.filter(k => A[k] != null).map(k => [k, A[k]]))
  SCOPE_IN[PRS[0]] = { ...top, ...(byPr(SCOPE_IN, PRS[0]) || {}) }
}
const given = n => byPr(SCOPE_IN, n) || {}

const READ_ONLY = 'Read-only: no edits to tracked files, no commits, no pushes, no GitHub comments or reviews, no issue tracker writes. Do not run the test suite, typecheck or build: CI covers them.'
const GIT_RULE = 'If a git command is blocked or rewritten by a hook (some command-rewriting hooks break the worktree isolation check), use /usr/bin/git directly.'
const NO_PROD = 'Never deploy, never touch or query production data. Never set platform env vars locally (VERCEL*, NODE_ENV=production).'
const WRITING = 'Writing rules for every string you return: no preamble, no hard-wrapped prose, keep it short.'
const SLICE_TURNS = 8
const RUNNER_TURNS = 4

const SEVERITY = { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }
const REVIEWER = { type: 'string', enum: ['Claude', 'Codex', 'Security', 'Verify'] }
const CATEGORY = { type: 'string', enum: ['bug', 'security', 'scope', 'simplify', 'unproven', 'convention', 'polish'], description: 'scope: not called for by the task text or the user asks, or a gap between them and the PR body; simplify: complexity the PR does not need; unproven: a PR body claim with no test, output or clip behind it' }

const FINDING = {
  type: 'object',
  properties: {
    severity: SEVERITY,
    title: { type: 'string' },
    file: { type: 'string' },
    line: { type: ['integer', 'null'] },
    scenario: { type: 'string', description: 'concrete failure scenario through the changed code' },
    suggestedFix: { type: 'string' },
    category: CATEGORY,
    reviewer: REVIEWER,
    speculative: { type: 'boolean', description: 'true when not verified against the code' },
    preExisting: { type: 'boolean', description: 'bug exists on the base branch already' },
  },
  required: ['severity', 'title', 'file', 'line', 'scenario', 'suggestedFix', 'category', 'reviewer', 'speculative', 'preExisting'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean', description: 'false if the review could not run at all' },
    method: { type: 'string', description: 'how the review was done, one line' },
    verdict: { type: 'string', enum: ['blocking', 'nothing-blocking', 'did-not-run'] },
    findings: { type: 'array', items: FINDING },
    notes: { type: 'string', description: 'caveats, failures' },
  },
  required: ['ran', 'method', 'verdict', 'findings', 'notes'],
}

// Codex --output-schema needs OpenAI strict mode: every property required, no extra keys.
const CODEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['blocking', 'nothing-blocking'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: SEVERITY,
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          scenario: { type: 'string' },
          suggestedFix: { type: 'string' },
          category: CATEGORY,
          speculative: { type: 'boolean' },
          preExisting: { type: 'boolean' },
        },
        required: ['severity', 'title', 'file', 'line', 'scenario', 'suggestedFix', 'category', 'speculative', 'preExisting'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['verdict', 'findings', 'notes'],
}

const JIG = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    command: { type: 'string' },
    needs: { type: 'array', items: { type: 'string' } },
    teardown: { type: 'array', items: { type: 'string' } },
    covers: { type: 'string' },
    triggers: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'command', 'needs', 'teardown', 'covers', 'triggers'],
}

const REFS_SCHEMA = {
  type: 'object',
  properties: {
    repoPath: { type: 'string', description: 'absolute path printed after "repoPath"' },
    prs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          title: { type: 'string' },
          author: { type: 'string' },
          body: { type: 'string', description: 'verbatim as printed (already capped)' },
          headRefName: { type: 'string' },
          baseRefName: { type: 'string' },
          headRefOid: { type: 'string', pattern: '^[0-9a-f]{40}$' },
          files: {
            type: 'array',
            description: 'one per numstat line; "-" (binary) counts as 0; for a rename use the new path',
            items: { type: 'object', properties: { path: { type: 'string' }, added: { type: 'integer' }, deleted: { type: 'integer' } }, required: ['path', 'added', 'deleted'] },
          },
          checks: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, bucket: { type: 'string' }, state: { type: 'string' } }, required: ['name', 'bucket', 'state'] },
          },
          jigs: {
            type: 'array',
            description: 'the "--- jigs" JSON array copied verbatim (empty when it printed "none" or nothing)',
            items: JIG,
          },
        },
        required: ['n', 'title', 'author', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'files', 'checks', 'jigs'],
      },
    },
    errors: { type: 'array', items: { type: 'string' }, description: 'PRs whose commands failed, with the error' },
  },
  required: ['repoPath', 'prs', 'errors'],
}

const CRITERION_RESULT = {
  type: 'object',
  properties: {
    criterion: { type: 'string' },
    result: { type: 'string', enum: ['pass', 'fail', 'not-exercised'] },
    evidence: { type: 'string', description: 'command output excerpt, or why it was not exercised' },
    clip: { type: ['string', 'null'] },
  },
  required: ['criterion', 'result', 'evidence', 'clip'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    ran: { type: 'boolean', description: 'false if the command could not be started at all' },
    exitCode: { type: ['integer', 'null'] },
    outputSummary: { type: 'string', description: 'pass/fail counts and the failing tests or errors, short' },
    criteria: { type: 'array', items: CRITERION_RESULT },
    findings: { type: 'array', items: FINDING, description: 'one Verify finding per failed criterion or failing test' },
    caveats: { type: 'string', description: 'deps installed, env file copied, partial run, teardown result' },
    clip: { type: ['string', 'null'], description: 'video path the run printed, or null' },
  },
  required: ['command', 'ran', 'exitCode', 'outputSummary', 'criteria', 'findings', 'caveats', 'clip'],
}

const DECISION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    recommended: { type: 'string' },
    why: { type: 'string' },
    blocksFixes: { type: 'boolean', description: 'fixers for this PR must wait for the answer' },
    expensiveLater: { type: 'boolean', description: 'unreleased migration, public API shape: decide before any fixer starts' },
  },
  required: ['question', 'recommended', 'why', 'blocksFixes', 'expensiveLater'],
}

const TRIAGED_FINDING = {
  type: 'object',
  properties: {
    ...FINDING.properties,
    reviewers: { type: 'array', items: REVIEWER },
    spotChecked: { type: 'boolean' },
    spotCheckNote: { type: 'string' },
  },
  required: [...FINDING.required.filter(k => k !== 'reviewer'), 'reviewers', 'spotChecked', 'spotCheckNote'],
}

const SLICE_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean', description: 'false if no review could be done at all' },
    method: { type: 'string', description: 'how the review was done, one line' },
    verdict: { type: 'string', enum: ['blocking', 'ready', 'needs-decision'] },
    summary: { type: 'string', description: 'what blocks, what is fine, what is optional' },
    fixNow: { type: 'array', items: TRIAGED_FINDING },
    decisions: { type: 'array', items: DECISION },
    outOfScope: {
      type: 'array',
      items: {
        type: 'object',
        properties: { finding: TRIAGED_FINDING, route: { type: 'string', description: 'separate PR + ticket, or drop as polish' } },
        required: ['finding', 'route'],
      },
    },
    dropped: { type: 'array', items: { type: 'string' } },
    fixesVerified: { type: 'array', items: { type: 'string' }, description: 're-review only: one line per prior fix, verified or not' },
    commentDraft: { type: 'string', description: 'markdown PR comment body for your slice, no signature' },
    criteria: { type: 'array', items: { type: 'string' }, description: 'only when asked: 2 to 5 checkable acceptance criteria' },
    browserCheck: { type: ['string', 'null'], description: 'only when asked: what a background browser check should exercise, or null' },
  },
  required: ['ran', 'method', 'verdict', 'summary', 'fixNow', 'decisions', 'outOfScope', 'dropped', 'commentDraft', 'criteria', 'browserCheck'],
}

const ADVERSARIAL = `Adversarial checks, each a finding with its category:
- scope: anything in the diff that neither the task text nor the user's asks call for, and any gap between them and the PR body (asked but missing, or done but not asked).
- simplify: single-caller abstractions, unused configurability, duplication of an existing helper (name it), defensive branches for impossible states, a smaller diff that does the same thing.
- unproven: a claim in the PR body (tested, fixes X, no behavior change) with no test, command output or clip behind it.`

const SECURITY_LENS = 'Security lens (on for this PR): trace request input through the changed code for authn/authz gaps (missing guards, wrong role or org scoping, IDOR on IDs from the URL or body), session and login flaws (fail-open defaults, CSRF, forgeable cookies), injection (SQL, command, path), open redirects, secret or env handling, and data exposure in loaders and API responses. Each security finding needs a concrete attack path through the changed code (category "security"); skip theoretical hardening.'

const SORT_RULES = `Sort every verified finding:
- fixNow: blocking, or cheap and clearly right (including cheap, clearly right simplify findings).
- decisions: product or scope calls only the user can make, each with a recommended answer. Every scope finding is a decision "keep, split out, or drop: <what>" with a recommendation: never fixNow, never dropped or accepted silently. A gap between the task text or asks and the PR body is a decision too, unless only the body wording is off (then fixNow). Mark expensiveLater for anything costly to change later (unreleased migration, public API shape) and blocksFixes when a fixNow item depends on the answer.
- outOfScope: pre-existing bugs (route: separate PR and ticket, even when this PR makes them worse) and polish not worth the churn (route: drop or mention). Simplify findings rank above polish.
Refuted or unverifiable findings go to dropped with why. verdict: blocking if any fixNow item is P0 to P2; needs-decision if nothing blocks but decisions are open; ready otherwise.`

// ---------- Refs ----------

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

function refsScript() {
  const loop = PRS.length ? PRS.join(' ') : '$(gh pr list --author @me --json number -q ".[].number")'
  const pins = PRS.filter(n => byPr(HEADS, n) || given(n).head).map(n => `${n}) h=${byPr(HEADS, n) || given(n).head};;`)
  const pres = PRS.filter(n => byPr(REREVIEW, n)).map(n => `${n}) r="${byPr(REREVIEW, n).preFixHead} $h";;`)
  return `${REPO_PATH ? `cd ${sq(REPO_PATH)} && ` : ''}/usr/bin/git fetch -q origin && echo "repoPath $(pwd)" && for n in ${loop}; do
  echo "=== PR $n"
  gh pr view $n --json number,title,body,author,headRefName,baseRefName,headRefOid --jq '{number,title,author:.author.login,headRefName,baseRefName,headRefOid,body:((.body // "")[0:2500])}' || continue
  b=$(gh pr view $n --json baseRefName -q .baseRefName); h=$(gh pr view $n --json headRefOid -q .headRefOid)
  ${pins.length ? `case $n in ${pins.join(' ')} esac` : ''}
  r="origin/$b...$h"; ${pres.length ? `case $n in ${pres.join(' ')} esac` : ''}
  echo "--- numstat $r"; /usr/bin/git diff --numstat $r
  echo "--- checks"; gh pr checks $n --json name,bucket,state 2>&1 | head -c 4000; echo${readJigs() ? `
  echo "--- jigs"; /usr/bin/git show $h:verification/jigs.json 2>/dev/null | jq -c '[.jigs[] | {id, command, needs, teardown: (.teardown // []), covers, triggers}]' 2>/dev/null || echo none` : ''}
done`
}

// Jigs run only for PRs without an explicit verify command, so the refs runner reads jigs.json only when one could run.
const explicitVerify = n => (typeof VERIFY === 'string' ? VERIFY : byPr(VERIFY, n)) || null
function readJigs() {
  if (!JIGS) return false
  return PRS.length ? PRS.some(n => !explicitVerify(n)) : typeof VERIFY !== 'string'
}

function needsRefs() {
  if (!REPO_PATH || !PRS.length) return true
  return PRS.some(n => {
    const g = given(n)
    const jigsKnown = !JIGS || explicitVerify(n) || Array.isArray(g.jigs)
    return !(g.base && g.branch && g.title && /^[0-9a-f]{40}$/.test(byPr(HEADS, n) || g.head || '') && Array.isArray(g.files) && jigsKnown)
  })
}

phase('Refs')
let refs = null
if (needsRefs()) {
  const where = REPO_IS_SLUG
    ? `First check that the current directory is the local checkout of ${A.repo} (\`git remote get-url origin\` names it). If it is not, run nothing and put "pass repo as an absolute path" in errors.`
    : ''
  refs = await agent(`Run one Bash command and return what it prints as structured output. Do not read files, review code or run anything else. Budget: ${RUNNER_TURNS} turns including the final structured output call. ${GIT_RULE}
${where}
~~~~~~
${refsScript()}
~~~~~~
For each "=== PR" block: the JSON line gives n (number), title, author, body (copy verbatim), headRefName, baseRefName, headRefOid; each numstat line "<added> <deleted> <path>" is a file (use 0 for "-"); the checks JSON gives checks (empty when it printed "no checks reported"); the "--- jigs" JSON array gives jigs, every string copied exactly (empty when it printed "none" or there is no "--- jigs" line). A PR whose gh pr view failed goes in errors with the message.`, { label: 'runner refs', phase: 'Refs', schema: REFS_SCHEMA, agentType: 'rnf-runner', model: 'haiku', effort: 'low' })
  if (!refs) {
    log('Refs runner returned nothing')
    return { date: A.date || null, mode: LITE ? 'lite' : 'full', prs: [], failed: PRS, note: 'refs runner failed', unresolved: PRS.map(n => `#${n}: refs runner failed`) }
  }
}

const repoPath = (refs && refs.repoPath) || REPO_PATH
const PROJECT = A.project || repoPath.split('/').filter(Boolean).pop().toLowerCase()
const unresolved = refs ? refs.errors : []
if (unresolved.length) log(`Unresolved: ${unresolved.join('; ')}`)

const GENERATED = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|(^|\/)(drizzle|migrations)\/meta\/|\.snap$|\.min\.(js|css)$|(^|\/)(dist|build|\.next)\//
const TESTS = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?|e2e)\//
const DOCS = /\.(md|mdx|txt)$|(^|\/)docs?\//i
const SEC_TRIGGER = /auth|session|login|middleware|permission|role|acl|guard|(^|\/)api\/|trpc|(^|\/)server\/|migrat|drizzle|schema|\.sql$|upload|redirect|secret|(^|\/)\.env|env\.(m?[jt]s|ts)$|\.github\/workflows|docker|package\.json$|payment|pricing|billing|stripe|webhook|cookie|token|password|csrf|cors/i

const checkResult = b => (b === 'pass' ? 'pass' : b === 'fail' || b === 'cancel' ? 'fail' : 'skipped')

const base = (refs ? refs.prs.map(x => x.n) : PRS).map(n => {
  const x = refs ? refs.prs.find(y => y.n === n) : null
  const g = given(n)
  const branch = g.branch || x.headRefName
  const body = x ? x.body : ''
  const files = (g.files || x.files).map(f => ({ path: f.path, added: f.added || 0, deleted: f.deleted || 0 }))
  const taskText = g.taskText || ''
  return {
    n,
    title: g.title || x.title,
    author: x ? x.author : null,
    body,
    branch,
    base: g.base || x.baseRefName,
    head: byPr(HEADS, n) || g.head || x.headRefOid,
    files,
    checks: (g.checks || (x ? x.checks : [])).map(c => ({ name: c.name, command: `gh pr checks ${n}`, result: c.result || checkResult(c.bucket), detail: c.detail || c.state || '' })),
    intent: g.intent || '',
    taskText,
    taskTextNote: g.taskTextNote || (taskText ? 'passed by the coordinator' : 'no taskText passed by the coordinator'),
    spec: g.spec || 'none found',
    givenCriteria: Array.isArray(g.criteria) ? g.criteria : null,
    userAsks: byPr(ASKS, n) || [],
    rereview: byPr(REREVIEW, n),
    jigs: Array.isArray(g.jigs) ? g.jigs : (x && x.jigs) || [],
  }
})

// ---------- Jigs ----------

// Picomatch-style globs from verification/jigs.json: ** spans directories, * and ? stay inside one, {a,b} alternates; parens are literal.
function globSource(g) {
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '\\') { out += (g[i + 1] || '').replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); i++ }
    else if (c === '*' && g[i + 1] === '*') {
      while (g[i + 1] === '*') i++
      if (g[i + 1] === '/') { out += '(?:.*/)?'; i++ } else out += '.*'
    }
    else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = g.indexOf(']', i + 1)
      if (end < 0) { out += '\\['; continue }
      const body = g.slice(i + 1, end)
      out += `[${body[0] === '!' ? '^' + body.slice(1) : body}]`
      i = end
    }
    else if (c === '{') {
      let depth = 0, j = i, start = i + 1
      const alts = []
      for (; j < g.length; j++) {
        if (g[j] === '{') depth++
        else if (g[j] === '}' && --depth === 0) break
        else if (g[j] === ',' && depth === 1) { alts.push(g.slice(start, j)); start = j + 1 }
      }
      if (j >= g.length) { out += '\\{'; continue }
      alts.push(g.slice(start, j))
      out += `(?:${alts.map(globSource).join('|')})`
      i = j
    }
    else out += c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
  }
  return out
}
const globRegExp = g => new RegExp(`^${globSource(g.replace(/^\.\//, ''))}$`)

function matchJigs(jigs, paths) {
  return jigs.filter(j => {
    const res = (j.triggers || []).map(globRegExp)
    return paths.some(path => res.some(re => re.test(path)))
  })
}

// Without an explicit teardown, each "<x>:up" need implies "<x>:down" (e.g. npm run stack:up / stack:down).
function teardownFor(j) {
  if (Array.isArray(j.teardown) && j.teardown.length) return j.teardown
  return (j.needs || []).filter(c => /:up$/.test(c.trim())).map(c => c.trim().replace(/:up$/, ':down')).reverse()
}

function verifyRuns(p) {
  const cmd = explicitVerify(p.n)
  if (cmd) return [{ jig: null, command: cmd, needs: [], teardown: [], covers: '' }]
  if (!JIGS) return []
  return matchJigs(p.jigs, p.files.map(f => f.path)).map(j => ({ jig: j.id, command: j.command, needs: j.needs || [], teardown: teardownFor(j), covers: j.covers || '' }))
}

const PR_LIST = base.map(p => {
  const reviewFiles = p.files.filter(f => !GENERATED.test(f.path))
  const lines = reviewFiles.reduce((s, f) => s + f.added + f.deleted, 0)
  const trigger = reviewFiles.some(f => SEC_TRIGGER.test(f.path))
  const stackedOn = (base.find(o => o.n !== p.n && o.branch === p.base) || {}).n || null
  const mine = new Set(p.files.map(f => f.path))
  const overlaps = base.filter(o => o.n !== p.n && o.files.some(f => mine.has(f.path))).map(o => o.n)
  const hadSec = !!(p.rereview && p.rereview.hadSecurityFindings)
  const secMode = SECURITY === 'off' ? 'off'
    : SECURITY === 'deep' ? (!p.rereview || hadSec ? 'deep' : 'on')
    : SECURITY === 'on' ? 'on'
    : trigger || hadSec ? 'auto-on' : 'auto-off'
  return {
    ...p,
    reviewFiles,
    generated: p.files.filter(f => GENERATED.test(f.path)).map(f => f.path),
    secMode,
    lines,
    trigger,
    stackedOn,
    overlaps,
    securityLens: secMode !== 'off' && secMode !== 'auto-off',
    deepSecurity: secMode === 'deep',
    securityReason: { off: 'security off', on: 'security forced on (lens in the slice reviewers)', deep: 'security: deep (lens plus an Opus security reviewer)', 'auto-on': hadSec && !trigger ? 'had security findings last round' : 'diff touches a security trigger path', 'auto-off': 'no security trigger in the changed paths' }[secMode],
    changesBehavior: reviewFiles.some(f => !TESTS.test(f.path) && !DOCS.test(f.path)),
    hasTests: reviewFiles.some(f => TESTS.test(f.path)),
    effort: lines > 800 || (trigger && lines > 300) ? 'high' : lines < 80 && !trigger ? 'low' : 'medium',
    verifyRuns: verifyRuns(p),
  }
})

if (!PR_LIST.length) {
  log('No PRs in scope')
  return { date: A.date || null, mode: LITE ? 'lite' : 'full', prs: [], failed: [], note: 'no PRs in scope', unresolved }
}

// ---------- Slicing ----------

function sliceCount(p) {
  if (LITE || p.rereview) return 1
  return p.lines < 400 ? 1 : p.lines < 1000 ? 2 : 3
}

// Sorted by path so a directory (and a file next to its test) stays in one slice.
function slicesFor(p) {
  const files = [...p.reviewFiles].sort((a, b) => a.path.localeCompare(b.path))
  const n = Math.min(sliceCount(p), Math.max(1, files.length))
  if (n === 1) return [files]
  const target = p.lines / n
  const out = [[]]
  let acc = 0
  for (const f of files) {
    const size = f.added + f.deleted
    if (acc >= target && out.length < n) { out.push([]); acc = 0 }
    out[out.length - 1].push(f)
    acc += size
  }
  return out.filter(s => s.length)
}

// ---------- Briefs ----------

function prBlock(p) {
  const task = p.taskText
    ? `Task text (written by whoever filed the task; the source of truth for intent):\n<<<TASK\n${p.taskText}\nTASK>>>`
    : `Task text: none (${p.taskTextNote}).`
  const asks = p.userAsks.length ? `\nThe user also asked, verbatim (a supplement to the task):\n${p.userAsks.map(q => `> ${q}`).join('\n')}` : ''
  const settled = (SETTLED[p.n] || []).length ? `\nDecisions the user already made (settled facts: never raise them again as decisions): ${SETTLED[p.n].join('; ')}` : ''
  const overlaps = p.overlaps.length ? `\nOverlapping PRs: ${p.overlaps.map(o => '#' + o).join(', ')}. Mention merge interactions in the summary; do not review them.` : ''
  const stacked = p.stackedOn ? `\nStacked on #${p.stackedOn}: the diff below is already only this PR's own commits.` : ''
  return `PR #${p.n} "${p.title}" in ${repoPath}. Branch ${p.branch}, base ${p.base}, head ${p.head}.
${p.intent ? `Intent (from the coordinator): ${p.intent}\n` : ''}PR body (implementer-written; the task text and the user's asks outrank it):
<<<BODY
${p.body || '(empty)'}
BODY>>>
${task}${asks}${settled}${overlaps}${stacked}`
}

function lineRule(p) {
  return `Cite line numbers from the real file at the PR head (\`git show ${p.head}:<path> | nl -ba | sed -n '<from>,<to>p'\`) or the + side of the hunk headers, never from a temp copy; inside an embedded script (a workflow run: block, heredoc, inline SQL), cite the enclosing file and line.`
}

function diffRange(p) {
  return p.rereview ? `${p.rereview.preFixHead} ${p.head}` : `origin/${p.base}...${p.head}`
}

function sliceReviewer(p, files, i, total) {
  const r = p.rereview
  const filesArg = total > 1 ? ` -- ${files.map(f => sq(f.path)).join(' ')}` : ''
  const others = total > 1 ? `\nOther slices are reviewed by other agents; open those files only where your slice depends on them.` : ''
  const generated = p.generated.length ? `\nGenerated or lock files (skip): ${p.generated.join(', ')}` : ''
  const wantsCriteria = i === 0 && !p.givenCriteria && !r
  const turns = `Budget: at most ${SLICE_TURNS} turns including the final structured output call. Batch independent reads into one turn (parallel tool calls), stop reading by turn ${SLICE_TURNS - 2}, and return what you have rather than run out.`
  const what = r ? 'the fixes on one PR' : total > 1 ? `slice ${i + 1} of ${total} of one PR` : 'one PR'
  return agent(`You review ${what}: correctness and repo conventions${p.securityLens ? ', plus security' : ''}, then triage your own findings. ${turns}
${READ_ONLY} ${GIT_RULE}
${prBlock(p)}
${r ? `\nRe-review round: review only the fixer diff. The fixes were meant to: ${(r.fixes || []).map((f, k) => `(${k + 1}) ${f}`).join(' ')}\nFill fixesVerified with one line per fix (verified or not, and why) and report anything the fixes introduced. Do not re-review the rest of the PR.\n` : ''}
Your ${r ? 'diff' : 'slice'}${total > 1 ? ` (${files.length} files, about ${files.reduce((s, f) => s + f.added + f.deleted, 0)} changed lines)` : ''}: turn 1 runs \`cd ${sq(repoPath)} && /usr/bin/git fetch -q origin; /usr/bin/git diff ${diffRange(p)}${filesArg}\`. The repo CLAUDE.md is already in your context when the repo is your working directory; otherwise read its CLAUDE.md and AGENTS.md in that same turn.${others}${generated}
Then read surrounding code only where a change could break something (callers, the other side of a contract), with \`git show ${p.head}:<path>\` ranges and grep; the working tree may be on another branch. Confirm each P0 to P2 finding with a targeted read.
Correctness: does it do what the task asks, what breaks at the edges (empty, null, concurrent, wrong role, redirects, errors), does it follow the repo conventions.
${p.securityLens ? SECURITY_LENS + '\n' : ''}${r ? '' : ADVERSARIAL + (i === 0 ? '' : ' Leave PR-wide unproven claims to slice 1.') + '\n'}${lineRule(p)}
Only verified findings, each with file:line, a concrete failure scenario and a suggested fix; label unverified ones speculative and keep them out of fixNow. Mark preExisting when the bug already exists on the base branch. Set reviewers to ["Claude"] (category "security" for security findings), spotChecked true on findings you confirmed with a read, and a short spotCheckNote.
${SORT_RULES}
${i === 0 && !r && p.changesBehavior ? `Missing proof: this PR changes behavior, so unless a test in the diff (test files in the whole PR: ${p.reviewFiles.filter(f => TESTS.test(f.path)).map(f => f.path).join(', ') || 'none'}) exercises at least one criterion, add the decision "Missing proof: <what to exercise>" (recommended: how to prove it; blocksFixes false). Unproven PR body claims feed it.` : 'Do not raise "Missing proof" or "No spec" decisions: the workflow handles them.'}
${wantsCriteria ? `criteria: 2 to 5 checkable acceptance criteria from the task text and PR body (empty when there is no clear target). browserCheck: when a criterion can only be proven in the running app (UI flow, redirect, login), one sentence on what a background browser check should exercise; else null.` : 'criteria: []. browserCheck: null.'}
summary: what blocks, what is fine, what is optional. commentDraft: markdown that holds only the ideas (verified findings as suggestions with file:line, decisions as questions): no recap, no verdict line, no list of what was checked, no signature. ${WRITING}`, {
    label: `slice-sonnet #${p.n}${r ? ' re-review' : total > 1 ? ` ${i + 1}/${total}` : ''}`,
    phase: 'Review',
    schema: SLICE_SCHEMA,
    agentType: 'rnf-reviewer',
    model: 'sonnet',
    effort: p.securityLens && p.trigger ? 'high' : 'medium',
  })
}

function codexBrief(p) {
  const r = p.rereview
  return `Review one pull request locally, read-only. You are in a detached worktree at the PR head (HEAD = ${p.head}).
${prBlock(p)}

Review with \`git diff ${r ? `${r.preFixHead} HEAD` : `origin/${p.base}...HEAD`}\` and the files in this worktree only; do not fetch remote PR metadata. ${READ_ONLY}
${r ? `This is a re-review of fixes since ${r.preFixHead}. They were meant to: ${(r.fixes || []).map((f, k) => `(${k + 1}) ${f}`).join(' ')}. Report anything wrong with them or introduced by them.\n` : ''}${ADVERSARIAL}
Report only verified findings, ranked P0 to P3, each with file:line, a concrete failure scenario and a suggested fix; label speculation with speculative true; mark preExisting when the bug already exists on the base branch; set category on each. Verdict nothing-blocking with an empty list is a valid answer.
Cite lines from the real file in the worktree (\`nl -ba <path>\`) or the + side of the diff hunk headers, never from an extracted or temp copy.`
}

function codexReviewer(p) {
  const R = sq(repoPath)
  return agent(`Run one Bash command (timeout 600000 ms) and return Codex's JSON as structured output. Do not read files or review code yourself. Budget: ${RUNNER_TURNS} turns. If the sandbox blocks codex (network or ~/.codex writes), rerun the same command once with the sandbox disabled.
~~~~~~
S=$(mktemp -d) && /usr/bin/git -C ${R} fetch -q origin && /usr/bin/git -C ${R} worktree add -q --detach "$S/w" ${p.head} && cat > "$S/brief.md" <<'RNF_BRIEF_EOF'
${codexBrief(p)}
RNF_BRIEF_EOF
cat > "$S/schema.json" <<'RNF_SCHEMA_EOF'
${JSON.stringify(CODEX_SCHEMA)}
RNF_SCHEMA_EOF
codex exec -s read-only -C "$S/w" --ephemeral --output-schema "$S/schema.json" -o "$S/out.json" "$(cat "$S/brief.md")" < /dev/null > "$S/log.txt" 2>&1; echo "codex exit $?"; [ -s "$S/out.json" ] || tail -c 2000 "$S/log.txt"; /usr/bin/git -C ${R} worktree remove --force "$S/w"; cat "$S/out.json"
~~~~~~
Return ran true, method "codex exec at ${p.head.slice(0, 8)}", Codex's verdict and findings exactly as printed (same order and wording) with reviewer "Codex", and its notes. If Codex failed or printed no JSON: ran false, verdict did-not-run, findings [], the error in notes.`, { label: `codex #${p.n}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'rnf-runner', model: 'haiku', effort: 'low' })
}

function deepSecurityReviewer(p) {
  return agent(`You are the deep security reviewer for one PR (the user asked for security: "deep"). ${READ_ONLY} ${GIT_RULE} Budget: at most 10 turns including the final structured output call; batch reads.
${prBlock(p)}

\`cd ${sq(repoPath)} && /usr/bin/git fetch -q origin; /usr/bin/git diff ${diffRange(p)}\`, then read files at the head with \`git show ${p.head}:<path>\` and trace request input to where it is used.
Look for: authn/authz gaps (missing guards, wrong role or org scoping, IDOR on IDs from the URL or body), session and login flaws (fail-open defaults, CSRF, forgeable cookies), injection (SQL, command, path), open redirects, secrets or env handling, data exposure in loaders and API responses, production data safety.
High confidence, low noise: each finding needs a concrete attack path through the changed code; skip theoretical hardening, pre-existing issues the diff does not touch or widen, and style.
Report only verified findings, ranked P0 to P3, with file:line, a concrete scenario and a suggested fix. ${lineRule(p)} Set reviewer "Security" and category "security". No findings is verdict nothing-blocking with notes "no security findings". ${WRITING}`, { label: `security-opus #${p.n}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'rnf-reviewer', model: 'opus', effort: 'high' })
}

const runName = run => run.jig ? `jig ${run.jig}` : 'verify'

function verifier(p, criteria, run) {
  const list = criteria.length ? criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(none: report an empty criteria list)'
  const W = `"$S/verify-pr-${p.n}"`
  const setup = run.needs.length
    ? `2. Setup, in order, stopping at the first failure (then skip step 3, report ran false with the failing command's output in caveats, and still do step 4): ${run.needs.map(c => `\`${c}\``).join(', ')}. Use a Bash timeout of 600000 ms for setup.`
    : '2. No setup commands.'
  const teardown = run.teardown.length
    ? `4. Teardown, always (also after a failed setup or command): ${run.teardown.map(c => `\`${c}\``).join(', ')}; a teardown script the repo does not have, or a failed teardown, goes in caveats. Then \`/usr/bin/git -C ${sq(repoPath)} worktree remove --force ${W}\`.`
    : `4. \`/usr/bin/git -C ${sq(repoPath)} worktree remove --force ${W}\`, and stop anything you started.`
  return agent(`You are the verifier for one PR: run ${run.jig ? `the verification jig "${run.jig}" from the repo's verification/jigs.json` : 'one command'} and report. Do not commit, push, comment anywhere, or edit tracked files. ${GIT_RULE} ${NO_PROD}
PR #${p.n} "${p.title}" in ${repoPath}. Branch ${p.branch}, head ${p.head}.${run.covers ? `\nA passing run proves: ${run.covers}` : ''}

1. \`S=$(mktemp -d)\`; \`/usr/bin/git -C ${sq(repoPath)} fetch -q origin\`; \`/usr/bin/git -C ${sq(repoPath)} worktree add --detach ${W} ${p.head}\`; cd into it. If the fresh worktree lacks dependencies, run the repo's documented install first; if something fails only on a missing untracked env file, copy the example env file in. Say so in caveats.
${setup}
3. Run: \`${run.command}\` (exit 0 means pass). Do not change the command.
${teardown}
Criteria:
${list}
Mark a criterion pass or fail only when the command's tests actually cover it (name the test or output line as evidence); every other criterion is not-exercised with "not covered by ${run.jig ? `jig ${run.jig}` : 'the verify command'}". command: \`${run.command}\`. outputSummary: pass/fail counts and the failing tests or errors. Each failing test or failed criterion becomes a finding with reviewer "Verify", category "bug", the test file and line, and the failure output as the scenario${run.jig ? `; a failing jig with no single failing test is one P1 finding titled "Jig ${run.jig} fails"` : ''}. clip: the video path the run printed (do not open it), else null.`, { label: `verify ${run.jig ? run.jig + ' ' : ''}#${p.n}`, phase: 'Review', schema: VERIFY_SCHEMA, agentType: 'rnf-runner', model: 'sonnet', effort: 'low' })
}

// Jigs share one worktree's agent stack and ports, so one PR's runs go one at a time.
async function verifyAll(p, criteria) {
  const out = []
  for (const run of p.verifyRuns) {
    let v = null
    try { v = await verifier(p, criteria, run) } catch (e) { log(`#${p.n}: ${runName(run)} verifier failed: ${e && e.message ? e.message : e}`) }
    out.push(v ? { ...v, run } : null)
  }
  return out
}

// ---------- Merge in code ----------

const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 }
const isBlocking = s => s === 'P0' || s === 'P1' || s === 'P2'
const words = s => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3))
function similarity(a, b) {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / (x.size + y.size - common)
}

// Same defect: same file and either nearly the same line, or nearby lines with overlapping wording.
function sameDefect(a, b) {
  if (a.file !== b.file) return false
  const sim = similarity(`${a.title} ${a.scenario}`, `${b.title} ${b.scenario}`)
  if (a.line == null || b.line == null) return sim >= 0.35
  const d = Math.abs(a.line - b.line)
  return d <= 3 || (d <= 15 && sim >= 0.2)
}

function addReviewer(f, who, note) {
  const reviewers = f.reviewers.includes(who) ? f.reviewers : [...f.reviewers, who]
  return { ...f, reviewers, spotCheckNote: note ? `${f.spotCheckNote}${f.spotCheckNote ? '; ' : ''}${note}` : f.spotCheckNote }
}

// Untriaged findings (Codex, deep security) are sorted by rule, not by an LLM.
function routeRaw(f, who) {
  const { reviewer, ...rest } = f
  const t = { ...rest, reviewers: [who], spotChecked: false, spotCheckNote: `${who} only; not spot-checked: confirm before acting` }
  if (f.preExisting) return { outOfScope: { finding: t, route: 'separate PR and ticket (pre-existing)' } }
  if (f.speculative) return { outOfScope: { finding: t, route: `unverified ${who} speculation: check before acting` } }
  if (f.category === 'scope') return { decision: { question: `Keep, split out, or drop: ${f.title} (${f.file}${f.line ? ':' + f.line : ''})`, recommended: f.suggestedFix, why: `${who}: ${f.scenario}`, blocksFixes: false, expensiveLater: false } }
  if (f.category === 'polish' && f.severity === 'P3') return { outOfScope: { finding: t, route: 'drop or mention (polish)' } }
  return { fixNow: t }
}

const decisionKey = d => {
  const q = d.question.toLowerCase()
  if (/^missing proof/.test(q)) return 'missing proof'
  if (/^no spec/.test(q)) return 'no spec'
  return q.replace(/\s+/g, ' ').slice(0, 80)
}

function combine(p, slices, raws) {
  const fixNow = []
  const outOfScope = []
  const decisions = []
  const dropped = []
  const fixesVerified = []
  const merged = []
  const pushFinding = (list, f) => {
    const all = [...fixNow, ...outOfScope.map(o => o.finding)]
    const dup = all.find(g => sameDefect(g, f))
    if (dup) {
      merged.push(`${f.title} (${f.file}) merged into ${dup.title}`)
      return false
    }
    list.push(f)
    return true
  }
  for (const s of slices) {
    for (const f of [...s.fixNow].sort((a, b) => RANK[a.severity] - RANK[b.severity])) pushFinding(fixNow, f)
    for (const o of s.outOfScope) if (!fixNow.concat(outOfScope.map(x => x.finding)).some(g => sameDefect(g, o.finding))) outOfScope.push(o)
    for (const d of s.decisions) if (!decisions.some(x => decisionKey(x) === decisionKey(d))) decisions.push(d)
    dropped.push(...s.dropped)
    fixesVerified.push(...(s.fixesVerified || []))
  }
  const extra = []
  for (const { who, report } of raws) {
    for (const f of report.findings) {
      const fixIdx = fixNow.findIndex(g => sameDefect(g, f))
      if (fixIdx >= 0) { fixNow[fixIdx] = addReviewer(fixNow[fixIdx], who, f.severity !== fixNow[fixIdx].severity ? `${who} rated it ${f.severity}` : ''); continue }
      const oosIdx = outOfScope.findIndex(o => sameDefect(o.finding, f))
      if (oosIdx >= 0) { outOfScope[oosIdx] = { ...outOfScope[oosIdx], finding: addReviewer(outOfScope[oosIdx].finding, who, '') }; continue }
      const routed = routeRaw(f, who)
      if (routed.fixNow) { fixNow.push(routed.fixNow); extra.push({ who, f: routed.fixNow }) }
      if (routed.outOfScope) outOfScope.push(routed.outOfScope)
      if (routed.decision && !decisions.some(x => decisionKey(x) === decisionKey(routed.decision))) { decisions.push(routed.decision); extra.push({ who, d: routed.decision }) }
    }
  }
  fixNow.sort((a, b) => RANK[a.severity] - RANK[b.severity])
  return { fixNow, outOfScope, decisions, dropped, fixesVerified, merged, extra }
}

function commentFor(slices, extra) {
  const parts = slices.map(s => (s.commentDraft || '').trim()).filter(Boolean)
  const lines = extra.map(e => e.f
    ? `- \`${e.f.file}${e.f.line ? ':' + e.f.line : ''}\` (${e.who}) ${e.f.title}. ${e.f.suggestedFix}`
    : `- (${e.who}) ${e.d.question}`)
  if (lines.length) parts.push(`**Also raised by ${[...new Set(extra.map(e => e.who))].join(' and ')}:**\n${lines.join('\n')}`)
  return parts.join('\n\n')
}

const verifyPassed = v => v.ran && v.exitCode === 0

function withVerify(result, vs) {
  return vs.reduce((acc, v) => {
    const name = v.run.jig ? `Jig ${v.run.jig}` : 'Verify'
    const vFindings = v.findings.map(({ reviewer, ...f }) => ({ ...f, reviewers: ['Verify'], spotChecked: true, spotCheckNote: `from ${v.run.jig ? `jig ${v.run.jig}` : 'verify command'} output` }))
    const lines = v.criteria.map(c => `- ${c.result}: ${c.criterion} (${c.evidence})`).join('\n')
    return {
      ...acc,
      fixNow: [...acc.fixNow, ...vFindings],
      verifyFailed: acc.verifyFailed || v.criteria.some(c => c.result === 'fail') || (v.ran && v.exitCode !== 0),
      summary: `${acc.summary} ${name} \`${v.command}\`: ${v.outputSummary}`,
      commentDraft: `${acc.commentDraft}\n\n**${name}** \`${v.command}\`: ${v.ran ? (verifyPassed(v) ? 'passed' : `failed (exit ${v.exitCode})`) : 'could not run'}. ${v.outputSummary}${lines ? `\n\n${lines}` : ''}`.trim(),
    }
  }, result)
}

// Same criteria list goes to every verifier: a fail anywhere wins, then a pass.
function mergedCriteria(criteriaList, vs, pending) {
  return criteriaList.map((cr, i) => {
    const hits = vs.map(v => v.criteria.find(c => c.criterion === cr) || v.criteria[i]).filter(Boolean)
    return hits.find(c => c.result === 'fail') || hits.find(c => c.result === 'pass') || hits[0] || { criterion: cr, result: 'not-exercised', evidence: pending, clip: null }
  })
}

function withCi(p, result) {
  const failing = p.checks.filter(c => c.result === 'fail')
  if (!failing.length) return result
  const ci = failing.map(c => ({ severity: 'P1', title: `CI check "${c.name}" fails`, file: '(CI)', line: null, scenario: `gh pr checks ${p.n} reports ${c.name} as failing (${c.detail}).`, suggestedFix: `Read the failing log (\`gh pr checks ${p.n}\`, \`gh run view --log-failed\`) and fix the cause.`, category: 'bug', reviewers: ['Verify'], speculative: false, preExisting: false, spotChecked: true, spotCheckNote: 'from gh pr checks' }))
  return { ...result, fixNow: [...ci, ...result.fixNow] }
}

function requireProof(p, result, vs) {
  const proven = vs.some(v => v.criteria.some(c => c.result === 'pass') || (v.run.jig && verifyPassed(v))) || p.hasTests
  const settled = (SETTLED[p.n] || []).some(d => /\bproof\b/i.test(d))
  if (!p.changesBehavior || proven || settled || p.rereview || result.decisions.some(d => /^missing proof/i.test(d.question))) return result
  return {
    ...result,
    decisions: [...result.decisions, {
      question: `Missing proof: nothing exercised ${result.criteriaList.length ? 'the criteria' : 'this behavior change'}. Accept it unproven, or prove it first?`,
      recommended: p.browserCheck ? `Run the background browser check: ${p.browserCheck}` : 'Exercise it with a test or a browser check before merging',
      why: 'the PR changes behavior and no test in the diff, verify output or clip backs it',
      blocksFixes: false,
      expensiveLater: false,
    }],
  }
}

function requireSpec(p, result) {
  if (p.taskText || p.userAsks.length || p.rereview || (SETTLED[p.n] || []).some(d => /\bspec\b/i.test(d))) return result
  if (result.decisions.some(d => /^no spec/i.test(d.question))) return result
  const decision = { question: 'No spec to review against: no task text was passed. What should this PR be checked against?', recommended: 'Pass the task or issue text (scope.taskText), or asks with what you asked for', why: p.taskTextNote, blocksFixes: false, expensiveLater: false }
  return { ...result, decisions: [...result.decisions, decision] }
}

function verdictOf(result) {
  if (result.fixNow.some(f => isBlocking(f.severity)) || result.verifyFailed) return 'blocking'
  return result.decisions.length ? 'needs-decision' : 'ready'
}

// ---------- Run ----------

async function review(p) {
  const slices = slicesFor(p)
  const r = p.rereview
  const runs = p.verifyRuns
  log(`#${p.n}: ${r ? 're-review of the fixer diff' : `${p.lines} changed lines in ${slices.length} slice${slices.length > 1 ? 's' : ''}`}; ${p.securityReason}${CODEX && (!r || A.codex === true) ? '; Codex' : ''}${runs.length ? `; ${runs.map(x => x.jig ? `jig ${x.jig}` : `verify \`${x.command}\``).join(', ')}` : ''}`)
  if (p.generated.length) log(`#${p.n}: not reviewed (generated or lock files): ${p.generated.join(', ')}`)
  const useCodex = CODEX && (!r || A.codex === true)
  const tasks = [
    ...slices.map((files, i) => () => sliceReviewer(p, files, i, slices.length)),
    () => (useCodex ? codexReviewer(p) : Promise.resolve(null)),
    () => (p.deepSecurity ? deepSecurityReviewer(p) : Promise.resolve(null)),
    () => (runs.length ? verifyAll(p, p.givenCriteria || []) : Promise.resolve([])),
  ]
  const out = await parallel(tasks)
  const sliceResults = out.slice(0, slices.length)
  const [codex, security, verifyOut] = out.slice(slices.length)
  return { p, slices, sliceResults, codex, security, verifyOut: verifyOut || runs.map(() => null), useCodex }
}

function finish(rv) {
  const { p, slices, sliceResults, codex, security, verifyOut, useCodex } = rv
  const gaps = []
  sliceResults.forEach((s, i) => {
    const label = slices.length > 1 ? `slice ${i + 1} reviewer (${slices[i].map(f => f.path).join(', ')})` : 'Claude reviewer'
    if (!s) gaps.push(`${label} returned nothing`)
    else if (!s.ran) gaps.push(`${label} could not review: ${s.method}`)
  })
  if (useCodex && !codex) gaps.push('Codex runner returned nothing')
  else if (useCodex && !codex.ran) gaps.push(`Codex did not run: ${codex.notes}`)
  if (p.deepSecurity && !security) gaps.push('security reviewer returned nothing')
  p.verifyRuns.forEach((run, i) => {
    const v = verifyOut[i]
    if (!v) gaps.push(`${runName(run)} verifier returned nothing`)
    else if (!v.ran) gaps.push(`${runName(run)} could not run: ${v.caveats}`)
  })
  const vs = verifyOut.filter(Boolean)

  const ok = sliceResults.filter(s => s && s.ran)
  if (!ok.length && !(codex && codex.ran)) return null

  const raws = [
    ...(codex && codex.ran ? [{ who: 'Codex', report: codex }] : []),
    ...(security && security.ran ? [{ who: 'Security', report: security }] : []),
  ]
  const c = combine(p, ok, raws)
  if (c.merged.length) log(`#${p.n}: deduped ${c.merged.length} finding(s) across reviewers`)
  const criteriaList = p.givenCriteria || ((ok[0] && ok[0].criteria) || [])
  p.browserCheck = (ok[0] && ok[0].browserCheck) || null
  const summaryParts = ok.length > 1
    ? ok.map((s, i) => `Slice ${i + 1}: ${s.summary}`)
    : ok.map(s => s.summary)
  if (useCodex && codex && codex.ran) summaryParts.push(`Codex: ${codex.verdict}, ${codex.findings.length} finding(s)${c.extra.some(e => e.who === 'Codex') ? `, ${c.extra.filter(e => e.who === 'Codex').length} not spot-checked` : ''}.`)
  if (security && security.ran) summaryParts.push(`Security (deep): ${security.verdict}, ${security.findings.length} finding(s).`)
  if (gaps.length) summaryParts.push(`Gaps: ${gaps.join('; ')}.`)

  let result = {
    summary: summaryParts.join(' '),
    fixNow: c.fixNow,
    decisions: c.decisions,
    outOfScope: c.outOfScope,
    dropped: c.dropped,
    fixesVerified: c.fixesVerified,
    commentDraft: commentFor(ok, c.extra),
    criteriaList,
  }
  result = requireSpec(p, requireProof(p, withCi(p, withVerify(result, vs)), vs))
  const verdict = verdictOf(result)
  const pending = p.browserCheck ? `browser proof pending: run it as a separate background check (${p.browserCheck})` : 'no in-review verifier'

  const criteria = mergedCriteria(criteriaList, vs, pending)
  const checks = [...p.checks, ...p.verifyRuns.map((run, i) => {
    const v = verifyOut[i]
    return { name: run.jig ? `jig ${run.jig}` : 'verify', command: run.command, result: v ? (v.ran ? (verifyPassed(v) ? 'pass' : 'fail') : 'skipped') : 'skipped', detail: v ? v.outputSummary : 'verifier returned nothing' }
  })]
  const clips = vs.map(v => v.clip).filter(Boolean)
  const verifyNote = vs.length ? vs.map(v => `${runName(v.run)} ran${v.caveats ? `: ${v.caveats}` : ''}`).join('; ') : pending

  return {
    pr: p.n,
    mode: LITE ? 'lite' : 'full',
    title: p.title,
    branch: p.branch,
    base: p.base,
    head: p.head,
    stackedOn: p.stackedOn,
    overlaps: p.overlaps,
    spec: p.spec,
    userAsks: p.userAsks,
    effort: p.effort,
    slices: slices.length,
    security: { ran: p.securityLens, deep: p.deepSecurity && !!security, reason: p.securityReason },
    reviewerGaps: gaps,
    criteria,
    checks,
    clips,
    verifyCaveats: `CI read from gh pr checks${p.checks.length ? '' : ' (none reported or not read)'}; ${verifyNote}`,
    browserCheck: p.browserCheck,
    verdict,
    summary: result.summary,
    fixNow: result.fixNow,
    decisions: result.decisions,
    outOfScope: result.outOfScope,
    dropped: result.dropped,
    fixesVerified: result.fixesVerified,
    commentDraft: result.commentDraft,
  }
}

phase('Review')
const results = await pipeline(PR_LIST, review, finish)

const prs = results.filter(Boolean)
const failed = PR_LIST.filter((p, i) => !results[i]).map(p => p.n)
if (failed.length) log(`No review result for ${failed.map(n => '#' + n).join(', ')}`)

return {
  date: A.date || null,
  mode: LITE ? 'lite' : 'full',
  project: PROJECT,
  repoPath,
  prs,
  failed,
  unresolved,
  clips: prs.flatMap(t => t.clips),
}
