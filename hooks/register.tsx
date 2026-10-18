// pr-pulse: a pane that follows a repo's open pull requests in near real time.
// Checks, review bots, enforced branch rules, review threads and the commits
// that address them, and the agents working on each PR. Data comes from the
// gh CLI (GraphQL); state lives in $.state so a hot reload keeps it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PrDetail, SettledPr, Snapshot } from '../types'
import { DETAIL_QUERY, LIST_QUERY, TRIM_BODIES, diffSnapshots, parseDetail, parseList, statusLineOf } from './github.ts'
import { renderDetail, renderList } from './view.tsx'

const PANE = 'pr-pulse'
const PLUGIN = 'pr-pulse'

const repoAtom = atom({ plugin: 'pr-pulse', key: 'repo' } as const, null)
const snapshotAtom = atom({ plugin: 'pr-pulse', key: 'snapshot' } as const, null)
const detailAtom = atom({ plugin: 'pr-pulse', key: 'detail' } as const, null)
const selectedAtom = atom({ plugin: 'pr-pulse', key: 'selected' } as const, null)
const errorAtom = atom({ plugin: 'pr-pulse', key: 'error' } as const, null)
const loadingAtom = atom({ plugin: 'pr-pulse', key: 'isLoading' } as const, false)
const settledAtom = atom({ plugin: 'pr-pulse', key: 'settled' } as const, [])

type Settings = { pollMs: number; autoOpen: boolean; statusLine: boolean; toasts: boolean }

let settings: Settings = { pollMs: 45_000, autoOpen: true, statusLine: true, toasts: true }
let sessionCwd: string | undefined
let isFetching = false
let hasOfferedPane = false
let isPolling = false

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
  $.ui.status(settings.statusLine ? statusLineOf(snapshot) : undefined)

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

async function refreshDetail($: EngineInterface, number: number): Promise<void> {
  const repo = await read($, repoAtom)
  if (!repo) return
  const { owner, name } = splitRepo(repo)
  const ran = await gh($, [
    'api', 'graphql',
    '-f', `query=${DETAIL_QUERY}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`,
    '--jq', TRIM_BODIES,
  ])
  if (!ran.ok) {
    await update($, errorAtom, () => `GitHub: ${shortError(ran.err || ran.out)}`)
    return
  }
  const snapshot = await read($, snapshotAtom)
  try {
    const detail: PrDetail = parseDetail(ran.out, await $.clock.now(), snapshot?.rules ?? null)
    const stillSelected = (await read($, selectedAtom)) === number
    if (stillSelected) await update($, detailAtom, () => detail)
    await update($, errorAtom, () => null)
  } catch (error) {
    await update($, errorAtom, () => `GitHub: ${error instanceof Error ? error.message : String(error)}`)
  }
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

function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const seconds = Number(options['pollSeconds'] ?? 45)
  return {
    pollMs: Math.max(15, Number.isFinite(seconds) ? seconds : 45) * 1000,
    autoOpen: options['autoOpen'] !== false,
    statusLine: options['statusLine'] !== false,
    toasts: options['toasts'] !== false,
  }
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.command.register({
      name: 'prs',
      description: 'Open the pull request pane; /prs N drills into PR N, /prs repo owner/name watches another repo',
      argumentHint: '[N | back | refresh | close | repo owner/name]',
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
    if (/^(back|list)$/i.test(args)) {
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
    const number = /^#?(\d+)$/.exec(args)
    if (number && number[1]) {
      const n = Number(number[1])
      await $.ui.open({ id: PANE, title: 'PRs', focus: true })
      void selectPr($, n)
      return { text: `Showing PR #${n}.` }
    }
    if (args.length > 0) {
      return { text: 'Usage: /prs · /prs N · /prs back · /prs refresh · /prs close · /prs repo owner/name' }
    }
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
    const [repo, snapshot, detail, selected, error, isLoading, settled] = await Promise.all([
      read($, repoAtom),
      read($, snapshotAtom),
      read($, detailAtom),
      read($, selectedAtom),
      read($, errorAtom),
      read($, loadingAtom),
      read($, settledAtom),
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
    return renderList(table, { repo, snapshot, settled, error, isLoading, now, width, selected }, actions)
  })
}
