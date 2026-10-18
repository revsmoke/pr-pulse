// pr-pulse: a pane that follows a repo's open pull requests in near real time,
// and a SQLite ledger of what the review bots found and what became of it.
// Checks, review bots, enforced branch rules, review threads and the commits
// that address them, the agents working on each PR. Data comes from the gh
// CLI (GraphQL); live state lives in $.state so a hot reload keeps it; the
// ledger is written through the sqlite3 CLI.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BackfillProgress, CommitPatch, PrDetail, SettledPr, Snapshot, StatsReport } from '../types'
import {
  MIGRATIONS,
  SCHEMA,
  aggregateStats,
  commitFilesSql,
  formatStats,
  formatTrend,
  hasLineCounts,
  judgePrompt,
  pairUpdateSql,
  parseJudgement,
  patchFromRest,
  recordSql,
  statsSql,
  unjudgedPairsSql,
  type PairRow,
  type SameRow,
  type StatRow,
  type UnjudgedRow,
} from './db.ts'
import { DETAIL_QUERY, LIST_QUERY, SETTLED_QUERY, TRIM_BODIES, diffSnapshots, parseDetail, parseList, parseSettledNumbers, statusLineOf } from './github.ts'
import { renderDetail, renderList, renderStats } from './view.tsx'

const PANE = 'pr-pulse'

const repoAtom = atom({ plugin: 'pr-pulse', key: 'repo' } as const, null)
const snapshotAtom = atom({ plugin: 'pr-pulse', key: 'snapshot' } as const, null)
const detailAtom = atom({ plugin: 'pr-pulse', key: 'detail' } as const, null)
const selectedAtom = atom({ plugin: 'pr-pulse', key: 'selected' } as const, null)
const errorAtom = atom({ plugin: 'pr-pulse', key: 'error' } as const, null)
const loadingAtom = atom({ plugin: 'pr-pulse', key: 'isLoading' } as const, false)
const settledAtom = atom({ plugin: 'pr-pulse', key: 'settled' } as const, [])
const modeAtom = atom({ plugin: 'pr-pulse', key: 'mode' } as const, 'prs')
const statsAtom = atom({ plugin: 'pr-pulse', key: 'stats' } as const, null)
const backfillAtom = atom({ plugin: 'pr-pulse', key: 'backfill' } as const, null)
const dbPathAtom = atom({ plugin: 'pr-pulse', key: 'dbPath' } as const, null)

type Settings = { pollMs: number; autoOpen: boolean; statusLine: boolean; toasts: boolean; dbPath: string }

let settings: Settings = { pollMs: 45_000, autoOpen: true, statusLine: true, toasts: true, dbPath: '' }
let sessionCwd: string | undefined
let isFetching = false
let hasOfferedPane = false
let isPolling = false
let isDbReady = false
let isBackfilling = false
// PR numbers already recorded in the ledger this session, by their updatedAt,
// so the poller records an open PR again only when GitHub says it changed.
const recordedAt = new Map<number, string>()
const patchBySha = new Map<string, CommitPatch | null>()

// ---------- gh ----------

type GhResult = { ok: boolean; out: string; err: string }

async function gh($: EngineInterface, args: readonly string[], timeoutMs = 60_000): Promise<GhResult> {
  try {
    const ran = await $.process.run(['gh', ...args], { cwd: sessionCwd, timeoutMs })
    return { ok: ran.exitCode === 0, out: ran.stdout, err: ran.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) }
  }
}

function shortError(err: string): string {
  const line = err.split('\n').find(l => l.trim().length > 0) ?? 'gh failed'
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

async function detectRepo($: EngineInterface): Promise<string | null> {
  const ran = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], 20_000)
  if (!ran.ok) return null
  const name = ran.out.trim()
  return /^[^/\s]+\/[^/\s]+$/.test(name) ? name : null
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, name }
}

// ---------- sqlite ----------

async function dbPath($: EngineInterface): Promise<string> {
  const known = await read($, dbPathAtom)
  if (known) return known
  let path = settings.dbPath.trim()
  if (!path) {
    const home = (await $.env.get('HOME')) ?? '.'
    path = `${home}/.claude/pr-pulse/reviews.db`
  } else if (path.startsWith('~/')) {
    path = `${(await $.env.get('HOME')) ?? '.'}${path.slice(1)}`
  }
  await update($, dbPathAtom, () => path)
  return path
}

async function sql($: EngineInterface, statements: string): Promise<{ ok: boolean; rows: unknown[]; err: string }> {
  const path = await dbPath($)
  if (!isDbReady) {
    const dir = path.slice(0, path.lastIndexOf('/'))
    try {
      if (dir) await $.process.run(['mkdir', '-p', dir], { timeoutMs: 10_000 })
      const made = await $.process.run(['sqlite3', '-bail', path], { stdin: SCHEMA, timeoutMs: 30_000 })
      if (made.exitCode !== 0) return { ok: false, rows: [], err: `sqlite3: ${shortError(made.stderr)}` }
      // Columns added since the first release; each ALTER fails harmlessly
      // where the column exists, so this run is not bailed on errors.
      await $.process.run(['sqlite3', path], { stdin: MIGRATIONS.join('\n'), timeoutMs: 30_000 })
      isDbReady = true
    } catch (error) {
      return { ok: false, rows: [], err: `sqlite3: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  try {
    const ran = await $.process.run(['sqlite3', '-bail', '-json', path], { stdin: statements, timeoutMs: 60_000 })
    if (ran.exitCode !== 0) return { ok: false, rows: [], err: `sqlite3: ${shortError(ran.stderr)}` }
    const text = ran.stdout.trim()
    return { ok: true, rows: text ? (JSON.parse(text) as unknown[]) : [], err: '' }
  } catch (error) {
    return { ok: false, rows: [], err: `sqlite3: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// What a commit changed, from the REST API: the files and each file's diff
// hunks, so a thread can be checked at the line, not just the file. Cached per
// sha for the session and in the ledger; asked only for commits credited with
// addressing a thread.
async function commitPatch($: EngineInterface, repo: string, sha: string): Promise<CommitPatch | null> {
  const cached = patchBySha.get(sha)
  if (cached !== undefined) return cached
  const ran = await gh($, ['api', `repos/${repo}/commits/${sha}`, '--jq', '[.files[] | {filename, patch: ((.patch // "")[0:60000])}]'], 30_000)
  const patch = ran.ok ? patchFromRest(ran.out) : null
  patchBySha.set(sha, patch)
  return patch
}

async function recordDetail($: EngineInterface, repo: string, detail: PrDetail): Promise<string | null> {
  const known = await sql($, commitFilesSql(repo, detail.number))
  if (!known.ok) return known.err
  for (const row of known.rows as { sha: string; files: string; hunks: string | null }[]) {
    // A row written before hunks (or their line counts) were kept is fetched
    // again once; a complete one is reused.
    if (!patchBySha.has(row.sha) && row.hunks) {
      try {
        const patch = { files: JSON.parse(row.files) as string[], hunks: JSON.parse(row.hunks) as CommitPatch['hunks'] }
        if (hasLineCounts(patch)) patchBySha.set(row.sha, patch)
      } catch {
        // unreadable row: fetch again below
      }
    }
  }
  const wanted = new Set(detail.threads.map(t => t.addressedBy).filter((s): s is string => s !== null))
  for (const sha of wanted) await commitPatch($, repo, sha)
  const written = await sql($, recordSql(repo, detail, patchBySha, new Date(await $.clock.now()).toISOString()))
  if (!written.ok) return written.err
  recordedAt.set(detail.number, detail.updatedAt)
  return null
}

// Settles unjudged candidate pairs with one cheap model call each: do two bots'
// comments on the same file report the same issue?
async function judgePairs($: EngineInterface, repo: string | null, limit: number): Promise<{ judged: number; same: number; error: string | null }> {
  const found = await sql($, unjudgedPairsSql(repo, limit))
  if (!found.ok) return { judged: 0, same: 0, error: found.err }
  let judged = 0
  let same = 0
  for (const row of found.rows as UnjudgedRow[]) {
    const reply = await $.model.complete({
      model: 'haiku',
      prompt: judgePrompt({ path: row.path_a, line: row.line_a, body: row.body_a }, { path: row.path_b, line: row.line_b, body: row.body_b }),
      maxTokens: 80,
      effort: 'low',
      timeoutMs: 30_000,
    })
    if (!reply.isAnswered) continue
    const verdict = parseJudgement(reply.text)
    if (!verdict) continue
    const saved = await sql($, pairUpdateSql(row.a, row.b, verdict.same, verdict.reason, new Date(await $.clock.now()).toISOString()))
    if (!saved.ok) return { judged, same, error: saved.err }
    judged += 1
    if (verdict.same) same += 1
  }
  return { judged, same, error: null }
}

async function fetchDetail($: EngineInterface, repo: string, number: number): Promise<{ detail: PrDetail | null; error: string | null }> {
  const { owner, name } = splitRepo(repo)
  const ran = await gh($, [
    'api', 'graphql',
    '-f', `query=${DETAIL_QUERY}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`,
    '--jq', TRIM_BODIES,
  ])
  if (!ran.ok) return { detail: null, error: `GitHub: ${shortError(ran.err || ran.out)}` }
  const snapshot = await read($, snapshotAtom)
  try {
    return { detail: parseDetail(ran.out, await $.clock.now(), snapshot?.rules ?? null), error: null }
  } catch (error) {
    return { detail: null, error: `GitHub: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function computeStats($: EngineInterface, repo: string | null, sinceDays: number | null, trendWeeks = 12): Promise<{ report: StatsReport | null; error: string | null }> {
  const now = await $.clock.now()
  const queries = statsSql(repo, sinceDays, new Date(now).toISOString())
  const threads = await sql($, queries.threads)
  if (!threads.ok) return { report: null, error: threads.err }
  const pairs = await sql($, queries.pairs)
  if (!pairs.ok) return { report: null, error: pairs.err }
  const sames = await sql($, queries.sames)
  if (!sames.ok) return { report: null, error: sames.err }
  const report = aggregateStats(threads.rows as StatRow[], pairs.rows as PairRow[], sames.rows as SameRow[], repo, sinceDays, now, trendWeeks)
  await update($, statsAtom, () => report)
  return { report, error: null }
}

// Sweeps merged and closed PRs into the ledger so the stats have history from
// day one; runs in the background and reports through the pane and status line.
async function backfill($: EngineInterface, repo: string, count: number): Promise<void> {
  if (isBackfilling) return
  isBackfilling = true
  const progress = async (p: Partial<BackfillProgress>) => update($, backfillAtom, prior => ({ ...(prior ?? { running: true, done: 0, total: 0, message: '' }), ...p }))
  try {
    await progress({ running: true, done: 0, total: 0, message: 'listing settled PRs…' })
    const { owner, name } = splitRepo(repo)
    const listed = await gh($, ['api', 'graphql', '-f', `query=${SETTLED_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `count=${Math.min(100, Math.max(1, count))}`])
    if (!listed.ok) {
      await progress({ running: false, message: `GitHub: ${shortError(listed.err || listed.out)}` })
      return
    }
    const numbers = parseSettledNumbers(listed.out)
    await progress({ total: numbers.length, message: `recording ${numbers.length} PRs…` })
    let done = 0
    let failed = 0
    for (const number of numbers) {
      const got = await fetchDetail($, repo, number)
      if (got.detail) {
        const err = await recordDetail($, repo, got.detail)
        if (err) failed += 1
      } else failed += 1
      done += 1
      await progress({ done, message: `recorded ${done}/${numbers.length}${failed ? `, ${failed} failed` : ''}` })
      $.ui.status(`pr-pulse backfill ${done}/${numbers.length}`)
    }
    await progress({ message: `judging overlapping findings…` })
    const judged = await judgePairs($, repo, 800)
    const stats = await computeStats($, repo, null)
    await progress({ running: false, message: `backfilled ${done} PRs${failed ? ` (${failed} failed)` : ''}, judged ${judged.judged} pairs${judged.error ? `; ${judged.error}` : ''}` })
    if (settings.toasts) $.ui.toast(`pr-pulse: backfilled ${done} PRs, ${stats.report?.totalThreads ?? 0} bot findings on record`)
  } catch (error) {
    await progress({ running: false, message: error instanceof Error ? error.message : String(error) })
  } finally {
    isBackfilling = false
    const snapshot = await read($, snapshotAtom)
    $.ui.status(settings.statusLine && snapshot ? statusLineOf(snapshot) : undefined)
  }
}

// ---------- fetching ----------

async function refreshList($: EngineInterface): Promise<Snapshot | null> {
  const repo = await read($, repoAtom)
  if (!repo) return null
  const { owner, name } = splitRepo(repo)
  const ran = await gh($, ['api', 'graphql', '-f', `query=${LIST_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`])
  if (!ran.ok) {
    await update($, errorAtom, () => `GitHub: ${shortError(ran.err || ran.out)}`)
    return null
  }
  let snapshot: Snapshot
  try {
    snapshot = parseList(ran.out, await $.clock.now())
  } catch (error) {
    await update($, errorAtom, () => `GitHub: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  const previous = await read($, snapshotAtom)
  await update($, snapshotAtom, () => snapshot)
  await update($, errorAtom, () => null)
  if (!isBackfilling) $.ui.status(settings.statusLine ? statusLineOf(snapshot) : undefined)

  if (settings.toasts) {
    for (const change of diffSnapshots(previous, snapshot).slice(0, 3)) $.ui.toast(change.text)
  }
  if (previous && previous.repo === snapshot.repo) {
    const gone = previous.prs.filter(p => !snapshot.prs.some(q => q.number === p.number))
    for (const pr of gone) await noteSettled($, repo, pr.number)
  }
  await recheckBranches($, repo)
  return snapshot
}

// Records every open PR whose activity changed since it was last written, a
// few per poll, so the ledger follows PRs nobody drills into.
async function recordChangedPrs($: EngineInterface, repo: string, snapshot: Snapshot, limit = 3): Promise<void> {
  let written = 0
  for (const pr of snapshot.prs) {
    if (written >= limit) break
    if (recordedAt.get(pr.number) === pr.updatedAt) continue
    const got = await fetchDetail($, repo, pr.number)
    if (!got.detail) continue
    const err = await recordDetail($, repo, got.detail)
    if (err) {
      $.ui.log(`pr-pulse: ledger write failed: ${err}`, { to: 'debug' })
      return
    }
    written += 1
    const selected = await read($, selectedAtom)
    if (selected === pr.number) await update($, detailAtom, () => got.detail)
  }
  if (written > 0) await judgePairs($, repo, 25)
}

async function refreshDetail($: EngineInterface, number: number): Promise<void> {
  const repo = await read($, repoAtom)
  if (!repo) return
  const got = await fetchDetail($, repo, number)
  if (!got.detail) {
    await update($, errorAtom, () => got.error)
    return
  }
  const stillSelected = (await read($, selectedAtom)) === number
  if (stillSelected) await update($, detailAtom, () => got.detail)
  await update($, errorAtom, () => null)
  const err = await recordDetail($, repo, got.detail)
  if (err) $.ui.log(`pr-pulse: ledger write failed: ${err}`, { to: 'debug' })
}

async function noteSettled($: EngineInterface, repo: string, number: number): Promise<void> {
  const ran = await gh($, ['pr', 'view', String(number), '--repo', repo, '--json', 'number,title,url,state,mergedAt,closedAt,mergedBy,headRefName'], 20_000)
  if (!ran.ok) return
  let raw: { number: number; title: string; url: string; state: string; mergedAt: string | null; closedAt: string | null; mergedBy: { login?: string } | null; headRefName: string }
  try {
    raw = JSON.parse(ran.out)
  } catch {
    return
  }
  if (raw.state === 'OPEN') return
  const entry: SettledPr = {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state === 'MERGED' ? 'MERGED' : 'CLOSED',
    at: raw.mergedAt ?? raw.closedAt,
    by: raw.mergedBy?.login ?? null,
    headRef: raw.headRefName,
    branchDeleted: await branchIsGone($, repo, raw.headRefName),
    seenAt: await $.clock.now(),
  }
  const list = await update($, settledAtom, prior => [entry, ...prior.filter(s => s.number !== entry.number)].slice(0, 10))
  await $.store.set(`settled:${repo}`, list)
  if (settings.toasts) {
    const branch = entry.branchDeleted === true ? ', branch deleted' : entry.branchDeleted === false ? `, branch ${entry.headRef} still exists` : ''
    $.ui.toast(`PR #${entry.number} ${entry.state.toLowerCase()}${entry.by ? ` by ${entry.by}` : ''}${branch}`)
  }
  // The final word on the PR's threads goes into the ledger.
  const got = await fetchDetail($, repo, number)
  if (got.detail) await recordDetail($, repo, got.detail)
  const selected = await read($, selectedAtom)
  if (selected === number) {
    await update($, selectedAtom, () => null)
    await update($, detailAtom, () => null)
  }
}

async function branchIsGone($: EngineInterface, repo: string, branch: string): Promise<boolean | null> {
  const ran = await gh($, ['api', `repos/${repo}/branches/${encodeURIComponent(branch)}`, '--silent'], 20_000)
  if (ran.ok) return false
  return /404|Not Found/i.test(ran.err) ? true : null
}

async function recheckBranches($: EngineInterface, repo: string): Promise<void> {
  const settled = await read($, settledAtom)
  const pending = settled.filter(s => s.branchDeleted !== true)
  if (pending.length === 0) return
  let changed = false
  const next: SettledPr[] = []
  for (const s of settled) {
    if (s.branchDeleted === true) {
      next.push(s)
      continue
    }
    const gone = await branchIsGone($, repo, s.headRef)
    if (gone !== s.branchDeleted) {
      changed = true
      if (gone === true && settings.toasts) $.ui.toast(`#${s.number}: branch ${s.headRef} deleted`)
    }
    next.push({ ...s, branchDeleted: gone })
  }
  if (changed) {
    await update($, settledAtom, () => next)
    await $.store.set(`settled:${repo}`, next)
  }
}

async function refreshAll($: EngineInterface): Promise<void> {
  if (isFetching) return
  isFetching = true
  await update($, loadingAtom, () => true)
  try {
    const snapshot = await refreshList($)
    const selected = await read($, selectedAtom)
    if (selected !== null) await refreshDetail($, selected)
    const repo = await read($, repoAtom)
    if (snapshot && repo) await recordChangedPrs($, repo, snapshot)
    if (snapshot && settings.autoOpen && !hasOfferedPane && snapshot.prs.length > 0) {
      hasOfferedPane = true
      const isUp = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isUp) void $.ui.open({ id: PANE, title: 'PRs' })
    }
  } finally {
    isFetching = false
    await update($, loadingAtom, () => false)
  }
}

async function selectPr($: EngineInterface, number: number | null): Promise<void> {
  await update($, modeAtom, () => 'prs')
  await update($, selectedAtom, () => number)
  if (number === null) {
    await update($, detailAtom, () => null)
    return
  }
  const detail = await read($, detailAtom)
  if (detail?.number !== number) await update($, detailAtom, () => null)
  await update($, loadingAtom, () => true)
  try {
    await refreshDetail($, number)
  } finally {
    await update($, loadingAtom, () => false)
  }
}

async function setRepo($: EngineInterface, repo: string | null): Promise<void> {
  await update($, repoAtom, () => repo)
  await update($, snapshotAtom, () => null)
  await update($, detailAtom, () => null)
  await update($, selectedAtom, () => null)
  await update($, errorAtom, () => null)
  await update($, statsAtom, () => null)
  recordedAt.clear()
  const stored = repo ? await $.store.get(`settled:${repo}`) : undefined
  await update($, settledAtom, () => (Array.isArray(stored) ? (stored as SettledPr[]) : []))
  $.ui.status(undefined)
}

function startPolling($: EngineInterface): void {
  if (isPolling) return
  isPolling = true
  $.clock.every(settings.pollMs, () => refreshAll($))
}

// Finds the repo when none is known yet (a session that started outside a
// checkout, or a test), and starts the poll once one is.
async function ensureRepo($: EngineInterface): Promise<string | null> {
  const known = await read($, repoAtom)
  if (known) {
    startPolling($)
    return known
  }
  const found = await detectRepo($)
  if (found) {
    await setRepo($, found)
    startPolling($)
  }
  return found
}

async function showStats($: EngineInterface, repo: string | null, sinceDays: number | null): Promise<string> {
  const got = await computeStats($, repo, sinceDays)
  await update($, modeAtom, () => 'stats')
  await $.ui.open({ id: PANE, title: 'PRs', focus: true })
  if (!got.report) return got.error ?? 'stats failed'
  return formatStats(got.report)
}

function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const seconds = Number(options['pollSeconds'] ?? 45)
  return {
    pollMs: Math.max(15, Number.isFinite(seconds) ? seconds : 45) * 1000,
    autoOpen: options['autoOpen'] !== false,
    statusLine: options['statusLine'] !== false,
    toasts: options['toasts'] !== false,
    dbPath: typeof options['dbPath'] === 'string' ? options['dbPath'] : '',
  }
}

const USAGE = 'Usage: /prs · /prs N · /prs back · /prs refresh · /prs close · /prs repo owner/name · /prs stats [days|all] [all-repos] · /prs trend [weeks] · /prs backfill [N] · /prs judge [N] · /prs db'

// ---------- hooks ----------

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.command.register({
      name: 'prs',
      description: 'Pull request pane and review-bot ledger: /prs, /prs N, /prs stats, /prs backfill, /prs judge, /prs repo owner/name',
      argumentHint: '[N | back | refresh | close | stats [days] | trend [weeks] | backfill [N] | judge [N] | db | repo owner/name]',
    })
    hasOfferedPane = !e.isInteractive
    const repo = await ensureRepo($)
    if (repo) $.clock.after(200, () => refreshAll($))
    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const args = e.args.trim()
    const repoMatch = /^repo\s+([^/\s]+\/[^/\s]+)$/i.exec(args)
    if (repoMatch && repoMatch[1]) {
      await setRepo($, repoMatch[1])
      startPolling($)
      await $.ui.open({ id: PANE, title: 'PRs', focus: true })
      void refreshAll($)
      return { text: `Watching ${repoMatch[1]}.` }
    }
    const repo = await ensureRepo($)
    if (/^close$/i.test(args)) {
      await $.ui.close({ id: PANE })
      return { text: 'PR pane closed.' }
    }
    if (/^(back|list|prs)$/i.test(args)) {
      await selectPr($, null)
      await $.ui.open({ id: PANE, title: 'PRs', focus: true })
      return { text: 'Showing all open PRs.' }
    }
    if (/^refresh$/i.test(args)) {
      await $.ui.open({ id: PANE, title: 'PRs' })
      if (!repo) return { text: 'No GitHub repo detected here. Try /prs repo owner/name.' }
      await refreshAll($)
      const error = await read($, errorAtom)
      return { text: error ?? 'PR status refreshed.' }
    }
    if (/^db$/i.test(args)) {
      return { text: `Ledger: ${await dbPath($)} (open with: sqlite3 "${await dbPath($)}")` }
    }
    const stats = /^stats(?:\s+(\d+|all))?(?:\s+(all-repos))?$/i.exec(args)
    if (stats) {
      const days = stats[1] && stats[1] !== 'all' ? Number(stats[1]) : null
      const scope = stats[2] ? null : repo
      return { text: await showStats($, scope, days) }
    }
    const trend = /^trend(?:\s+(\d+))?(?:\s+(all-repos))?$/i.exec(args)
    if (trend) {
      const weeks = trend[1] ? Math.max(1, Math.min(52, Number(trend[1]))) : 12
      const got = await computeStats($, trend[2] ? null : repo, null, weeks)
      await update($, modeAtom, () => 'stats')
      await $.ui.open({ id: PANE, title: 'PRs', focus: true })
      return { text: got.report ? formatTrend(got.report) : got.error ?? 'trend failed' }
    }
    const back = /^backfill(?:\s+(\d+))?$/i.exec(args)
    if (back) {
      if (!repo) return { text: 'No GitHub repo detected here. Try /prs repo owner/name first.' }
      if (isBackfilling) return { text: 'A backfill is already running; watch the pane for progress.' }
      const count = back[1] ? Number(back[1]) : 30
      await update($, modeAtom, () => 'stats')
      await $.ui.open({ id: PANE, title: 'PRs' })
      $.clock.after(10, () => backfill($, repo, count))
      return { text: `Backfilling the last ${count} merged or closed PRs of ${repo} into the ledger in the background. /prs stats when it finishes.` }
    }
    const judge = /^judge(?:\s+(\d+))?$/i.exec(args)
    if (judge) {
      const result = await judgePairs($, repo, judge[1] ? Number(judge[1]) : 100)
      if (result.error) return { text: result.error }
      await computeStats($, repo, null)
      return { text: `Judged ${result.judged} overlapping pair(s): ${result.same} report the same finding.` }
    }
    const number = /^#?(\d+)$/.exec(args)
    if (number && number[1]) {
      const n = Number(number[1])
      await $.ui.open({ id: PANE, title: 'PRs', focus: true })
      void selectPr($, n)
      return { text: `Showing PR #${n}.` }
    }
    if (args.length > 0) return { text: USAGE }
    await update($, modeAtom, () => 'prs')
    const opened = await $.ui.open({ id: PANE, title: 'PRs', focus: true })
    void refreshAll($)
    if (!opened.isPlaced) return { text: `PR pane opened but not drawn yet: ${opened.reason}` }
    return { text: 'PR pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\b(git\s+push|gh\s+pr\b|gh\s+api\b|git\s+merge|gh\s+run\b)/.test(e.command)) {
      $.clock.after(6_000, () => refreshAll($))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const table = { Box, Text, Button, Link }
    const [repo, snapshot, detail, selected, error, isLoading, settled, mode, stats, progress] = await Promise.all([
      read($, repoAtom),
      read($, snapshotAtom),
      read($, detailAtom),
      read($, selectedAtom),
      read($, errorAtom),
      read($, loadingAtom),
      read($, settledAtom),
      read($, modeAtom),
      read($, statsAtom),
      read($, backfillAtom),
    ])
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const actions = {
      select: (number: number) => {
        void selectPr($, number)
      },
      back: () => {
        void selectPr($, null)
      },
      refresh: () => {
        void refreshAll($)
      },
      stats: () => {
        void showStats($, repo, null)
      },
      judge: () => {
        void judgePairs($, repo, 100).then(() => computeStats($, repo, null))
      },
    }

    if (mode === 'stats') {
      return renderStats(table, { repo, stats, progress, error, now, width }, actions)
    }
    if (selected !== null && detail && detail.number === selected) {
      return renderDetail(table, { detail, rules: snapshot?.rules ?? null, error, isLoading, now, width }, actions)
    }
    if (selected !== null) {
      return (
        <Box flexDirection="column">
          <Button key="back" hotkey="b" plain onPress={actions.back}>
            ‹ back
          </Button>
          <Text dimColor>Loading PR #{selected}…</Text>
          {error ? <Text color="error" wrap="truncate-end">{error}</Text> : null}
        </Box>
      )
    }
    return renderList(table, { repo, snapshot, settled, error, isLoading, now, width, selected, progress }, actions)
  })
}
