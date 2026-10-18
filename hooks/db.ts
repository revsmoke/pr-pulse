// Pure SQL builders and the analysis rules for the review-bot ledger kept in
// SQLite (driven through the sqlite3 CLI from register.tsx). No `$` here.

import type { BotStats, CommitPatch, Hunk, Outcome, PairStats, PrDetail, StatsReport, Thread } from '../types'
import { displayName } from './github.ts'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS prs (
  repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT, author TEXT, state TEXT,
  created_at TEXT, merged_at TEXT, closed_at TEXT, head_ref TEXT, base_ref TEXT,
  additions INTEGER, deletions INTEGER, changed_files INTEGER, commit_count INTEGER,
  agents TEXT, recorded_at TEXT, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS commits (
  repo TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, committed_at TEXT, author TEXT,
  co_authors TEXT, headline TEXT, files TEXT, hunks TEXT, PRIMARY KEY (repo, number, sha));
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, bot TEXT, opened_by TEXT,
  opened_by_is_bot INTEGER, opened_at TEXT, path TEXT, line INTEGER, severity TEXT, title TEXT, body TEXT,
  trigger_sha TEXT, trigger_at TEXT, response_seconds INTEGER, is_resolved INTEGER, resolved_by TEXT,
  is_outdated INTEGER, replies INTEGER, last_reply_by TEXT, last_reply_at TEXT, last_reply_body TEXT,
  addressed_by TEXT, addressed_touched_file INTEGER, outcome TEXT, url TEXT, updated_at TEXT,
  kind TEXT DEFAULT 'thread', has_findings INTEGER DEFAULT 1, original_line INTEGER, addressed_touched_line INTEGER);
CREATE INDEX IF NOT EXISTS threads_repo_bot ON threads (repo, bot, opened_at);
CREATE TABLE IF NOT EXISTS thread_pairs (
  a TEXT NOT NULL, b TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, bot_a TEXT, bot_b TEXT,
  same INTEGER, reason TEXT, judged_at TEXT, basis TEXT DEFAULT 'colocated', PRIMARY KEY (a, b));
`

// Columns added after the first release; each ALTER fails harmlessly on a
// ledger that already has it, so these run without -bail.
export const MIGRATIONS = [
  "ALTER TABLE threads ADD COLUMN kind TEXT DEFAULT 'thread';",
  'ALTER TABLE threads ADD COLUMN has_findings INTEGER DEFAULT 1;',
  'ALTER TABLE threads ADD COLUMN original_line INTEGER;',
  'ALTER TABLE threads ADD COLUMN addressed_touched_line INTEGER;',
  'ALTER TABLE commits ADD COLUMN hunks TEXT;',
  "ALTER TABLE thread_pairs ADD COLUMN basis TEXT DEFAULT 'colocated';",
]

export function q(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`
}

const POSITIVE = /\b(fixed|done|addressed|applied|resolved|good catch|updated|implemented|added|removed|changed|thanks?,? (fixed|done))\b/i
const NEGATIVE = /\b(won'?t fix|wontfix|not applicable|false positive|intentional|by design|as designed|not an issue|no change needed|out of scope|declin\w*|ignor\w*|skip\w*|n\/a|incorrect|wrong|disagree|not needed|already handled|working as intended)\b/i

// ---------- patches ----------

// Reads `@@ -a,b +c,d @@` headers out of a unified diff.
export function parseHunks(patch: string | null | undefined): Hunk[] {
  if (!patch) return []
  const out: Hunk[] = []
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patch)) !== null) {
    out.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])])
  }
  return out
}

export function patchFromRest(json: string): CommitPatch | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const files: string[] = []
  const hunks: Record<string, Hunk[]> = {}
  for (const entry of parsed as { filename?: string; patch?: string | null }[]) {
    if (!entry.filename) continue
    files.push(entry.filename)
    hunks[entry.filename] = parseHunks(entry.patch)
  }
  return { files, hunks }
}

// Whether a commit's change to the thread's file reaches the commented line:
// the old side of a hunk covers the line as it stood when the comment was made
// (`originalLine`), or the new side covers where GitHub now places it. A few
// lines of slack, since fixes often land just above or below the flagged line.
export function touchesLine(patch: CommitPatch | null | undefined, thread: Pick<Thread, 'path' | 'line' | 'originalLine'>, slack = 3): boolean | null {
  if (!patch) return null
  const hunks = patch.hunks[thread.path]
  if (!hunks) return false
  if (hunks.length === 0) return null // GitHub sends no patch for binary or very large files
  const lines = [thread.originalLine, thread.line].filter((n): n is number => n !== null)
  if (lines.length === 0) return null
  return hunks.some(([oldStart, oldLines, newStart, newLines]) =>
    lines.some(n => (n >= oldStart - slack && n <= oldStart + Math.max(oldLines, 1) + slack) || (n >= newStart - slack && n <= newStart + Math.max(newLines, 1) + slack)),
  )
}

// ---------- outcomes ----------

// How a thread ended: `used` when the code moved under it (GitHub marked the
// diff outdated, the addressing commit's hunk reaches the line, or the reply
// says so), `dismissed` when the reply says no and nothing moved, `resolved`
// when it closed with no evidence either way, `open` while it stands. A
// PR-level comment has no resolution: `comment`.
export function outcomeOf(thread: Thread, touchedFile: boolean | null, touchedLine: boolean | null = null): Outcome {
  if (thread.kind === 'comment') return 'comment'
  if (!thread.isResolved) return 'open'
  const reply = thread.lastReplyBody ?? ''
  if (NEGATIVE.test(reply) && touchedLine !== true && !thread.isOutdated) return 'dismissed'
  if (thread.isOutdated || touchedLine === true || POSITIVE.test(reply)) return 'used'
  // File touched but not the line, or nothing known: no claim either way.
  void touchedFile
  return 'resolved'
}

export function botOf(thread: Thread): string | null {
  return thread.openedByIsBot ? displayName(thread.openedBy) : null
}

export function recordSql(repo: string, pr: PrDetail, patches: ReadonlyMap<string, CommitPatch | null>, nowIso: string): string {
  const lines: string[] = ['BEGIN;']
  lines.push(
    `INSERT INTO prs (repo, number, title, author, state, created_at, merged_at, closed_at, head_ref, base_ref, additions, deletions, changed_files, commit_count, agents, recorded_at) VALUES (` +
      [repo, pr.number, pr.title, pr.author, pr.state, pr.createdAt, pr.mergedAt, pr.closedAt, pr.headRef, pr.baseRef, pr.additions, pr.deletions, pr.changedFiles, pr.commitCount, JSON.stringify(pr.agents), nowIso].map(q).join(', ') +
      `) ON CONFLICT (repo, number) DO UPDATE SET title = excluded.title, state = excluded.state, merged_at = excluded.merged_at, closed_at = excluded.closed_at, additions = excluded.additions, deletions = excluded.deletions, changed_files = excluded.changed_files, commit_count = excluded.commit_count, agents = excluded.agents, recorded_at = excluded.recorded_at;`,
  )
  for (const c of pr.commits) {
    const patch = patches.get(c.sha)
    lines.push(
      `INSERT INTO commits (repo, number, sha, committed_at, author, co_authors, headline, files, hunks) VALUES (` +
        [repo, pr.number, c.sha, c.at, c.author, JSON.stringify(c.coAuthors), c.headline, patch ? JSON.stringify(patch.files) : null, patch ? JSON.stringify(patch.hunks) : null].map(q).join(', ') +
        `) ON CONFLICT (repo, number, sha) DO UPDATE SET files = COALESCE(excluded.files, commits.files), hunks = COALESCE(excluded.hunks, commits.hunks);`,
    )
  }
  for (const t of pr.threads) {
    const patch = t.addressedBy ? patches.get(t.addressedBy) : undefined
    const touchedFile = patch === undefined || patch === null ? null : patch.files.includes(t.path)
    const touchedLine = touchesLine(patch, t)
    const outcome = outcomeOf(t, touchedFile, touchedLine)
    lines.push(
      `INSERT INTO threads (id, repo, number, bot, opened_by, opened_by_is_bot, opened_at, path, line, severity, title, body, trigger_sha, trigger_at, response_seconds, is_resolved, resolved_by, is_outdated, replies, last_reply_by, last_reply_at, last_reply_body, addressed_by, addressed_touched_file, outcome, url, updated_at, kind, has_findings, original_line, addressed_touched_line) VALUES (` +
        [t.id, repo, pr.number, botOf(t), t.openedBy, t.openedByIsBot, t.openedAt, t.path, t.line, t.severity, t.title, t.body, t.triggerSha, t.triggerAt, t.responseSeconds, t.isResolved, t.resolvedBy, t.isOutdated, t.replies, t.lastReplyBy, t.lastReplyAt, t.lastReplyBody, t.addressedBy, touchedFile, outcome, t.url, nowIso, t.kind, t.hasFindings, t.originalLine, touchedLine].map(q).join(', ') +
        `) ON CONFLICT (id) DO UPDATE SET is_resolved = excluded.is_resolved, resolved_by = excluded.resolved_by, is_outdated = excluded.is_outdated, replies = excluded.replies, last_reply_by = excluded.last_reply_by, last_reply_at = excluded.last_reply_at, last_reply_body = excluded.last_reply_body, addressed_by = excluded.addressed_by, addressed_touched_file = COALESCE(excluded.addressed_touched_file, threads.addressed_touched_file), addressed_touched_line = COALESCE(excluded.addressed_touched_line, threads.addressed_touched_line), outcome = excluded.outcome, updated_at = excluded.updated_at, kind = excluded.kind, has_findings = excluded.has_findings, original_line = excluded.original_line;`,
    )
  }
  for (const { a, b, basis } of candidatePairs(pr.threads)) {
    lines.push(
      `INSERT OR IGNORE INTO thread_pairs (a, b, repo, number, bot_a, bot_b, same, reason, judged_at, basis) VALUES (` +
        [a.id, b.id, repo, pr.number, botOf(a), botOf(b), null, null, null, basis].map(q).join(', ') +
        `);`,
    )
  }
  lines.push('COMMIT;')
  return lines.join('\n')
}

// ---------- duplicate candidates ----------

const STOP = new Set('the this that with from into when then than they them their there here have has had been being were was will would should could must also only just very more most some such each other same about after before while where which what into onto over under between within without because since during against through across until unless using used use make makes made like need needs needed'.split(' '))

export function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/<!--[\s\S]*?-->/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9_./-]+/g, ' ').split(' ')) {
    const w = raw.replace(/^[./-]+|[./-]+$/g, '')
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue
    out.add(w)
  }
  return out
}

export function similarity(a: string, b: string): number {
  const ka = keywords(a)
  const kb = keywords(b)
  if (ka.size === 0 || kb.size === 0) return 0
  let shared = 0
  for (const w of ka) if (kb.has(w)) shared += 1
  return shared / (ka.size + kb.size - shared)
}

export type Candidate = { a: Thread; b: Thread; basis: 'colocated' | 'similar'; score: number }

// Two bots' findings may be the same: on the same file within a few lines
// (`colocated`), or anywhere in the PR with enough words in common
// (`similar`, including PR-level comments). The model settles each later.
// Ordered by id so each pair is stored once; capped per PR to bound the calls.
export function candidatePairs(threads: Thread[], lineWindow = 8, minSimilarity = 0.22, cap = 60): Candidate[] {
  const bots = threads.filter(t => t.openedByIsBot && t.hasFindings)
  const out: Candidate[] = []
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const x = bots[i]!
      const y = bots[j]!
      if (botOf(x) === botOf(y)) continue
      const [a, b] = x.id < y.id ? [x, y] : [y, x]
      const sameFile = a.kind === 'thread' && b.kind === 'thread' && a.path === b.path
      const near = sameFile && (a.line === null || b.line === null || Math.abs(a.line - b.line) <= lineWindow)
      if (near) {
        out.push({ a, b, basis: 'colocated', score: 1 })
        continue
      }
      const score = similarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`)
      if (score >= minSimilarity) out.push({ a, b, basis: 'similar', score })
    }
  }
  out.sort((p, r) => r.score - p.score)
  return out.slice(0, cap)
}

export function judgePrompt(a: { path: string; line: number | null; body: string }, b: { path: string; line: number | null; body: string }): string {
  const where = (x: { path: string; line: number | null }) => (x.path ? `${x.path}${x.line ? `:${x.line}` : ''}` : 'a PR-level comment')
  return [
    'Two automated code-review comments were left on the same pull request.',
    'Do they report the same underlying issue (same defect or the same requested change), even if worded differently or placed on different lines?',
    'A broad summary that merely mentions the area is NOT the same issue. Answer on the first line with exactly YES or NO, then one short sentence of reason.',
    '',
    `Comment A (${where(a)}):`,
    a.body,
    '',
    `Comment B (${where(b)}):`,
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
  return `SELECT sha, files, hunks FROM commits WHERE repo = ${q(repo)} AND number = ${q(number)} AND files IS NOT NULL;`
}

// ---------- stats ----------

export type StatRow = {
  id: string
  number: number
  bot: string
  kind: 'thread' | 'comment'
  has_findings: number
  severity: string | null
  response_seconds: number | null
  outcome: Outcome
  is_outdated: number
  addressed_touched_line: number | null
  dup: number
}

export type PairRow = { bot_a: string; bot_b: string; same: number | null; basis: string | null; n: number }

// One row per confirmed duplicate: who said it first and who repeated it.
export type SameRow = { bot_a: string; bot_b: string; at_a: string; at_b: string }

export function statsSql(repo: string | null, sinceDays: number | null, nowIso: string): { threads: string; pairs: string; sames: string } {
  const since = sinceDays === null ? null : new Date(Date.parse(nowIso) - sinceDays * 86_400_000).toISOString()
  const where: string[] = ['opened_by_is_bot = 1', 'bot IS NOT NULL']
  if (repo) where.push(`repo = ${q(repo)}`)
  if (since) where.push(`opened_at >= ${q(since)}`)
  const threads = `SELECT t.id, t.number, t.bot, COALESCE(t.kind, 'thread') AS kind, COALESCE(t.has_findings, 1) AS has_findings, t.severity, t.response_seconds, t.outcome, t.is_outdated, t.addressed_touched_line,
  (SELECT COUNT(*) FROM thread_pairs p WHERE p.same = 1 AND (p.a = t.id OR p.b = t.id)) AS dup
FROM threads t WHERE ${where.join(' AND ')};`
  const pwhere: string[] = []
  if (repo) pwhere.push(`p.repo = ${q(repo)}`)
  if (since) pwhere.push(`EXISTS (SELECT 1 FROM threads t WHERE t.id = p.a AND t.opened_at >= ${q(since)})`)
  const pw = pwhere.length ? `WHERE ${pwhere.join(' AND ')}` : ''
  const pairs = `SELECT p.bot_a, p.bot_b, p.same, COALESCE(p.basis, 'colocated') AS basis, COUNT(*) AS n FROM thread_pairs p ${pw} GROUP BY p.bot_a, p.bot_b, p.same, basis;`
  const sames = `SELECT p.bot_a, p.bot_b, ta.opened_at AS at_a, tb.opened_at AS at_b FROM thread_pairs p JOIN threads ta ON ta.id = p.a JOIN threads tb ON tb.id = p.b ${pw ? `${pw} AND p.same = 1` : 'WHERE p.same = 1'};`
  return { threads, pairs, sames }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

export function aggregateStats(rows: StatRow[], pairRows: PairRow[], sameRows: SameRow[], repo: string | null, sinceDays: number | null, now: number): StatsReport {
  const byBot = new Map<string, StatRow[]>()
  for (const r of rows) {
    const list = byBot.get(r.bot) ?? []
    list.push(r)
    byBot.set(r.bot, list)
  }
  const firsts = new Map<string, number>()
  const repeats = new Map<string, number>()
  for (const s of sameRows) {
    const [first, repeat] = s.at_a <= s.at_b ? [s.bot_a, s.bot_b] : [s.bot_b, s.bot_a]
    firsts.set(first, (firsts.get(first) ?? 0) + 1)
    repeats.set(repeat, (repeats.get(repeat) ?? 0) + 1)
  }
  const bots: BotStats[] = [...byBot.entries()]
    .map(([bot, list]) => {
      const threads = list.filter(r => r.kind !== 'comment')
      const comments = list.filter(r => r.kind === 'comment')
      const count = (o: Outcome) => threads.filter(r => r.outcome === o).length
      const used = count('used')
      const dismissed = count('dismissed')
      const resolved = count('resolved')
      const settled = used + dismissed + resolved
      const severities: Record<string, number> = {}
      for (const r of threads) {
        const key = r.severity ?? 'unrated'
        severities[key] = (severities[key] ?? 0) + 1
      }
      const findings = threads.length + comments.filter(c => c.has_findings).length
      const duplicated = list.filter(r => r.dup > 0 && (r.kind !== 'comment' || r.has_findings)).length
      return {
        bot,
        findings,
        threads: threads.length,
        comments: comments.length,
        commentsWithFindings: comments.filter(c => c.has_findings).length,
        prs: new Set(list.map(r => r.number)).size,
        used,
        codeVerified: threads.filter(r => r.outcome === 'used' && (r.is_outdated === 1 || r.addressed_touched_line === 1)).length,
        dismissed,
        resolved,
        open: count('open'),
        usedRate: settled ? used / settled : null,
        // Inline threads only, so a bot's quick status posts do not flatter it;
        // a bot that only comments at PR level is measured on those.
        medianResponseSeconds: median((threads.length ? threads : comments).map(r => r.response_seconds).filter((v): v is number => v !== null)),
        duplicated,
        unique: findings - duplicated,
        firsts: firsts.get(bot) ?? 0,
        repeats: repeats.get(bot) ?? 0,
        severities,
      }
    })
    .sort((a, b) => b.findings - a.findings)

  const pairMap = new Map<string, PairStats>()
  for (const p of pairRows) {
    const [botA, botB] = [p.bot_a, p.bot_b].sort()
    const key = `${botA}|${botB}`
    const entry = pairMap.get(key) ?? { botA: botA!, botB: botB!, same: 0, judged: 0, unjudged: 0, colocated: 0, similar: 0 }
    if (p.same === null) entry.unjudged += p.n
    else {
      entry.judged += p.n
      if (p.same === 1) {
        entry.same += p.n
        if (p.basis === 'similar') entry.similar += p.n
        else entry.colocated += p.n
      }
    }
    pairMap.set(key, entry)
  }
  const pairs = [...pairMap.values()].sort((a, b) => b.same - a.same)
  return {
    repo,
    sinceDays,
    generatedAt: now,
    totalThreads: rows.filter(r => r.kind !== 'comment' || r.has_findings).length,
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
  if (r.bots.length === 0) return `No bot review findings recorded yet for ${scope}. Open a PR in the pane or run /prs backfill 30.`
  const lines = [`Review bots on ${scope}: ${r.totalThreads} findings across ${r.totalPrs} PRs`, '']
  lines.push('bot                findings  threads  PR-comments  PRs  used  code-verified  dismissed  unknown  open  used%  median response  unique  duplicated  first  repeat')
  for (const b of r.bots) {
    lines.push(
      [
        b.bot.padEnd(18),
        String(b.findings).padStart(8),
        String(b.threads).padStart(8),
        `${b.commentsWithFindings}/${b.comments}`.padStart(12),
        String(b.prs).padStart(4),
        String(b.used).padStart(5),
        String(b.codeVerified).padStart(14),
        String(b.dismissed).padStart(10),
        String(b.resolved).padStart(8),
        String(b.open).padStart(5),
        pct(b.usedRate).padStart(6),
        fmtSeconds(b.medianResponseSeconds).padStart(16),
        String(b.unique).padStart(7),
        String(b.duplicated).padStart(11),
        String(b.firsts).padStart(6),
        String(b.repeats).padStart(7),
      ].join(' '),
    )
  }
  lines.push('')
  lines.push('findings = inline review threads + PR-level comments that report something (PR-comments shows reporting/total).')
  lines.push('used = resolved and the code moved: GitHub marked the diff outdated, the addressing commit touched the flagged line, or the reply says fixed.')
  lines.push('code-verified = used with code evidence (outdated diff or hunk on the line), not just a reply. dismissed = reply says no, nothing moved. unknown = resolved without evidence.')
  lines.push('first/repeat = of findings the model judged the same as another bot\'s, how many this bot raised first vs repeated after another bot. median response = push to inline comment.')
  if (r.pairs.length) {
    lines.push('', 'overlap between bots (same finding, judged by the model; co-located = same file within 8 lines, similar = wording match anywhere in the PR):')
    for (const p of r.pairs) {
      lines.push(`  ${p.botA} × ${p.botB}: ${p.same} same of ${p.judged} judged (${p.colocated} co-located, ${p.similar} similar)${p.unjudged ? `, ${p.unjudged} not judged yet` : ''}`)
    }
    if (r.unjudgedPairs) lines.push(`  run /prs judge to settle the ${r.unjudgedPairs} unjudged pair(s)`)
  }
  return lines.join('\n')
}
