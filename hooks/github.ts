// Pure helpers: GraphQL queries, parsers from GitHub's shapes into the mod's
// types, and the heuristics that name bots, agents and severities. No `$` here.

import type {
  Activity,
  Check,
  CheckState,
  Commit,
  PrDetail,
  PrSummary,
  Reviewer,
  RuleSummary,
  Snapshot,
  Thread,
} from '../types'

// ---------- queries ----------

const PR_SUMMARY_FIELDS = `
  number title isDraft state mergedAt closedAt mergeable mergeStateStatus reviewDecision headRefName baseRefName
  updatedAt createdAt url additions deletions changedFiles
  author { login __typename }
  autoMergeRequest { enabledAt }
  baseRef { branchProtectionRule {
    requiresApprovingReviews requiredApprovingReviewCount requiresStatusChecks
    requiredStatusCheckContexts requiresConversationResolution requiresCodeOwnerReviews
  } }
  reviewThreads(first: 100) { totalCount nodes { isResolved isOutdated } }
  reviews(last: 60) { nodes { author { login __typename } state submittedAt } }
  reviewRequests(first: 10) { nodes { requestedReviewer {
    __typename ... on User { login } ... on Team { name } ... on Bot { login } } } }
  commits(last: 1) { totalCount nodes { commit {
    abbreviatedOid committedDate message
    author { name user { login } }
    statusCheckRollup { state contexts(first: 80) { totalCount nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl
        checkSuite { app { name } workflowRun { workflow { name } } } }
      ... on StatusContext { context state targetUrl creator { login } }
    } } }
  } } }
`

export const LIST_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    rulesets(first: 20) { nodes { name enforcement target
      conditions { refName { include exclude } }
      rules(first: 30) { nodes { type parameters { __typename
        ... on PullRequestParameters { requiredApprovingReviewCount requireCodeOwnerReview requiredReviewThreadResolution }
        ... on RequiredStatusChecksParameters { requiredStatusChecks { context } }
      } } }
    } }
    pullRequests(states: OPEN, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { ${PR_SUMMARY_FIELDS} }
    }
  }
}`

export const SETTLED_QUERY = `
query($owner: String!, $name: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, CLOSED], first: $count, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number state updatedAt }
    }
  }
}`

export const DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_SUMMARY_FIELDS}
      allCommits: commits(last: 60) { nodes { commit {
        abbreviatedOid committedDate messageHeadline message
        author { name user { login } }
        statusCheckRollup { state }
      } } }
      allThreads: reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line originalLine resolvedBy { login }
        comments(first: 12) { totalCount nodes {
          author { login __typename } body createdAt url commit { abbreviatedOid } } }
      } }
      issueComments: comments(last: 40) { nodes { author { login __typename } body createdAt } }
    }
  }
}`

// gojq filter handed to `gh api graphql --jq`: trims every comment body so a
// PR with a hundred long bot comments stays well under the 4 MiB stdout cap.
export const TRIM_BODIES = 'walk(if type == "object" and has("body") and (.body | type) == "string" then .body |= .[0:600] else . end)'

// ---------- naming bots and agents ----------

const BOT_NAMES: Record<string, string> = {
  coderabbitai: 'CodeRabbit',
  cursor: 'Cursor Bugbot',
  'chatgpt-codex-connector': 'Codex',
  claude: 'Claude Code',
  copilot: 'Copilot',
  'copilot-pull-request-reviewer': 'Copilot',
  'copilot-swe-agent': 'Copilot agent',
  'github-actions': 'GitHub Actions',
  dependabot: 'Dependabot',
  renovate: 'Renovate',
  'gemini-code-assist': 'Gemini',
  'sourcery-ai': 'Sourcery',
  'greptile-apps': 'Greptile',
  'devin-ai-integration': 'Devin',
  'graphite-app': 'Graphite',
  'sentry-io': 'Sentry',
  codecov: 'Codecov',
  'ellipsis-dev': 'Ellipsis',
  'qodo-merge-pro': 'Qodo',
  'sweep-ai': 'Sweep',
}

export function stripBot(login: string): string {
  return login.replace(/\[bot\]$/, '')
}

export function isBotLogin(login: string, typename?: string | null): boolean {
  if (typename === 'Bot') return true
  const bare = stripBot(login).toLowerCase()
  return /\[bot\]$/.test(login) || bare in BOT_NAMES
}

export function displayName(login: string, typename?: string | null): string {
  const bare = stripBot(login)
  const known = BOT_NAMES[bare.toLowerCase()]
  if (known) return known
  return isBotLogin(login, typename) ? `${bare} (bot)` : bare
}

const AGENT_WORDS = /claude|codex|copilot|cursor|gemini|devin|gpt|openai|anthropic|aider|sweep|jules|amp\b/i

export function coAuthorsOf(message: string): string[] {
  const names: string[] = []
  for (const line of message.split('\n')) {
    const m = /^co-authored-by:\s*(.+?)\s*<[^>]*>\s*$/i.exec(line.trim())
    if (m && m[1]) names.push(m[1].trim())
  }
  return names
}

export function sessionUrlOf(message: string): string | null {
  const m = /^claude-session:\s*(\S+)/im.exec(message)
  return m && m[1] ? m[1] : null
}

export function isAgentName(name: string): boolean {
  return AGENT_WORDS.test(name)
}

// ---------- severity and titles from review comments ----------

export function severityOf(body: string): string | null {
  const m =
    /\bP([0-3])\b/.exec(body) ??
    /\b(Critical|Major|Minor|Nitpick|Nit|Trivial)\b/i.exec(body) ??
    /\b(High|Medium|Low)\s+Severity\b/i.exec(body) ??
    /\b(blocking|blocker|must[- ]fix)\b/i.exec(body)
  if (!m) return null
  const raw = m[0]
  if (/^P[0-3]$/.test(raw)) return raw
  if (/severity/i.test(raw)) return raw.replace(/\s+severity/i, '').replace(/^\w/, c => c.toUpperCase())
  return raw.replace(/^\w/, c => c.toUpperCase())
}

export function titleOf(body: string): string {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  for (const line of cleaned.split('\n')) {
    // A badge row (`**🎯 Correctness** | **🟡 Minor** | **⚡ Quick win**`) is
    // metadata, not the finding: skip any line of short `|`-separated cells.
    if (line.includes('|') && line.split('|').every(cell => cell.replace(/\*\*/g, '').trim().length <= 32)) continue
    const t = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
    if (t.length < 4) continue
    if (/^(P[0-3]|Critical|Major|Minor|High|Medium|Low)\b[\s|]*$/i.test(t)) continue
    return t.length > 140 ? `${t.slice(0, 137)}…` : t
  }
  return '(comment)'
}

// ---------- raw shapes ----------

type RawActor = { login?: string | null; __typename?: string | null } | null
type RawCheckNode = {
  __typename: 'CheckRun' | 'StatusContext'
  name?: string
  status?: string
  conclusion?: string | null
  detailsUrl?: string | null
  checkSuite?: { app?: { name?: string } | null; workflowRun?: { workflow?: { name?: string } | null } | null } | null
  context?: string
  state?: string
  targetUrl?: string | null
  creator?: RawActor
}
type RawCommit = {
  abbreviatedOid: string
  committedDate: string
  messageHeadline?: string
  message?: string
  author?: { name?: string | null; user?: { login?: string } | null } | null
  statusCheckRollup?: { state?: string; contexts?: { totalCount: number; nodes: RawCheckNode[] } } | null
}
type RawProtection = {
  requiresApprovingReviews?: boolean
  requiredApprovingReviewCount?: number | null
  requiresStatusChecks?: boolean
  requiredStatusCheckContexts?: string[] | null
  requiresConversationResolution?: boolean
  requiresCodeOwnerReviews?: boolean
} | null
type RawPr = {
  number: number
  title: string
  isDraft: boolean
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt?: string | null
  closedAt?: string | null
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  headRefName: string
  baseRefName: string
  updatedAt: string
  createdAt: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
  author: RawActor
  autoMergeRequest: { enabledAt?: string } | null
  baseRef: { branchProtectionRule: RawProtection } | null
  reviewThreads: { totalCount: number; nodes: { isResolved: boolean; isOutdated: boolean }[] }
  reviews: { nodes: { author: RawActor; state: string; submittedAt: string }[] }
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; name?: string } | null }[] }
  commits: { totalCount: number; nodes: { commit: RawCommit }[] }
  allCommits?: { nodes: { commit: RawCommit }[] }
  allThreads?: {
    nodes: {
      id: string
      isResolved: boolean
      isOutdated: boolean
      path: string
      line: number | null
      originalLine: number | null
      resolvedBy: RawActor
      comments: {
        totalCount: number
        nodes: { author: RawActor; body: string; createdAt: string; url?: string | null; commit?: { abbreviatedOid: string } | null }[]
      }
    }[]
  }
  issueComments?: { nodes: { author: RawActor; body: string; createdAt: string }[] }
}
type RawRuleset = {
  name: string
  enforcement: string
  target: string
  conditions?: { refName?: { include?: string[]; exclude?: string[] } | null } | null
  rules: { nodes: { type: string; parameters: Record<string, unknown> | null }[] }
}
type RawListData = {
  repository: {
    nameWithOwner: string
    rulesets?: { nodes: RawRuleset[] } | null
    pullRequests: { totalCount: number; nodes: RawPr[] }
  } | null
}
type RawDetailData = { repository: { pullRequest: RawPr | null } | null }

// ---------- parsing ----------

export function checkStateOf(node: RawCheckNode): CheckState {
  if (node.__typename === 'StatusContext') {
    const s = (node.state ?? '').toUpperCase()
    if (s === 'SUCCESS') return 'success'
    if (s === 'FAILURE' || s === 'ERROR') return 'failure'
    if (s === 'PENDING' || s === 'EXPECTED') return 'pending'
    return 'unknown'
  }
  const status = (node.status ?? '').toUpperCase()
  if (status !== 'COMPLETED') return status === '' ? 'unknown' : 'pending'
  const c = (node.conclusion ?? '').toUpperCase()
  if (c === 'SUCCESS') return 'success'
  if (c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED' || c === 'ACTION_REQUIRED' || c === 'STARTUP_FAILURE') return 'failure'
  if (c === 'SKIPPED') return 'skipped'
  if (c === 'NEUTRAL' || c === 'STALE') return 'neutral'
  return 'unknown'
}

function rollupState(state: string | undefined): CheckState {
  const s = (state ?? '').toUpperCase()
  if (s === 'SUCCESS') return 'success'
  if (s === 'FAILURE' || s === 'ERROR') return 'failure'
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending'
  return 'unknown'
}

function parseChecks(commit: RawCommit | undefined, required: Set<string>): Check[] {
  const nodes = commit?.statusCheckRollup?.contexts?.nodes ?? []
  // The same check name may run several times (one per workflow trigger);
  // keep the latest non-skipped one per (name, app), as GitHub's own list does.
  const byKey = new Map<string, Check>()
  for (const node of nodes) {
    const name = node.__typename === 'CheckRun' ? node.name ?? '?' : node.context ?? '?'
    const app =
      node.__typename === 'CheckRun'
        ? node.checkSuite?.app?.name ?? null
        : node.creator?.login
          ? displayName(node.creator.login, node.creator.__typename)
          : null
    const workflow = node.__typename === 'CheckRun' ? node.checkSuite?.workflowRun?.workflow?.name ?? null : null
    const check: Check = {
      name,
      app,
      workflow,
      state: checkStateOf(node),
      url: (node.__typename === 'CheckRun' ? node.detailsUrl : node.targetUrl) ?? null,
      isRequired: required.has(name),
    }
    const key = `${name}|${app ?? ''}|${workflow ?? ''}`
    const prior = byKey.get(key)
    if (!prior || prior.state === 'skipped' || (prior.state === 'unknown' && check.state !== 'unknown')) {
      byKey.set(key, check)
    } else if (check.state === 'failure' || (check.state === 'pending' && prior.state !== 'failure')) {
      byKey.set(key, check)
    }
  }
  return [...byKey.values()]
}

function parseReviewers(pr: RawPr): Reviewer[] {
  const latest = new Map<string, Reviewer>()
  for (const r of pr.reviews.nodes) {
    const login = r.author?.login ?? 'unknown'
    const prior = latest.get(login)
    // An APPROVED or CHANGES_REQUESTED outranks a later COMMENTED from the
    // same reviewer, as GitHub's own reviewer list keeps it.
    const keepPrior = prior && prior.state !== 'COMMENTED' && r.state === 'COMMENTED'
    if (keepPrior) continue
    latest.set(login, {
      login,
      name: displayName(login, r.author?.__typename),
      isBot: isBotLogin(login, r.author?.__typename),
      state: r.state,
      at: r.submittedAt,
    })
  }
  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
}

export function parseRules(rulesets: RawRuleset[] | undefined, protection: RawProtection, baseRef: string): RuleSummary | null {
  const out: RuleSummary = {
    names: [],
    requiredApprovals: 0,
    requiredChecks: [],
    requiresThreadResolution: false,
    requiresCodeOwners: false,
    noForcePush: false,
    source: 'none',
  }
  let fromRuleset = false
  for (const rs of rulesets ?? []) {
    if (rs.enforcement !== 'ACTIVE' || rs.target !== 'BRANCH') continue
    const include = rs.conditions?.refName?.include ?? []
    const applies =
      include.length === 0 ||
      include.some(ref => ref === `refs/heads/${baseRef}` || ref === '~DEFAULT_BRANCH' || ref === '~ALL' || ref.endsWith('/*'))
    if (!applies) continue
    fromRuleset = true
    out.names.push(rs.name)
    for (const rule of rs.rules.nodes) {
      const p = rule.parameters ?? {}
      if (rule.type === 'PULL_REQUEST') {
        out.requiredApprovals = Math.max(out.requiredApprovals, Number(p['requiredApprovingReviewCount'] ?? 0))
        out.requiresThreadResolution = out.requiresThreadResolution || p['requiredReviewThreadResolution'] === true
        out.requiresCodeOwners = out.requiresCodeOwners || p['requireCodeOwnerReview'] === true
      } else if (rule.type === 'REQUIRED_STATUS_CHECKS') {
        const checks = p['requiredStatusChecks']
        if (Array.isArray(checks)) {
          for (const c of checks as { context?: string }[]) if (c.context) out.requiredChecks.push(c.context)
        }
      } else if (rule.type === 'NON_FAST_FORWARD') {
        out.noForcePush = true
      }
    }
  }
  let fromProtection = false
  if (protection) {
    fromProtection = true
    if (protection.requiresApprovingReviews) {
      out.requiredApprovals = Math.max(out.requiredApprovals, protection.requiredApprovingReviewCount ?? 1)
    }
    for (const c of protection.requiredStatusCheckContexts ?? []) out.requiredChecks.push(c)
    out.requiresThreadResolution = out.requiresThreadResolution || protection.requiresConversationResolution === true
    out.requiresCodeOwners = out.requiresCodeOwners || protection.requiresCodeOwnerReviews === true
  }
  out.requiredChecks = [...new Set(out.requiredChecks)]
  out.source = fromRuleset && fromProtection ? 'both' : fromRuleset ? 'ruleset' : fromProtection ? 'protection' : 'none'
  return out.source === 'none' ? null : out
}

function agentsOf(pr: RawPr, commits: RawCommit[]): string[] {
  const found = new Set<string>()
  for (const c of commits) {
    for (const name of coAuthorsOf(c.message ?? '')) if (isAgentName(name)) found.add(name)
    const login = c.author?.user?.login
    if (login && isBotLogin(login)) found.add(displayName(login))
  }
  if (pr.author?.login && isBotLogin(pr.author.login, pr.author.__typename)) found.add(displayName(pr.author.login, pr.author.__typename))
  return [...found]
}

export function parseSummary(pr: RawPr, rulesets: RawRuleset[] | undefined): PrSummary {
  const head = pr.commits.nodes[0]?.commit
  const rules = parseRules(rulesets, pr.baseRef?.branchProtectionRule ?? null, pr.baseRefName)
  const required = new Set(rules?.requiredChecks ?? [])
  const threads = pr.reviewThreads.nodes
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? 'unknown',
    authorIsBot: isBotLogin(pr.author?.login ?? '', pr.author?.__typename),
    isDraft: pr.isDraft,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    autoMerge: pr.autoMergeRequest !== null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commitCount: pr.commits.totalCount,
    headSha: head?.abbreviatedOid ?? '',
    headAt: head?.committedDate ?? pr.updatedAt,
    threadsTotal: pr.reviewThreads.totalCount,
    threadsResolved: threads.filter(t => t.isResolved).length,
    threadsOutdated: threads.filter(t => t.isOutdated).length,
    checks: parseChecks(head, required),
    reviewers: parseReviewers(pr),
    requested: pr.reviewRequests.nodes.map(n => n.requestedReviewer?.login ?? n.requestedReviewer?.name ?? '').filter(Boolean),
    agents: agentsOf(pr, head ? [head] : []),
  }
}

export function parseList(json: string, fetchedAt: number): Snapshot {
  const parsed = JSON.parse(json) as { data?: RawListData; errors?: { message: string }[] }
  if (parsed.errors?.length) throw new Error(parsed.errors.map(e => e.message).join('; '))
  const repo = parsed.data?.repository
  if (!repo) throw new Error('repository not found or not readable')
  const rulesets = repo.rulesets?.nodes
  const prs = repo.pullRequests.nodes.map(pr => parseSummary(pr, rulesets))
  const first = repo.pullRequests.nodes[0]
  const rules = first ? parseRules(rulesets, first.baseRef?.branchProtectionRule ?? null, first.baseRefName) : parseRules(rulesets, null, 'main')
  return { repo: repo.nameWithOwner, fetchedAt, totalCount: repo.pullRequests.totalCount, rules, prs }
}

export function parseDetail(json: string, fetchedAt: number, rules: RuleSummary | null): PrDetail {
  const parsed = JSON.parse(json) as { data?: RawDetailData; errors?: { message: string }[] }
  if (parsed.errors?.length) throw new Error(parsed.errors.map(e => e.message).join('; '))
  const pr = parsed.data?.repository?.pullRequest
  if (!pr) throw new Error('pull request not found')
  const summary = parseSummary(pr, undefined)
  if (rules) {
    const required = new Set(rules.requiredChecks)
    summary.checks = summary.checks.map(c => ({ ...c, isRequired: required.has(c.name) }))
  }

  const rawCommits = (pr.allCommits?.nodes ?? []).map(n => n.commit).sort((a, b) => (a.committedDate < b.committedDate ? -1 : 1))
  const commits: Commit[] = rawCommits.map(c => ({
    sha: c.abbreviatedOid,
    headline: c.messageHeadline ?? (c.message ?? '').split('\n')[0] ?? '',
    at: c.committedDate,
    author: c.author?.user?.login ?? c.author?.name ?? 'unknown',
    coAuthors: coAuthorsOf(c.message ?? ''),
    sessionUrl: sessionUrlOf(c.message ?? ''),
    checks: rollupState(c.statusCheckRollup?.state),
    threadsAddressed: 0,
  }))

  const threads: Thread[] = (pr.allThreads?.nodes ?? []).map(t => {
    const comments = t.comments.nodes
    const first = comments[0]
    const openedBy = first?.author?.login ?? 'unknown'
    const replies = comments.slice(1)
    const last = replies[replies.length - 1]
    const openedAt = first?.createdAt ?? pr.createdAt
    const after = commits.filter(c => c.at > openedAt)
    // The first commit pushed after the thread opened is the one most likely
    // to have addressed it; a resolved thread is credited to that commit.
    const addressedBy = t.isResolved || replies.length > 0 ? after[0]?.sha ?? null : null
    // What the bot was reacting to: the commit its comment is anchored on, or
    // the PR's opening when that commit predates the PR.
    const triggerSha = first?.commit?.abbreviatedOid ?? null
    const triggerCommitAt = commits.find(c => c.sha === triggerSha)?.at ?? null
    const triggerAt = triggerCommitAt && triggerCommitAt > pr.createdAt ? triggerCommitAt : pr.createdAt
    const responseMs = Date.parse(openedAt) - Date.parse(triggerAt)
    return {
      body: squash(first?.body ?? ''),
      lastReplyBody: last ? squash(last.body) : null,
      triggerSha,
      triggerAt,
      responseSeconds: Number.isFinite(responseMs) && responseMs >= 0 ? Math.round(responseMs / 1000) : null,
      id: t.id,
      path: t.path,
      line: t.line ?? t.originalLine ?? null,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      resolvedBy: t.resolvedBy?.login ?? null,
      severity: first ? severityOf(first.body) : null,
      title: first ? titleOf(first.body) : '(thread)',
      openedBy,
      openedByIsBot: isBotLogin(openedBy, first?.author?.__typename),
      openedAt,
      replies: Math.max(replies.length, t.comments.totalCount - 1),
      lastReplyBy: last?.author?.login ?? null,
      lastReplyAt: last?.createdAt ?? null,
      commitsSince: after.length,
      addressedBy,
      url: first?.url ?? null,
    }
  })
  for (const t of threads) {
    if (!t.isResolved || !t.addressedBy) continue
    const c = commits.find(x => x.sha === t.addressedBy)
    if (c) c.threadsAddressed += 1
  }
  threads.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1
    return a.openedAt < b.openedAt ? 1 : -1
  })

  const activity: Activity[] = []
  for (const c of commits) {
    const who = c.coAuthors.find(isAgentName) ?? c.author
    activity.push({ at: c.at, who, isBot: isBotLogin(c.author) || c.coAuthors.some(isAgentName), what: `pushed ${c.sha} ${c.headline}` })
  }
  for (const r of pr.reviews.nodes) {
    const login = r.author?.login ?? 'unknown'
    activity.push({ at: r.submittedAt, who: displayName(login, r.author?.__typename), isBot: isBotLogin(login, r.author?.__typename), what: `review: ${r.state.toLowerCase().replace('_', ' ')}` })
  }
  for (const c of pr.issueComments?.nodes ?? []) {
    const login = c.author?.login ?? 'unknown'
    activity.push({ at: c.createdAt, who: displayName(login, c.author?.__typename), isBot: isBotLogin(login, c.author?.__typename), what: `commented: ${titleOf(c.body)}` })
  }
  activity.sort((a, b) => (a.at < b.at ? 1 : -1))
  // A reviewer's batch of replies arrives as one review per reply; fold runs
  // of the same person doing the same thing into one row with a count.
  const folded: Activity[] = []
  for (const ev of activity) {
    const last = folded[folded.length - 1]
    if (last && last.who === ev.who && last.what.replace(/ ×\d+$/, '') === ev.what) {
      const n = Number(/ ×(\d+)$/.exec(last.what)?.[1] ?? 1) + 1
      last.what = `${ev.what} ×${n}`
      continue
    }
    folded.push({ ...ev })
  }

  const agents = new Set(summary.agents)
  for (const c of commits) for (const name of c.coAuthors) if (isAgentName(name)) agents.add(name)
  for (const t of threads) if (t.openedByIsBot) agents.add(displayName(t.openedBy))
  for (const r of summary.reviewers) if (r.isBot) agents.add(r.name)
  for (const c of pr.issueComments?.nodes ?? []) {
    const login = c.author?.login
    if (login && isBotLogin(login, c.author?.__typename)) agents.add(displayName(login, c.author?.__typename))
  }

  return {
    ...summary,
    agents: [...agents],
    fetchedAt,
    state: pr.state ?? 'OPEN',
    mergedAt: pr.mergedAt ?? null,
    closedAt: pr.closedAt ?? null,
    threads,
    commits: commits.slice().reverse(),
    activity: folded.slice(0, 12),
  }
}

export function squash(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
}

export function parseSettledNumbers(json: string): number[] {
  const parsed = JSON.parse(json) as { data?: { repository?: { pullRequests?: { nodes: { number: number }[] } } | null }; errors?: { message: string }[] }
  if (parsed.errors?.length) throw new Error(parsed.errors.map(e => e.message).join('; '))
  return (parsed.data?.repository?.pullRequests?.nodes ?? []).map(n => n.number)
}

// ---------- presentation helpers (pure) ----------

export function ago(iso: string | number, now: number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(t)) return '?'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function glyph(state: CheckState): string {
  switch (state) {
    case 'success':
      return '✓'
    case 'failure':
      return '✗'
    case 'pending':
      return '⟳'
    case 'neutral':
      return '◦'
    case 'skipped':
      return '–'
    default:
      return '?'
  }
}

export function checkTotals(checks: Check[]): Record<CheckState, number> {
  const t: Record<CheckState, number> = { success: 0, failure: 0, pending: 0, neutral: 0, skipped: 0, unknown: 0 }
  for (const c of checks) t[c.state] += 1
  return t
}

export function mergeStateWords(pr: PrSummary): { text: string; tone: 'success' | 'error' | 'warning' | 'subtle' } {
  if (pr.isDraft) return { text: 'draft', tone: 'subtle' }
  switch (pr.mergeState) {
    case 'CLEAN':
      return { text: 'ready to merge', tone: 'success' }
    case 'HAS_HOOKS':
      return { text: 'ready (hooks pending)', tone: 'success' }
    case 'UNSTABLE':
      return { text: 'checks failing or pending', tone: 'warning' }
    case 'BLOCKED':
      return { text: 'blocked by rules', tone: 'error' }
    case 'BEHIND':
      return { text: 'behind base branch', tone: 'warning' }
    case 'DIRTY':
      return { text: 'merge conflicts', tone: 'error' }
    case 'DRAFT':
      return { text: 'draft', tone: 'subtle' }
    default:
      return { text: pr.mergeable === 'CONFLICTING' ? 'merge conflicts' : (pr.mergeState || 'unknown').toLowerCase(), tone: 'subtle' }
  }
}

export function reviewWords(pr: PrSummary, rules: RuleSummary | null): string {
  const approvals = pr.reviewers.filter(r => r.state === 'APPROVED' && !r.isBot).length
  const changes = pr.reviewers.filter(r => r.state === 'CHANGES_REQUESTED').length
  const need = rules?.requiredApprovals ?? 0
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || changes > 0) return `changes requested (${changes})`
  if (pr.reviewDecision === 'APPROVED') return `approved${need ? ` ${approvals}/${need}` : ''}`
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return `review required ${approvals}/${Math.max(need, 1)}`
  if (need > 0) return `approvals ${approvals}/${need}`
  return approvals > 0 ? `approved by ${approvals}` : 'no approval required'
}

export function bar(done: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return ''
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

export function truncate(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

export function statusLineOf(snapshot: Snapshot): string | undefined {
  if (snapshot.prs.length === 0) return undefined
  const parts = snapshot.prs.slice(0, 3).map(pr => {
    const t = checkTotals(pr.checks)
    const checks = t.failure ? `✗${t.failure}` : t.pending ? `⟳${t.pending}` : `✓${t.success}`
    const threads = pr.threadsTotal ? ` ${pr.threadsResolved}/${pr.threadsTotal}` : ''
    return `#${pr.number} ${checks}${threads} ${mergeStateWords(pr).text}`
  })
  const more = snapshot.totalCount > 3 ? ` +${snapshot.totalCount - 3}` : ''
  return `PRs ${snapshot.totalCount} open · ${parts.join(' · ')}${more}`
}

export type Change = { kind: 'merged' | 'closed' | 'check-failed' | 'threads' | 'review' | 'new-pr'; text: string }

export function diffSnapshots(prev: Snapshot | null, next: Snapshot): Change[] {
  if (!prev || prev.repo !== next.repo) return []
  const out: Change[] = []
  const before = new Map(prev.prs.map(p => [p.number, p]))
  for (const pr of next.prs) {
    const old = before.get(pr.number)
    if (!old) {
      out.push({ kind: 'new-pr', text: `PR #${pr.number} opened: ${truncate(pr.title, 60)}` })
      continue
    }
    const oldFail = checkTotals(old.checks).failure
    const newFail = checkTotals(pr.checks).failure
    if (newFail > oldFail) {
      const failed = pr.checks.filter(c => c.state === 'failure').map(c => c.name)
      out.push({ kind: 'check-failed', text: `#${pr.number}: check failed: ${failed.slice(0, 3).join(', ')}` })
    }
    const oldOpen = old.threadsTotal - old.threadsResolved
    const newOpen = pr.threadsTotal - pr.threadsResolved
    if (pr.threadsTotal > old.threadsTotal) {
      out.push({ kind: 'threads', text: `#${pr.number}: ${pr.threadsTotal - old.threadsTotal} new review thread(s), ${newOpen} open` })
    } else if (newOpen < oldOpen && newOpen === 0 && pr.threadsTotal > 0) {
      out.push({ kind: 'threads', text: `#${pr.number}: every review thread resolved` })
    }
    for (const r of pr.reviewers) {
      const was = old.reviewers.find(x => x.login === r.login)
      if ((!was || was.state !== r.state) && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')) {
        out.push({ kind: 'review', text: `#${pr.number}: ${r.name} ${r.state === 'APPROVED' ? 'approved' : 'requested changes'}` })
      }
    }
  }
  return out
}
