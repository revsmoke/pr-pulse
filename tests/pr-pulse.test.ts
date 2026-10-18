import { expect, mock, test } from 'claude-code/testing'

import { aggregateStats, candidatePairs, formatStats, outcomeOf, parseJudgement, recordSql, type PairRow, type StatRow } from '../hooks/db.ts'
import { coAuthorsOf, diffSnapshots, parseDetail, parseList, severityOf, statusLineOf, titleOf } from '../hooks/github.ts'
import { DETAIL_JSON, LIST_JSON } from './fixtures.ts'

const PANE_PROPS = {
  title: 'PRs',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type TestOn = Parameters<Parameters<typeof test>[1]>[1]

// The surface beneath the plugin: a pane that places, nothing else to draw.
function answerUi(on: TestOn) {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  mock.env(on, { HOME: '/home/test' })
}

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr: string, exitCode = 1) => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// Answers every `gh`, `sqlite3` and `mkdir` call the mod makes from the
// fixtures, so no process runs; the SQL the mod sends is kept for assertions.
function answerProcesses(on: TestOn) {
  const calls: string[][] = []
  const sql: string[] = []
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const joined = argv.join(' ')
    if (argv[0] === 'mkdir') return ok('')
    if (argv[0] === 'sqlite3') {
      const stdin = e.init?.stdin ?? ''
      sql.push(stdin)
      if (/^SELECT sha, files FROM commits/m.test(stdin)) return ok('[]')
      if (/^SELECT p\.a, p\.b/m.test(stdin)) return ok('[]')
      if (/^SELECT t\.id, t\.number/m.test(stdin)) return ok(JSON.stringify(STAT_ROWS))
      if (/^SELECT p\.bot_a/m.test(stdin)) return ok(JSON.stringify(PAIR_ROWS))
      return ok('')
    }
    if (argv[0] !== 'gh') return fail('not found', 127)
    if (argv[1] === 'repo' && argv[2] === 'view') return ok('acme-labs/widget-forge\n')
    if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequests\(states: OPEN/.test(joined)) return ok(LIST_JSON)
    if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequests\(states: \[MERGED, CLOSED\]/.test(joined)) return ok(JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ number: 42, state: 'MERGED', updatedAt: '' }] } } } }))
    if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequest\(number: \$number\)/.test(joined)) return ok(DETAIL_JSON)
    if (argv[1] === 'api' && /^repos\/acme-labs\/widget-forge\/commits\//.test(argv[2] ?? '')) return ok(JSON.stringify(['forge/export.ts', 'forge/routes.ts']))
    return fail(`unexpected gh call: ${joined.slice(0, 80)}`)
  })
  return { calls, sql }
}

const STAT_ROWS: StatRow[] = [
  { id: 't1', number: 42, bot: 'Codex', severity: 'P1', response_seconds: 300, outcome: 'used', dup: 1 },
  { id: 't2', number: 42, bot: 'Codex', severity: 'P2', response_seconds: 420, outcome: 'open', dup: 0 },
  { id: 't3', number: 42, bot: 'CodeRabbit', severity: 'Minor', response_seconds: 700, outcome: 'dismissed', dup: 1 },
  { id: 't4', number: 43, bot: 'CodeRabbit', severity: 'Minor', response_seconds: 500, outcome: 'used', dup: 0 },
  { id: 't5', number: 43, bot: 'Cursor Bugbot', severity: 'High', response_seconds: null, outcome: 'resolved', dup: 0 },
]
const PAIR_ROWS: PairRow[] = [
  { bot_a: 'Codex', bot_b: 'CodeRabbit', same: 1, n: 1 },
  { bot_a: 'CodeRabbit', bot_b: 'Cursor Bugbot', same: null, n: 2 },
]

test('parsers read the live shapes: rules, checks, bots, agents, severities', () => {
  const snap = parseList(LIST_JSON, 1_000_000)
  expect(snap.repo).toBe('acme-labs/widget-forge')
  expect(snap.totalCount).toBe(1)
  expect(snap.rules?.requiredChecks).toEqual(['gitleaks', 'unit tests'])
  expect(snap.rules?.requiredApprovals).toBe(1)
  expect(snap.rules?.requiresThreadResolution).toBe(true)
  expect(snap.rules?.noForcePush).toBe(true)
  const pr = snap.prs[0]!
  expect(pr.number).toBe(42)
  expect(pr.checks.find(c => c.name === 'gitleaks')?.isRequired).toBe(true)
  expect(pr.checks.find(c => c.name === 'Cursor Bugbot Autofix')?.state).toBe('pending')
  expect(pr.reviewers.filter(r => r.isBot).map(r => r.name).sort()).toEqual(['CodeRabbit', 'Codex', 'Cursor Bugbot'])
  expect(pr.agents).toContain('Claude Fable 5.1')
  expect(statusLineOf(snap)).toMatch(/^PRs 1 open · #42 /)

  const detail = parseDetail(DETAIL_JSON, 1_000_000, snap.rules)
  expect(detail.agents).toContain('Claude Code')
  expect(detail.commits[0]?.coAuthors).toEqual(['Claude Fable 5.1'])
  expect(detail.commits[0]?.sessionUrl).toMatch(/^https:\/\/claude\.ai\//)
  expect(detail.threads.filter(t => t.isResolved).length).toBe(5)
  expect(detail.commits.find(c => c.sha === 'b2c3d4e')?.threadsAddressed).toBe(5)
  const open = detail.threads.filter(t => !t.isResolved)
  expect(open.length).toBeGreaterThan(0)
  expect(open.every(t => t.severity !== null)).toBe(true)
  expect(detail.commits.reduce((n, c) => n + c.threadsAddressed, 0)).toBeGreaterThan(0)
})

test('severity and title heuristics cover Codex, CodeRabbit and Cursor comment styles', () => {
  expect(severityOf('**<sub>![P1 Badge](https://x)</sub> Bound the timeout**')).toBe('P1')
  expect(severityOf('**🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**\n\n**Include answered**')).toBe('Minor')
  expect(severityOf('### Raise uniqueness\n\n**High Severity**\n\nbody')).toBe('High')
  expect(titleOf('**🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**\n\n**Include `answered` in the filter.**')).toBe('Include `answered` in the filter.')
  expect(titleOf('### Project admins cannot raise issues\n\n**Medium Severity**')).toBe('Project admins cannot raise issues')
  expect(coAuthorsOf('Fix\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/x')).toEqual(['Claude Fable 5.1'])
})

test('diffSnapshots names a failed check, new threads and a new approval', () => {
  const before = parseList(LIST_JSON, 1)
  const after = parseList(LIST_JSON, 2)
  const pr = after.prs[0]!
  pr.checks = pr.checks.map((c, i) => (i === 0 ? { ...c, state: 'failure' } : c))
  pr.threadsTotal += 3
  pr.reviewers = [{ login: 'alice', name: 'alice', isBot: false, state: 'APPROVED', at: '2026-10-18T18:00:00Z' }]
  const kinds = diffSnapshots(before, after).map(c => c.kind)
  expect(kinds).toContain('check-failed')
  expect(kinds).toContain('threads')
  expect(kinds).toContain('review')
  expect(diffSnapshots(null, after)).toEqual([])
})

test('ledger rules: outcomes, candidate pairs, SQL and judgement parsing', () => {
  const snap = parseList(LIST_JSON, 1)
  const detail = parseDetail(DETAIL_JSON, 1, snap.rules)
  const byPath = (p: string, line: number) => detail.threads.find(t => t.path === p && t.line === line)!

  // Resolved, reply says fixed, commit touched the file: used.
  expect(outcomeOf(byPath('forge/export.ts', 88), true)).toBe('used')
  // Resolved with no reply and no file evidence: unknown.
  expect(outcomeOf({ ...byPath('forge/export.ts', 88), lastReplyBody: null, isOutdated: false }, null)).toBe('resolved')
  // Resolved with a refusing reply and nothing touched: dismissed.
  expect(outcomeOf({ ...byPath('forge/export.ts', 88), lastReplyBody: 'False positive, the guard runs upstream.', isOutdated: false }, false)).toBe('dismissed')
  // Still open.
  expect(outcomeOf(byPath('forge/export.ts', 133), null)).toBe('open')
  // Response time: measured from the commit the comment is anchored on (09:05) to the comment (09:08).
  expect(byPath('forge/export.ts', 88).responseSeconds).toBe(3 * 60)
  expect(byPath('forge/export.ts', 133).triggerSha).toBe('c3d4e5f')

  // Codex 133 and CodeRabbit 61 are 72 lines apart: no pair. Codex 88 / CodeRabbit 120: no. Codex 88 / CodeRabbit 40 (48 apart): no.
  // Cursor 14 / Cursor 30 are the same bot: no pair. Codex 133 (export.ts) vs CodeRabbit 120 (export.ts): 13 apart: no.
  const pairs = candidatePairs(detail.threads, 50)
  expect(pairs.length).toBeGreaterThan(0)
  expect(pairs.every(([a, b]) => a.path === b.path && a.openedBy !== b.openedBy && a.id < b.id)).toBe(true)
  expect(candidatePairs(detail.threads, 8).length).toBe(0)

  const files = new Map<string, string[] | null>([['b2c3d4e', ['forge/export.ts', 'forge/routes.ts']]])
  const statements = recordSql('acme-labs/widget-forge', detail, files, '2026-03-02T00:00:00Z')
  expect(statements.startsWith('BEGIN;')).toBe(true)
  expect(statements).toContain("INSERT INTO prs (")
  expect(statements).toContain("'Codex'")
  expect(statements).toContain("'used'")
  expect(statements).toContain("'open'")
  expect(statements).toMatch(/INSERT INTO commits .*'b2c3d4e'.*\["forge\/export\.ts","forge\/routes\.ts"\]/)
  expect(statements.endsWith('COMMIT;')).toBe(true)
  // Quotes in titles are doubled, never left to break the statement.
  expect(statements).toContain("export''s")

  expect(parseJudgement('YES. Both ask to bound the batch size.')).toEqual({ same: true, reason: 'Both ask to bound the batch size.' })
  expect(parseJudgement('**NO** - different files are meant.')).toEqual({ same: false, reason: 'different files are meant.' })
  expect(parseJudgement('Maybe')).toBeNull()
})

test('stats aggregation: per-bot rates, medians, uniqueness and overlap', () => {
  const report = aggregateStats(STAT_ROWS, PAIR_ROWS, 'acme-labs/widget-forge', 30, 1_000)
  const codex = report.bots.find(b => b.bot === 'Codex')!
  expect(codex.findings).toBe(2)
  expect(codex.used).toBe(1)
  expect(codex.open).toBe(1)
  expect(codex.usedRate).toBe(1)
  expect(codex.medianResponseSeconds).toBe(360)
  expect(codex.duplicated).toBe(1)
  expect(codex.unique).toBe(1)
  const rabbit = report.bots.find(b => b.bot === 'CodeRabbit')!
  expect(rabbit.usedRate).toBe(0.5)
  expect(rabbit.prs).toBe(2)
  const cursor = report.bots.find(b => b.bot === 'Cursor Bugbot')!
  expect(cursor.usedRate).toBe(0)
  expect(cursor.medianResponseSeconds).toBeNull()
  expect(report.pairs.find(p => p.botA === 'CodeRabbit' && p.botB === 'Codex')?.same).toBe(1)
  expect(report.unjudgedPairs).toBe(2)
  const text = formatStats(report)
  expect(text).toContain('5 findings across 2 PRs')
  expect(text).toMatch(/Codex\s+2\s+1\s+1\s+0\s+0\s+1\s+100%/)
  expect(text).toContain('/prs judge')
})

test('drilling into a PR writes it to the ledger, and backfill sweeps settled PRs', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  answerUi(on)
  const { calls, sql } = answerProcesses(on)
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'YES. Same batch-size concern.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))

  await $.command.run({ command: 'prs', args: 'refresh' })
  await $.command.run({ command: 'prs', args: '42' })
  await clock.advance(1_000)
  const inserts = sql.filter(s => s.includes('INSERT INTO threads'))
  expect(inserts.length).toBeGreaterThan(0)
  expect(inserts[0]).toContain("'Codex'")
  expect(inserts[0]).toContain("'Cursor Bugbot'")
  expect(inserts[0]).toMatch(/'acme-labs\/widget-forge', 42/)
  // The schema was created first, in its own sqlite3 run.
  expect(sql[0]).toContain('CREATE TABLE IF NOT EXISTS threads')
  // The addressing commit's files were asked for over REST.
  expect(calls.some(c => c[0] === 'gh' && c[1] === 'api' && /commits\/b2c3d4e$/.test(c[2] ?? ''))).toBe(true)

  const db = await $.command.run({ command: 'prs', args: 'db' })
  expect(db.text).toContain('/home/test/.claude/pr-pulse/reviews.db')

  const started = await $.command.run({ command: 'prs', args: 'backfill 5' })
  expect(started.text).toMatch(/^Backfilling the last 5/)
  await clock.advance(5_000)
  expect(calls.some(c => c.join(' ').includes('states: [MERGED, CLOSED]'))).toBe(true)
  expect(calls.some(c => c.join(' ').includes('count=5'))).toBe(true)

  const stats = await $.command.run({ command: 'prs', args: 'stats 30' })
  expect(stats.text).toContain('Review bots on acme-labs/widget-forge, last 30 days')
  expect(stats.text).toContain('Codex')
  expect(sql.some(s => /opened_at >= '/.test(s))).toBe(true)

  const ui = await $.ui.mount({ plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', requestId: 'pr-pulse', props: PANE_PROPS })
  expect(await ui.find({ text: /review bots/ })).toBeDefined()
  expect(await ui.find({ text: /Codex/ })).toBeDefined()
  expect(await ui.find({ text: /CodeRabbit × Cursor Bugbot/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'open-42' })).toBeDefined()
  await ui.unmount()
})

test('/prs refresh fetches through gh and the pane lists the PR, its bots and agents', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  answerUi(on)
  const { calls } = answerProcesses(on)

  const answer = await $.command.run({ command: 'prs', args: 'refresh' })
  expect(answer.text).toBe('PR status refreshed.')
  expect(calls.some(c => c[1] === 'repo' && c[2] === 'view')).toBe(true)
  expect(calls.some(c => c[1] === 'api' && c[2] === 'graphql')).toBe(true)

  const ui = await $.ui.mount({ plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', requestId: 'pr-pulse', props: PANE_PROPS })
  expect(await ui.find({ text: /acme-labs\/widget-forge/ })).toBeDefined()
  expect(await ui.find({ key: 'open-42' })).toBeDefined()
  expect(await ui.find({ text: /5\/8 resolved/ })).toBeDefined()
  expect(await ui.find({ text: /CodeRabbit/ })).toBeDefined()
  expect(await ui.find({ text: /Claude Fable 5\.1/ })).toBeDefined()
  expect(await ui.find({ text: /required checks: gitleaks, unit tests/ })).toBeDefined()

  // Drill in: the row's button selects the PR and the detail view draws threads and commits.
  await ui.press({ key: 'open-42' })
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ text: /Bound the export's total runtime/ })).toBeDefined()
  expect(await ui.find({ text: /✓ check gitleaks success/ })).toBeDefined()
  expect(await ui.find({ text: /3 threads still open/ })).toBeDefined()
  expect(await ui.find({ text: /addresses \d+/ })).toBeDefined()
  expect(await ui.find({ text: /agents on this PR/ })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'open-42' })).toBeDefined()
  await ui.unmount()
})

test('/prs with no repo detected explains itself instead of failing', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  answerUi(on)
  on('process.run', () => fail('none of the git remotes configured for this repository point to a known GitHub host'))
  await $.command.run({ command: 'prs', args: '' })
  const ui = await $.ui.mount({ plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', requestId: 'pr-pulse', props: PANE_PROPS })
  expect(await ui.find({ text: /no GitHub repo detected/ })).toBeDefined()
  await ui.unmount()
})
