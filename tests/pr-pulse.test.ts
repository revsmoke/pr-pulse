import { expect, mock, test } from 'claude-code/testing'

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
}

// Answers every `gh` call the mod makes from the fixtures, so no process runs.
function answerGh(on: TestOn) {
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const joined = argv.join(' ')
    let stdout = ''
    if (argv[0] !== 'gh') return { value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[1] === 'repo' && argv[2] === 'view') stdout = 'acme-labs/widget-forge\n'
    else if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequests\(states: OPEN/.test(joined)) stdout = LIST_JSON
    else if (argv[1] === 'api' && argv[2] === 'graphql' && /pullRequest\(number: \$number\)/.test(joined)) stdout = DETAIL_JSON
    else return { value: { exitCode: 1, stdout: '', stderr: `unexpected gh call: ${joined.slice(0, 80)}`, isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return calls
}

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

test('/prs refresh fetches through gh and the pane lists the PR, its bots and agents', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  answerUi(on)
  const calls = answerGh(on)

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
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'none of the git remotes configured for this repository point to a known GitHub host', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.command.run({ command: 'prs', args: '' })
  const ui = await $.ui.mount({ plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', requestId: 'pr-pulse', props: PANE_PROPS })
  expect(await ui.find({ text: /no GitHub repo detected/ })).toBeDefined()
  await ui.unmount()
})
