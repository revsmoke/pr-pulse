import { expect, mock, test } from 'claude-code/testing'

import { aggregateStats, candidatePairs, formatStats, formatTrend, hasLineCounts, nearLinesChanged, outcomeOf, parseHunks, parseJudgement, patchFromRest, recordSql, similarity, touchesLine, weekStartOf, type PairRow, type SameRow, type StatRow } from '../hooks/db.ts'
import { coAuthorsOf, commentHasFindings, diffSnapshots, parseDetail, parseList, severityOf, statusLineOf, titleOf } from '../hooks/github.ts'
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
      if (/^SELECT sha, files, hunks FROM commits/m.test(stdin)) return ok('[]')
      if (/^SELECT p\.a, p\.b/m.test(stdin)) return ok('[]')
      if (/^SELECT t\.id, t\.number/m.test(stdin)) return ok(JSON.stringify(STAT_ROWS))
      if (/^SELECT p\.bot_a, p\.bot_b, p\.same/m.test(stdin)) return ok(JSON.stringify(PAIR_ROWS))
      if (/^SELECT p\.bot_a, p\.bot_b, ta\.opened_at/m.test(stdin)) return ok(JSON.stringify(SAME_ROWS))
      return ok('')
    }
    if (argv[0] !== 'gh') return fail('not found', 127)
    if (argv[1] === 'repo' && argv[2] === 'view') return ok('acme-labs/widget-forge\n')
    if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequests\(states: OPEN/.test(joined)) return ok(LIST_JSON)
    if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequests\(states: \[MERGED, CLOSED\]/.test(joined)) return ok(JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ number: 42, state: 'MERGED', updatedAt: '' }] } } } }))
    if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequest\(number: \$number\)/.test(joined)) return ok(DETAIL_JSON)
    if (argv[1] === 'api' && /^repos\/acme-labs\/widget-forge\/commits\//.test(argv[2] ?? '')) return ok(JSON.stringify(PATCH_REST))
    return fail(`unexpected gh call: ${joined.slice(0, 80)}`)
  })
  return { calls, sql }
}

const PATCH_REST = [
  { filename: 'forge/export.ts', patch: '@@ -80,12 +80,20 @@ export async function run()\n-old\n+new\n@@ -130,3 +138,9 @@\n-a\n+b' },
  { filename: 'forge/routes.ts', patch: '@@ -10,6 +10,8 @@\n-x\n+y' },
  { filename: 'assets/logo.png', patch: null },
]

const NEAR: (number | null)[] = [12, null, 0, 2, null, null, null]
const OPENED = ['2026-03-02T09:08:00Z', '2026-03-02T12:18:00Z', '2026-03-02T09:12:00Z', '2026-03-10T09:12:00Z', '2026-03-10T09:10:00Z', '2026-03-02T09:04:00Z', '2026-03-02T09:11:00Z']
const STAT_ROWS: StatRow[] = [
  { id: 't1', number: 42, bot: 'Codex', kind: 'thread', has_findings: 1, severity: 'P1', response_seconds: 300, outcome: 'used', is_outdated: 1, addressed_touched_line: 1, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 1 },
  { id: 't2', number: 42, bot: 'Codex', kind: 'thread', has_findings: 1, severity: 'P2', response_seconds: 420, outcome: 'open', is_outdated: 0, addressed_touched_line: null, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 0 },
  { id: 't3', number: 42, bot: 'CodeRabbit', kind: 'thread', has_findings: 1, severity: 'Minor', response_seconds: 700, outcome: 'dismissed', is_outdated: 0, addressed_touched_line: 0, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 1 },
  { id: 't4', number: 43, bot: 'CodeRabbit', kind: 'thread', has_findings: 1, severity: 'Minor', response_seconds: 500, outcome: 'used', is_outdated: 0, addressed_touched_line: 0, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 0 },
  { id: 't5', number: 43, bot: 'Cursor Bugbot', kind: 'thread', has_findings: 1, severity: 'High', response_seconds: null, outcome: 'resolved', is_outdated: 0, addressed_touched_line: null, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 0 },
  { id: 'c1', number: 42, bot: 'Claude Code', kind: 'comment', has_findings: 0, severity: null, response_seconds: 60, outcome: 'comment', is_outdated: 0, addressed_touched_line: null, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 0 },
  { id: 'c2', number: 42, bot: 'Claude Code', kind: 'comment', has_findings: 1, severity: null, response_seconds: 90, outcome: 'comment', is_outdated: 0, addressed_touched_line: null, near_lines_changed: NEAR.shift() ?? null, opened_at: OPENED.shift() ?? '2026-03-01T09:00:00Z', dup: 1 },
]
const PAIR_ROWS: PairRow[] = [
  { bot_a: 'Codex', bot_b: 'CodeRabbit', same: 1, basis: 'colocated', n: 1 },
  { bot_a: 'Claude Code', bot_b: 'Cursor Bugbot', same: 1, basis: 'similar', n: 1 },
  { bot_a: 'CodeRabbit', bot_b: 'Cursor Bugbot', same: null, basis: 'colocated', n: 2 },
]
const SAME_ROWS: SameRow[] = [
  { bot_a: 'Codex', bot_b: 'CodeRabbit', at_a: '2026-03-01T09:08:00Z', at_b: '2026-03-01T09:12:00Z' },
  { bot_a: 'Claude Code', bot_b: 'Cursor Bugbot', at_a: '2026-03-01T09:11:00Z', at_b: '2026-03-01T09:10:00Z' },
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
  const open = detail.threads.filter(t => t.kind === 'thread' && !t.isResolved)
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

  // Resolved, reply says fixed: used.
  expect(outcomeOf(byPath('forge/export.ts', 88), true, true)).toBe('used')
  // Resolved, no reply, file touched but not the line, diff not outdated: unknown.
  expect(outcomeOf({ ...byPath('forge/export.ts', 88), lastReplyBody: null, isOutdated: false }, true, false)).toBe('resolved')
  // Resolved, no reply, but the addressing hunk reaches the line: used.
  expect(outcomeOf({ ...byPath('forge/export.ts', 88), lastReplyBody: null, isOutdated: false }, true, true)).toBe('used')
  // Resolved with a refusing reply and nothing touched: dismissed.
  expect(outcomeOf({ ...byPath('forge/export.ts', 88), lastReplyBody: 'False positive, the guard runs upstream.', isOutdated: false }, false, false)).toBe('dismissed')
  // Still open; a PR-level comment is its own kind.
  expect(outcomeOf(byPath('forge/export.ts', 133), null)).toBe('open')
  const byId = (id: string) => detail.threads.find(t => t.id === id)!
  expect(byId('IC_1')).toMatchObject({ kind: 'comment', openedBy: 'coderabbitai', hasFindings: false })
  expect(byId('IC_2')).toMatchObject({ kind: 'comment', openedBy: 'claude', hasFindings: false })
  expect(byId('IC_3')).toMatchObject({ kind: 'comment', openedBy: 'claude', hasFindings: true })
  expect(detail.threads.some(t => t.id === 'IC_4')).toBe(false)
  expect(detail.threads.find(t => t.id === 'IC_3')?.responseSeconds).toBe(6 * 60)
  expect(commentHasFindings('## Code review\n\nNo issues found.')).toBe(false)
  expect(commentHasFindings('@codex review')).toBe(false)
  // Status tables, badges and "nothing found" rounds from the real bots are noise.
  expect(commentHasFindings('## Codex Review Summary\nThis comment shows the latest Codex review activity on this pull request.\n| Review | Status | Commit |\n| --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** | abc |')).toBe(false)
  expect(commentHasFindings("Codex Review: Didn't find any major issues. Another round soon, please! **Reviewed commit:** `d665`")).toBe(false)
  expect(commentHasFindings('<a href="https://app.coderabbit.ai/change-stack/x/y/pull/1?cs_source=review_comment"><picture><source srcset="https://storage.googleapis.com/a.png"></picture></a>')).toBe(false)
  expect(commentHasFindings('<details><summary>✅ Action performed</summary>Review finished. Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.</details>')).toBe(false)
  expect(commentHasFindings('> [!IMPORTANT]\n> ## Review skipped\n> Review was skipped due to path filters')).toBe(false)
  // A real PR-level review with content counts.
  expect(commentHasFindings("**Claude finished @user's task in 34s** —— [View job](https://github.com/x/y/actions/runs/1) --- ### Review of PR #218 I read `create.cfm` and the `Bluebeam.cfc` changes. One issue: the token refresh error is swallowed and the request fails silently.")).toBe(true)

  // Hunks: `@@ -a,b +c,d @@` headers, a missing patch, and the line check with slack.
  const patch = patchFromRest(JSON.stringify(PATCH_REST))!
  expect(patch.files).toEqual(['forge/export.ts', 'forge/routes.ts', 'assets/logo.png'])
  expect(patch.hunks['forge/export.ts']).toEqual([[80, 12, 80, 20, 1, 1], [130, 3, 138, 9, 1, 1]])
  expect(parseHunks('@@ -1 +1,2 @@\n-a\n+b\n+c\n--- not a removal\n+++ not an add')).toEqual([[1, 1, 1, 2, 2, 1]])
  expect(hasLineCounts(patch)).toBe(true)
  expect(hasLineCounts({ files: ['x'], hunks: { x: [[1, 1, 1, 1]] } })).toBe(false)
  // Lines moved near the finding: both export.ts hunks reach line 88? Only the first (80..92+3).
  expect(nearLinesChanged(patch, { path: 'forge/export.ts', line: 88, originalLine: 88 })).toBe(2)
  expect(nearLinesChanged(patch, { path: 'forge/export.ts', line: 120, originalLine: 120 })).toBe(0)
  expect(nearLinesChanged(patch, { path: 'forge/audit.ts', line: 9, originalLine: 9 })).toBe(0)
  expect(nearLinesChanged(patch, { path: 'assets/logo.png', line: 1, originalLine: 1 })).toBeNull()
  expect(nearLinesChanged({ files: ['x'], hunks: { x: [[1, 5, 1, 5]] } }, { path: 'x', line: 3, originalLine: 3 })).toBeNull()
  expect(nearLinesChanged(null, { path: 'x', line: 1, originalLine: 1 })).toBeNull()
  expect(weekStartOf('2026-03-04T10:00:00Z')).toBe('2026-03-02')
  expect(weekStartOf('2026-03-02T00:00:00Z')).toBe('2026-03-02')
  expect(weekStartOf('2026-03-08T23:59:00Z')).toBe('2026-03-02')
  expect(touchesLine(patch, { path: 'forge/export.ts', line: 88, originalLine: 88 })).toBe(true)
  expect(touchesLine(patch, { path: 'forge/export.ts', line: 120, originalLine: 120 })).toBe(false)
  expect(touchesLine(patch, { path: 'forge/export.ts', line: 133, originalLine: 133 })).toBe(true)
  expect(touchesLine(patch, { path: 'forge/audit.ts', line: 9, originalLine: 9 })).toBe(false)
  expect(touchesLine(patch, { path: 'assets/logo.png', line: 1, originalLine: 1 })).toBeNull()
  expect(touchesLine(null, { path: 'forge/export.ts', line: 88, originalLine: 88 })).toBeNull()
  // Response time: measured from the commit the comment is anchored on (09:05) to the comment (09:08).
  expect(byPath('forge/export.ts', 88).responseSeconds).toBe(3 * 60)
  expect(byPath('forge/export.ts', 133).triggerSha).toBe('c3d4e5f')

  // Codex 133 and CodeRabbit 61 are 72 lines apart: no pair. Codex 88 / CodeRabbit 120: no. Codex 88 / CodeRabbit 40 (48 apart): no.
  // Cursor 14 / Cursor 30 are the same bot: no pair. Codex 133 (export.ts) vs CodeRabbit 120 (export.ts): 13 apart: no.
  const wide = candidatePairs(detail.threads, 50)
  expect(wide.filter(c => c.basis === 'colocated').length).toBeGreaterThan(0)
  expect(wide.every(c => c.a.openedBy !== c.b.openedBy && c.a.id < c.b.id)).toBe(true)
  expect(wide.filter(c => c.basis === 'colocated').every(c => c.a.path === c.b.path)).toBe(true)
  // With the window closed, only wording-similar pairs remain: Cursor's auth-guard
  // thread and Claude Code's PR-level comment about the same guard.
  const narrow = candidatePairs(detail.threads, 8)
  expect(narrow.every(c => c.basis === 'similar')).toBe(true)
  expect(narrow.some(c => [c.a.id, c.b.id].includes('IC_3') && [c.a.openedBy, c.b.openedBy].includes('cursor'))).toBe(true)
  expect(narrow.some(c => [c.a.id, c.b.id].includes('IC_2'))).toBe(false)
  expect(similarity('Export route skips the auth guard middleware', 'the export route is registered before the guard middleware')).toBeGreaterThan(0.22)
  expect(similarity('Bound the batch size', 'Record who ran the export')).toBe(0)

  const files = new Map([['b2c3d4e', patch]])
  const statements = recordSql('acme-labs/widget-forge', detail, files, '2026-03-02T00:00:00Z')
  expect(statements.startsWith('BEGIN;')).toBe(true)
  expect(statements).toContain("INSERT INTO prs (")
  expect(statements).toContain("'Codex'")
  expect(statements).toContain("'used'")
  expect(statements).toContain("'open'")
  expect(statements).toMatch(/INSERT INTO commits .*'b2c3d4e'.*\["forge\/export\.ts","forge\/routes\.ts","assets\/logo\.png"\]/)
  expect(statements).toContain("'comment', 1, NULL, NULL, NULL)")
  // Codex 88 was addressed by b2c3d4e whose first hunk reaches it: 2 lines moved.
  expect(statements).toMatch(/'PRRT_1',[^\n]*'used',[^\n]*, 88, 1, 2\) ON CONFLICT/)
  // With the default 8-line window these fixtures yield one wording-similar pair.
  expect(statements).toContain("'similar')")
  expect(statements).not.toContain("'colocated')")
  expect(statements.endsWith('COMMIT;')).toBe(true)
  // Quotes in titles are doubled, never left to break the statement.
  expect(statements).toContain("export''s")

  expect(parseJudgement('YES. Both ask to bound the batch size.')).toEqual({ same: true, reason: 'Both ask to bound the batch size.' })
  expect(parseJudgement('**NO** - different files are meant.')).toEqual({ same: false, reason: 'different files are meant.' })
  expect(parseJudgement('Maybe')).toBeNull()
})

test('stats aggregation: per-bot rates, medians, uniqueness and overlap', () => {
  const report = aggregateStats(STAT_ROWS, PAIR_ROWS, SAME_ROWS, 'acme-labs/widget-forge', 30, 1_000)
  const codex = report.bots.find(b => b.bot === 'Codex')!
  expect(codex.findings).toBe(2)
  expect(codex.used).toBe(1)
  expect(codex.codeVerified).toBe(1)
  expect(codex.open).toBe(1)
  expect(codex.usedRate).toBe(1)
  expect(codex.medianResponseSeconds).toBe(360)
  expect(codex.duplicated).toBe(1)
  expect(codex.unique).toBe(1)
  expect(codex.firsts).toBe(1)
  expect(codex.repeats).toBe(0)
  const rabbit = report.bots.find(b => b.bot === 'CodeRabbit')!
  expect(rabbit.usedRate).toBe(0.5)
  expect(rabbit.codeVerified).toBe(0)
  expect(rabbit.prs).toBe(2)
  expect(rabbit.repeats).toBe(1)
  const cursor = report.bots.find(b => b.bot === 'Cursor Bugbot')!
  expect(cursor.usedRate).toBe(0)
  expect(cursor.medianResponseSeconds).toBeNull()
  expect(cursor.firsts).toBe(1)
  // PR-level comments: only the reporting one counts as a finding; no outcome math.
  const claude = report.bots.find(b => b.bot === 'Claude Code')!
  expect(claude.findings).toBe(1)
  expect(claude.comments).toBe(2)
  expect(claude.commentsWithFindings).toBe(1)
  expect(claude.usedRate).toBeNull()
  expect(claude.repeats).toBe(1)
  expect(claude.medianResponseSeconds).toBe(75)
  const pair = report.pairs.find(p => p.botA === 'Claude Code' && p.botB === 'Cursor Bugbot')!
  expect(pair.same).toBe(1)
  expect(pair.similar).toBe(1)
  expect(report.pairs.find(p => p.botA === 'CodeRabbit' && p.botB === 'Codex')?.colocated).toBe(1)
  expect(report.unjudgedPairs).toBe(2)
  expect(report.totalThreads).toBe(6)
  // Lines moved near used findings: Codex 12 (one known), CodeRabbit 2 of 2 known, none substantive for CodeRabbit.
  expect(codex.medianNearLines).toBe(12)
  expect(codex.substantive).toBe(1)
  expect(rabbit.medianNearLines).toBe(2)
  expect(rabbit.nearKnown).toBe(1)
  expect(rabbit.substantive).toBe(0)
  expect(cursor.medianNearLines).toBeNull()
  // Trend: two weeks, oldest first; the no-findings Claude comment is not counted.
  expect(report.trend.map(w => w.weekStart)).toEqual(['2026-03-02', '2026-03-09'])
  expect(report.trend[0]?.bots['Codex']).toEqual({ findings: 2, used: 1, repeats: 1, medianNearLines: 12 })
  expect(report.trend[0]?.bots['Claude Code']?.findings).toBe(1)
  expect(report.trend[1]?.bots['Cursor Bugbot']).toEqual({ findings: 1, used: 0, repeats: 0, medianNearLines: null })
  expect(report.trend[1]?.prs).toBe(1)
  expect(aggregateStats(STAT_ROWS, PAIR_ROWS, SAME_ROWS, null, null, 1, 1).trend.length).toBe(1)
  const trendText = formatTrend(report)
  expect(trendText).toContain('2026-03-02')
  expect(trendText).toMatch(/2 found 1 used 1 rep 12L/)
  const text = formatStats(report)
  expect(text).toContain('6 findings across 2 PRs')
  expect(text).toMatch(/Codex\s+2\s+2\s+0\/0\s+1\s+1\s+1\s+0\s+0\s+1\s+100%\s+6m\s+1\s+1\s+1\s+0\s+12\s+1\/1/)
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

  const trend = await $.command.run({ command: 'prs', args: 'trend 4' })
  expect(trend.text).toContain('Weekly trend on acme-labs/widget-forge')
  expect(trend.text).toContain('2026-03-02')

  const ui = await $.ui.mount({ plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', requestId: 'pr-pulse', props: PANE_PROPS })
  expect(await ui.find({ text: /review bots/ })).toBeDefined()
  expect(await ui.find({ text: /trend by week/ })).toBeDefined()
  expect(await ui.find({ text: /03-09/ })).toBeDefined()
  expect(await ui.find({ text: /Codex/ })).toBeDefined()
  expect(await ui.find({ text: /CodeRabbit × Cursor Bugbot/ })).toBeDefined()
  expect(await ui.find({ text: /Claude Code × Cursor Bugbot/ })).toBeDefined()
  expect(await ui.find({ text: /PR-level comments, 1 reporting something/ })).toBeDefined()
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
