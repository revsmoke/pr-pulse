// Pure SQL builders and the analysis rules for the review-bot ledger kept in
// SQLite (driven through the sqlite3 CLI from register.tsx). No `$` here.

import type { BotStats, Outcome, PairStats, PrDetail, StatsReport, Thread } from '../types'
import { displayName } from './github.ts'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS prs (
  repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT, author TEXT, state TEXT,
  created_at TEXT, merged_at TEXT, closed_at TEXT, head_ref TEXT, base_ref TEXT,
  additions INTEGER, deletions INTEGER, changed_files INTEGER, commit_count INTEGER,
  agents TEXT, recorded_at TEXT, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS commits (
  repo TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, committed_at TEXT, author TEXT,
  co_authors TEXT, headline TEXT, files TEXT, PRIMARY KEY (repo, number, sha));
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, bot TEXT, opened_by TEXT,
  opened_by_is_bot INTEGER, opened_at TEXT, path TEXT, line INTEGER, severity TEXT, title TEXT, body TEXT,
  trigger_sha TEXT, trigger_at TEXT, response_seconds INTEGER, is_resolved INTEGER, resolved_by TEXT,
  is_outdated INTEGER, replies INTEGER, last_reply_by TEXT, last_reply_at TEXT, last_reply_body TEXT,
  addressed_by TEXT, addressed_touched_file INTEGER, outcome TEXT, url TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS threads_repo_bot ON threads (repo, bot, opened_at);
CREATE TABLE IF NOT EXISTS thread_pairs (
  a TEXT NOT NULL, b TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, bot_a TEXT, bot_b TEXT,
  same INTEGER, reason TEXT, judged_at TEXT, PRIMARY KEY (a, b));
`

export function q(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`
}

const POSITIVE = /\b(fixed|done|addressed|applied|resolved|good catch|updated|implemented|added|removed|changed|thanks?,? (fixed|done))\b/i
const NEGATIVE = /\b(won'?t fix|wontfix|not applicable|false positive|intentional|by design|as designed|not an issue|no change needed|out of scope|declin\w*|ignor\w*|skip\w*|n\/a|incorrect|wrong|disagree|not needed|already handled|working as intended)\b/i

// How a thread ended: `used` when the code moved after it (the addressing
// commit touched its file, the diff under it changed, or the reply says so),
// `dismissed` when the reply says no and nothing moved, `resolved` when it
// closed with no evidence either way, `open` while it stands.
export function outcomeOf(thread: Thread, touchedFile: boolean | null): Outcome {
  if (!thread.isResolved) return 'open'
  const reply = thread.lastReplyBody ?? ''
  if (NEGATIVE.test(reply) && touchedFile !== true) return 'dismissed'
  if (touchedFile === true || thread.isOutdated || POSITIVE.test(reply)) return 'used'
  return 'resolved'
}

export function botOf(thread: Thread): string | null {
  return thread.openedByIsBot ? displayName(thread.openedBy) : null
}

export function recordSql(repo: string, pr: PrDetail, filesBySha: ReadonlyMap<string, string[] | null>, nowIso: string): string {
  const lines: string[] = ['BEGIN;']
  lines.push(
    `INSERT INTO prs (repo, number, title, author, state, created_at, merged_at, closed_at, head_ref, base_ref, additions, deletions, changed_files, commit_count, agents, recorded_at) VALUES (` +
      [repo, pr.number, pr.title, pr.author, pr.state, pr.createdAt, pr.mergedAt, pr.closedAt, pr.headRef, pr.baseRef, pr.additions, pr.deletions, pr.changedFiles, pr.commitCount, JSON.stringify(pr.agents), nowIso].map(q).join(', ') +
      `) ON CONFLICT (repo, number) DO UPDATE SET title = excluded.title, state = excluded.state, merged_at = excluded.merged_at, closed_at = excluded.closed_at, additions = excluded.additions, deletions = excluded.deletions, changed_files = excluded.changed_files, commit_count = excluded.commit_count, agents = excluded.agents, recorded_at = excluded.recorded_at;`,
  )
  for (const c of pr.commits) {
    const files = filesBySha.get(c.sha)
    lines.push(
      `INSERT INTO commits (repo, number, sha, committed_at, author, co_authors, headline, files) VALUES (` +
        [repo, pr.number, c.sha, c.at, c.author, JSON.stringify(c.coAuthors), c.headline, files === undefined || files === null ? null : JSON.stringify(files)].map(q).join(', ') +
        `) ON CONFLICT (repo, number, sha) DO UPDATE SET files = COALESCE(excluded.files, commits.files);`,
    )
  }
  for (const t of pr.threads) {
    const files = t.addressedBy ? filesBySha.get(t.addressedBy) : undefined
    const touched = files === undefined || files === null ? null : files.includes(t.path)
    const outcome = outcomeOf(t, touched)
    lines.push(
      `INSERT INTO threads (id, repo, number, bot, opened_by, opened_by_is_bot, opened_at, path, line, severity, title, body, trigger_sha, trigger_at, response_seconds, is_resolved, resolved_by, is_outdated, replies, last_reply_by, last_reply_at, last_reply_body, addressed_by, addressed_touched_file, outcome, url, updated_at) VALUES (` +
        [t.id, repo, pr.number, botOf(t), t.openedBy, t.openedByIsBot, t.openedAt, t.path, t.line, t.severity, t.title, t.body, t.triggerSha, t.triggerAt, t.responseSeconds, t.isResolved, t.resolvedBy, t.isOutdated, t.replies, t.lastReplyBy, t.lastReplyAt, t.lastReplyBody, t.addressedBy, touched, outcome, t.url, nowIso].map(q).join(', ') +
        `) ON CONFLICT (id) DO UPDATE SET is_resolved = excluded.is_resolved, resolved_by = excluded.resolved_by, is_outdated = excluded.is_outdated, replies = excluded.replies, last_reply_by = excluded.last_reply_by, last_reply_at = excluded.last_reply_at, last_reply_body = excluded.last_reply_body, addressed_by = excluded.addressed_by, addressed_touched_file = COALESCE(excluded.addressed_touched_file, threads.addressed_touched_file), outcome = excluded.outcome, updated_at = excluded.updated_at;`,
    )
  }
  for (const [a, b] of candidatePairs(pr.threads)) {
    lines.push(
      `INSERT OR IGNORE INTO thread_pairs (a, b, repo, number, bot_a, bot_b, same, reason, judged_at) VALUES (` +
        [a.id, b.id, repo, pr.number, botOf(a), botOf(b), null, null, null].map(q).join(', ') +
        `);`,
    )
  }
  lines.push('COMMIT;')
  return lines.join('\n')
}

// Two bots' threads on the same file within a few lines of each other may be
// the same finding; the model settles it later. Ordered pairs by id so each
// pair is stored once.
export function candidatePairs(threads: Thread[], lineWindow = 8): [Thread, Thread][] {
  const bots = threads.filter(t => t.openedByIsBot)
  const out: [Thread, Thread][] = []
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i]!
      const b = bots[j]!
      if (botOf(a) === botOf(b) || a.path !== b.path) continue
      if (a.line !== null && b.line !== null && Math.abs(a.line - b.line) > lineWindow) continue
      out.push(a.id < b.id ? [a, b] : [b, a])
    }
  }
  return out
}

export function judgePrompt(a: { path: string; line: number | null; body: string }, b: { path: string; line: number | null; body: string }): string {
  return [
    'Two automated code-review comments were left on the same pull request, on the same file.',
    'Do they report the same underlying issue (same defect or the same requested change), even if worded differently?',
    'Answer on the first line with exactly YES or NO, then one short sentence of reason.',
    '',
    `Comment A (${a.path}${a.line ? `:${a.line}` : ''}):`,
    a.body,
    '',
    `Comment B (${b.path}${b.line ? `:${b.line}` : ''}):`,
    b.body,
  ].join('\n')
}

export function parseJudgement(text: string): { same: boolean; reason: string } | null {
  const m = /^\s*\**\s*(YES|NO)\b\**[.:,\s-]*([\s\S]*)$/i.exec(text.trim())
  if (!m || !m[1]) return null
  return { same: m[1].toUpperCase() === 'YES', reason: (m[2] ?? '').split('\n')[0]?.trim().slice(0, 240) ?? '' }
}

export function pairUpdateSql(a: string, b: string, same: boolean, reason: string, nowIso: string): string {
  return `UPDATE thread_pairs SET same = ${same ? 1 : 0}, reason = ${q(reason)}, judged_at = ${q(nowIso)} WHERE a = ${q(a)} AND b = ${q(b)};`
}

export function unjudgedPairsSql(repo: string | null, limit: number): string {
  const scope = repo ? `AND p.repo = ${q(repo)}` : ''
  return `SELECT p.a, p.b, ta.path AS path_a, ta.line AS line_a, ta.body AS body_a, tb.path AS path_b, tb.line AS line_b, tb.body AS body_b
FROM thread_pairs p JOIN threads ta ON ta.id = p.a JOIN threads tb ON tb.id = p.b
WHERE p.same IS NULL ${scope} ORDER BY p.number DESC LIMIT ${Math.max(1, Math.floor(limit))};`
}

export type UnjudgedRow = { a: string; b: string; path_a: string; line_a: number | null; body_a: string; path_b: string; line_b: number | null; body_b: string }

export function commitFilesSql(repo: string, number: number): string {
  return `SELECT sha, files FROM commits WHERE repo = ${q(repo)} AND number = ${q(number)} AND files IS NOT NULL;`
}

// ---------- stats ----------

export type StatRow = {
  id: string
  number: number
  bot: string
  severity: string | null
  response_seconds: number | null
  outcome: Outcome
  dup: number
}

export type PairRow = { bot_a: string; bot_b: string; same: number | null; n: number }

export function statsSql(repo: string | null, sinceDays: number | null, nowIso: string): { threads: string; pairs: string } {
  const where: string[] = ['opened_by_is_bot = 1', 'bot IS NOT NULL']
  if (repo) where.push(`repo = ${q(repo)}`)
  if (sinceDays !== null) {
    const since = new Date(Date.parse(nowIso) - sinceDays * 86_400_000).toISOString()
    where.push(`opened_at >= ${q(since)}`)
  }
  const threads = `SELECT t.id, t.number, t.bot, t.severity, t.response_seconds, t.outcome,
  (SELECT COUNT(*) FROM thread_pairs p WHERE p.same = 1 AND (p.a = t.id OR p.b = t.id)) AS dup
FROM threads t WHERE ${where.join(' AND ')};`
  const pwhere: string[] = []
  if (repo) pwhere.push(`p.repo = ${q(repo)}`)
  if (sinceDays !== null) {
    const since = new Date(Date.parse(nowIso) - sinceDays * 86_400_000).toISOString()
    pwhere.push(`EXISTS (SELECT 1 FROM threads t WHERE t.id = p.a AND t.opened_at >= ${q(since)})`)
  }
  const pairs = `SELECT p.bot_a, p.bot_b, p.same, COUNT(*) AS n FROM thread_pairs p ${pwhere.length ? `WHERE ${pwhere.join(' AND ')}` : ''} GROUP BY p.bot_a, p.bot_b, p.same;`
  return { threads, pairs }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

export function aggregateStats(rows: StatRow[], pairRows: PairRow[], repo: string | null, sinceDays: number | null, now: number): StatsReport {
  const byBot = new Map<string, StatRow[]>()
  for (const r of rows) {
    const list = byBot.get(r.bot) ?? []
    list.push(r)
    byBot.set(r.bot, list)
  }
  const bots: BotStats[] = [...byBot.entries()]
    .map(([bot, list]) => {
      const count = (o: Outcome) => list.filter(r => r.outcome === o).length
      const used = count('used')
      const dismissed = count('dismissed')
      const resolved = count('resolved')
      const settled = used + dismissed + resolved
      const severities: Record<string, number> = {}
      for (const r of list) {
        const key = r.severity ?? 'unrated'
        severities[key] = (severities[key] ?? 0) + 1
      }
      const duplicated = list.filter(r => r.dup > 0).length
      return {
        bot,
        findings: list.length,
        prs: new Set(list.map(r => r.number)).size,
        used,
        dismissed,
        resolved,
        open: count('open'),
        usedRate: settled ? used / settled : null,
        medianResponseSeconds: median(list.map(r => r.response_seconds).filter((v): v is number => v !== null)),
        duplicated,
        unique: list.length - duplicated,
        severities,
      }
    })
    .sort((a, b) => b.findings - a.findings)

  const pairMap = new Map<string, PairStats>()
  for (const p of pairRows) {
    const [botA, botB] = [p.bot_a, p.bot_b].sort()
    const key = `${botA}|${botB}`
    const entry = pairMap.get(key) ?? { botA: botA!, botB: botB!, same: 0, judged: 0, unjudged: 0 }
    if (p.same === null) entry.unjudged += p.n
    else {
      entry.judged += p.n
      if (p.same === 1) entry.same += p.n
    }
    pairMap.set(key, entry)
  }
  const pairs = [...pairMap.values()].sort((a, b) => b.same - a.same)
  return {
    repo,
    sinceDays,
    generatedAt: now,
    totalThreads: rows.length,
    totalPrs: new Set(rows.map(r => r.number)).size,
    bots,
    pairs,
    unjudgedPairs: pairs.reduce((n, p) => n + p.unjudged, 0),
  }
}

export function fmtSeconds(s: number | null): string {
  if (s === null) return '–'
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

export function pct(n: number | null): string {
  return n === null ? '–' : `${Math.round(n * 100)}%`
}

export function formatStats(r: StatsReport): string {
  const scope = `${r.repo ?? 'all repos'}${r.sinceDays ? `, last ${r.sinceDays} days` : ''}`
  if (r.bots.length === 0) return `No bot review threads recorded yet for ${scope}. Open a PR in the pane or run /prs backfill 30.`
  const lines = [`Review bots on ${scope}: ${r.totalThreads} findings across ${r.totalPrs} PRs`, '']
  lines.push('bot               findings  PRs  used  dismissed  unknown  open  used%  median response  unique  duplicated')
  for (const b of r.bots) {
    lines.push(
      [
        b.bot.padEnd(17),
        String(b.findings).padStart(8),
        String(b.prs).padStart(4),
        String(b.used).padStart(5),
        String(b.dismissed).padStart(10),
        String(b.resolved).padStart(8),
        String(b.open).padStart(5),
        pct(b.usedRate).padStart(6),
        fmtSeconds(b.medianResponseSeconds).padStart(16),
        String(b.unique).padStart(7),
        String(b.duplicated).padStart(11),
      ].join(' '),
    )
  }
  lines.push('')
  lines.push('used = resolved and the code moved (addressing commit touched the file, diff outdated, or the reply says fixed).')
  lines.push('dismissed = resolved with a reply saying no and no code change. unknown = resolved with no evidence either way.')
  if (r.pairs.length) {
    lines.push('', 'overlap between bots (same finding on the same file, judged by the model):')
    for (const p of r.pairs) {
      lines.push(`  ${p.botA} × ${p.botB}: ${p.same} same of ${p.judged} judged${p.unjudged ? `, ${p.unjudged} not judged yet` : ''}`)
    }
    if (r.unjudgedPairs) lines.push(`  run /prs judge to settle the ${r.unjudgedPairs} unjudged pair(s)`)
  }
  return lines.join('\n')
}
