export type CheckState = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'unknown'

export type Check = {
  name: string
  app: string | null
  workflow: string | null
  state: CheckState
  url: string | null
  isRequired: boolean
}

export type Reviewer = {
  login: string
  name: string
  isBot: boolean
  state: string
  at: string
}

export type RuleSummary = {
  names: string[]
  requiredApprovals: number
  requiredChecks: string[]
  requiresThreadResolution: boolean
  requiresCodeOwners: boolean
  noForcePush: boolean
  source: 'ruleset' | 'protection' | 'both' | 'none'
}

export type PrSummary = {
  number: number
  title: string
  url: string
  author: string
  authorIsBot: boolean
  isDraft: boolean
  headRef: string
  baseRef: string
  createdAt: string
  updatedAt: string
  mergeable: string
  mergeState: string
  reviewDecision: string | null
  autoMerge: boolean
  additions: number
  deletions: number
  changedFiles: number
  commitCount: number
  headSha: string
  headAt: string
  threadsTotal: number
  threadsResolved: number
  threadsOutdated: number
  checks: Check[]
  reviewers: Reviewer[]
  requested: string[]
  agents: string[]
}

export type Snapshot = {
  repo: string
  fetchedAt: number
  totalCount: number
  rules: RuleSummary | null
  prs: PrSummary[]
}

export type ThreadComment = {
  author: string
  isBot: boolean
  at: string
  body: string
  commit: string | null
}

export type Thread = {
  id: string
  kind: 'thread' | 'comment'
  hasFindings: boolean
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  resolvedBy: string | null
  severity: string | null
  title: string
  openedBy: string
  openedByIsBot: boolean
  openedAt: string
  replies: number
  lastReplyBy: string | null
  lastReplyAt: string | null
  commitsSince: number
  addressedBy: string | null
  url: string | null
  body: string
  lastReplyBody: string | null
  triggerSha: string | null
  triggerAt: string
  responseSeconds: number | null
  originalLine: number | null
}

// A unified-diff hunk of one file in one commit: old-side start and length,
// new-side start and length.
export type Hunk = [oldStart: number, oldLines: number, newStart: number, newLines: number]

export type CommitPatch = { files: string[]; hunks: Record<string, Hunk[]> }

export type Commit = {
  sha: string
  headline: string
  at: string
  author: string
  coAuthors: string[]
  sessionUrl: string | null
  checks: CheckState
  threadsAddressed: number
}

export type Activity = {
  at: string
  who: string
  isBot: boolean
  what: string
}

export type PrDetail = PrSummary & {
  fetchedAt: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt: string | null
  closedAt: string | null
  threads: Thread[]
  commits: Commit[]
  activity: Activity[]
}

export type Outcome = 'used' | 'dismissed' | 'resolved' | 'open' | 'comment'

export type BotStats = {
  bot: string
  findings: number
  threads: number
  comments: number
  commentsWithFindings: number
  prs: number
  used: number
  codeVerified: number
  dismissed: number
  resolved: number
  open: number
  usedRate: number | null
  medianResponseSeconds: number | null
  duplicated: number
  unique: number
  firsts: number
  repeats: number
  severities: Record<string, number>
}

export type PairStats = { botA: string; botB: string; same: number; judged: number; unjudged: number; colocated: number; similar: number }

export type StatsReport = {
  repo: string | null
  sinceDays: number | null
  generatedAt: number
  totalThreads: number
  totalPrs: number
  bots: BotStats[]
  pairs: PairStats[]
  unjudgedPairs: number
}

export type BackfillProgress = { running: boolean; done: number; total: number; message: string }


export type SettledPr = {
  number: number
  title: string
  url: string
  state: 'MERGED' | 'CLOSED'
  at: string | null
  by: string | null
  headRef: string
  branchDeleted: boolean | null
  seenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-pulse': {
      repo: string | null
      snapshot: Snapshot | null
      detail: PrDetail | null
      selected: number | null
      error: string | null
      isLoading: boolean
      settled: SettledPr[]
      mode: 'prs' | 'stats'
      stats: StatsReport | null
      backfill: BackfillProgress | null
      dbPath: string | null
    }
  }
}
