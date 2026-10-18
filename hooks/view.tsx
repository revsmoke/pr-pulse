// Pure drawing: turns the mod's state into element trees. No `$` here; the
// element table and the press handlers come in from register.tsx.

import type { Elements } from 'claude-code'

import type { BackfillProgress, Check, PrDetail, PrSummary, RuleSummary, SettledPr, Snapshot, StatsReport, Thread } from '../types'
import { fmtSeconds, pct } from './db.ts'
import { ago, bar, checkTotals, displayName, glyph, mergeStateWords, reviewWords, truncate } from './github.ts'

export type Table = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

export type Actions = {
  select: (number: number) => void
  back: () => void
  refresh: () => void
  stats: () => void
  judge: () => void
}

export type ListData = {
  repo: string | null
  snapshot: Snapshot | null
  settled: SettledPr[]
  error: string | null
  isLoading: boolean
  now: number
  width: number
  selected: number | null
  progress: BackfillProgress | null
}

export type StatsData = {
  repo: string | null
  stats: StatsReport | null
  progress: BackfillProgress | null
  error: string | null
  now: number
  width: number
}

export type DetailData = {
  detail: PrDetail
  rules: RuleSummary | null
  error: string | null
  isLoading: boolean
  now: number
  width: number
}

const TONE = { success: 'success', failure: 'error', pending: 'warning', neutral: 'subtle', skipped: 'subtle', unknown: 'subtle' } as const

function checkGroups(checks: Check[]): { label: string; items: Check[] }[] {
  const groups = new Map<string, Check[]>()
  for (const c of checks) {
    const label = c.app && c.app !== 'GitHub Actions' ? c.app : c.workflow ?? c.app ?? 'status'
    const list = groups.get(label) ?? []
    list.push(c)
    groups.set(label, list)
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }))
}

export function renderList(t: Table, d: ListData, a: Actions) {
  const { Box, Text, Button } = t
  const W = Math.max(20, d.width)
  const snap = d.snapshot

  const header = (
    <Box key="head" flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text weight="bold">{d.repo ?? 'no GitHub repo detected'}</Text>
        {snap ? <Text dimColor> · {snap.totalCount} open PR{snap.totalCount === 1 ? '' : 's'} · {ago(snap.fetchedAt, d.now)} ago</Text> : null}
        {d.isLoading ? <Text color="warning"> ⟳</Text> : null}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="stats" hotkey="s" plain onPress={a.stats}>
          stats
        </Button>
        <Button key="refresh" hotkey="r" plain onPress={a.refresh}>
          refresh
        </Button>
      </Box>
    </Box>
  )

  if (!d.repo) {
    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor wrap="wrap">
          Run Claude Code inside a repo with a GitHub remote, or type /prs repo owner/name.
        </Text>
        {d.error ? <Text color="error" wrap="wrap">{d.error}</Text> : null}
      </Box>
    )
  }

  const rows = (snap?.prs ?? []).map((pr, i) => renderPrRow(t, pr, i, snap?.rules ?? null, d.now, W, a))

  return (
    <Box flexDirection="column">
      {header}
      {d.error ? <Text color="error" wrap="truncate-end">{d.error}</Text> : null}
      {!snap && !d.error ? <Text dimColor>Asking GitHub…</Text> : null}
      {snap && snap.prs.length === 0 ? <Text dimColor>No open pull requests.</Text> : null}
      {rows}
      {snap?.rules ? renderRules(t, snap.rules, W) : null}
      {d.settled.length > 0 ? renderSettled(t, d.settled, d.now, W) : null}
      {d.progress?.running ? <Text color="warning" wrap="truncate-end">backfill: {d.progress.message}</Text> : null}
      <Text dimColor wrap="truncate-end">
        digits drill in · s stats · /prs N · /prs refresh · /prs backfill 30 · /prs repo owner/name
      </Text>
    </Box>
  )
}

function renderPrRow(t: Table, pr: PrSummary, i: number, rules: RuleSummary | null, now: number, W: number, a: Actions) {
  const { Box, Text, Button } = t
  const totals = checkTotals(pr.checks)
  const merge = mergeStateWords(pr)
  const open = pr.threadsTotal - pr.threadsResolved
  const bots = pr.reviewers.filter(r => r.isBot)
  const humans = pr.reviewers.filter(r => !r.isBot)
  const hotkey = i < 9 ? String(i + 1) : undefined
  const barWidth = Math.max(6, Math.min(16, Math.floor(W / 6)))

  return (
    <Box key={`pr-${pr.number}`} flexDirection="column" marginTop={1}>
      <Button key={`open-${pr.number}`} hotkey={hotkey} plain onPress={() => a.select(pr.number)}>
        #{pr.number} {truncate(pr.title, W - 14)}
      </Button>
      <Text dimColor wrap="truncate-end">
        {'  '}
        {pr.headRef} → {pr.baseRef} · {pr.authorIsBot ? displayName(pr.author) : pr.author} · opened {ago(pr.createdAt, now)} ago · pushed {ago(pr.headAt, now)} ago · {pr.commitCount} commit{pr.commitCount === 1 ? '' : 's'}
      </Text>
      <Text wrap="truncate-end">
        {'  '}
        <Text color={merge.tone}>● {merge.text}</Text>
        <Text dimColor> · {reviewWords(pr, rules)}</Text>
        {pr.autoMerge ? <Text dimColor> · auto-merge on</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        {'  checks '}
        <Text color="success">✓{totals.success}</Text>{' '}
        <Text color={totals.failure ? 'error' : 'subtle'}>✗{totals.failure}</Text>{' '}
        <Text color={totals.pending ? 'warning' : 'subtle'}>⟳{totals.pending}</Text>
        {totals.skipped + totals.neutral ? <Text dimColor> –{totals.skipped + totals.neutral}</Text> : null}
        {pr.threadsTotal > 0 ? (
          <Text>
            {'   threads '}
            <Text color={open === 0 ? 'success' : 'warning'}>{bar(pr.threadsResolved, pr.threadsTotal, barWidth)}</Text>
            {' '}{pr.threadsResolved}/{pr.threadsTotal} resolved
            {open > 0 ? <Text color="warning"> · {open} open</Text> : null}
          </Text>
        ) : (
          <Text dimColor>   no review threads</Text>
        )}
      </Text>
      {bots.length + humans.length + pr.requested.length > 0 ? (
        <Text wrap="truncate-end">
          {'  reviews '}
          {[...humans, ...bots].map((r, k) => (
            <Text key={`rv-${k}`}>
              {k > 0 ? <Text dimColor> · </Text> : null}
              <Text color={r.state === 'APPROVED' ? 'success' : r.state === 'CHANGES_REQUESTED' ? 'error' : undefined}>
                {r.isBot ? '🤖 ' : ''}{r.name} {reviewGlyph(r.state)}
              </Text>
            </Text>
          ))}
          {pr.requested.length ? <Text dimColor> · awaiting {pr.requested.join(', ')}</Text> : null}
        </Text>
      ) : null}
      {pr.agents.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          {'  agents  '}{pr.agents.join(' · ')}
        </Text>
      ) : null}
    </Box>
  )
}

function reviewGlyph(state: string): string {
  switch (state) {
    case 'APPROVED':
      return '✓'
    case 'CHANGES_REQUESTED':
      return '✗'
    case 'COMMENTED':
      return '💬'
    case 'PENDING':
      return '…'
    case 'DISMISSED':
      return '⊘'
    default:
      return ''
  }
}

function renderRules(t: Table, rules: RuleSummary, W: number) {
  const { Text } = t
  const parts: string[] = []
  if (rules.requiredChecks.length) parts.push(`required checks: ${rules.requiredChecks.join(', ')}`)
  parts.push(rules.requiredApprovals > 0 ? `${rules.requiredApprovals} approval${rules.requiredApprovals === 1 ? '' : 's'} required` : 'no approvals required')
  if (rules.requiresThreadResolution) parts.push('threads must be resolved')
  if (rules.requiresCodeOwners) parts.push('code owner review')
  if (rules.noForcePush) parts.push('no force-push')
  return (
    <Text dimColor wrap="truncate-end">
      {'\n'}rules on base: {truncate(parts.join(' · '), W - 16)}
    </Text>
  )
}

function renderSettled(t: Table, settled: SettledPr[], now: number, W: number) {
  const { Box, Text } = t
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>recently settled</Text>
      {settled.slice(0, 5).map(s => (
        <Text key={`settled-${s.number}`} wrap="truncate-end">
          {'  '}
          <Text color={s.state === 'MERGED' ? 'merged' : 'subtle'}>{s.state === 'MERGED' ? '⇄ merged' : '✕ closed'}</Text>
          {' #'}{s.number} {truncate(s.title, Math.max(10, W - 50))}
          <Text dimColor>
            {s.at ? ` ${ago(s.at, now)} ago` : ''}{s.by ? ` by ${s.by}` : ''} ·{' '}
            {s.branchDeleted === true ? 'branch deleted' : s.branchDeleted === false ? `branch ${s.headRef} still exists` : 'branch ?'}
          </Text>
        </Text>
      ))}
    </Box>
  )
}

export function renderDetail(t: Table, d: DetailData, a: Actions) {
  const { Box, Text, Button, Link } = t
  const pr = d.detail
  const W = Math.max(20, d.width)
  const merge = mergeStateWords(pr)
  const totals = checkTotals(pr.checks)
  const open = pr.threads.filter(x => !x.isResolved)
  const resolved = pr.threads.filter(x => x.isResolved)
  const barWidth = Math.max(8, Math.min(24, Math.floor(W / 4)))

  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Button key="back" hotkey="b" plain onPress={a.back}>
            ‹ back
          </Button>
          <Text wrap="truncate-end">
            {'  '}
            <Text weight="bold">#{pr.number}</Text> {truncate(pr.title, W - 30)}
          </Text>
        </Box>
        <Button key="refresh" hotkey="r" plain onPress={a.refresh}>
          refresh
        </Button>
      </Box>
      <Text dimColor wrap="truncate-end">
        {pr.headRef} → {pr.baseRef} · {pr.author} · +{pr.additions} −{pr.deletions} · {pr.changedFiles} files · {pr.commitCount} commits · head {pr.headSha} {ago(pr.headAt, d.now)} ago
        {d.isLoading ? <Text color="warning"> ⟳</Text> : <Text> · {ago(pr.fetchedAt, d.now)} ago</Text>}
      </Text>
      <Link href={pr.url} label={pr.url} />
      {d.error ? <Text color="error" wrap="truncate-end">{d.error}</Text> : null}

      <Text wrap="truncate-end">
        {'\n'}
        <Text weight="bold">merge </Text>
        <Text color={merge.tone}>● {merge.text}</Text>
        <Text dimColor> · {pr.mergeable.toLowerCase()} · {reviewWords(pr, d.rules)}{pr.autoMerge ? ' · auto-merge on' : ''}</Text>
      </Text>
      {d.rules ? renderRuleChecklist(t, pr, d.rules) : <Text dimColor>  no branch rules on {pr.baseRef}</Text>}

      <Text wrap="truncate-end">
        {'\n'}
        <Text weight="bold">checks </Text>
        <Text color="success">✓{totals.success}</Text>{' '}
        <Text color={totals.failure ? 'error' : 'subtle'}>✗{totals.failure}</Text>{' '}
        <Text color={totals.pending ? 'warning' : 'subtle'}>⟳{totals.pending}</Text>{' '}
        <Text dimColor>–{totals.skipped + totals.neutral}</Text>
      </Text>
      {checkGroups(pr.checks).map(g => (
        <Text key={`cg-${g.label}`} wrap="truncate-end">
          {'  '}
          <Text dimColor>{truncate(g.label, 22)}: </Text>
          {g.items.map((c, k) => (
            <Text key={`c-${k}`}>
              {k > 0 ? <Text dimColor> · </Text> : null}
              <Text color={TONE[c.state]}>{glyph(c.state)} {c.name}</Text>
              {c.isRequired ? <Text dimColor> (required)</Text> : null}
            </Text>
          ))}
        </Text>
      ))}

      <Text wrap="truncate-end">
        {'\n'}
        <Text weight="bold">reviewers </Text>
        {pr.reviewers.length === 0 ? <Text dimColor>none yet</Text> : null}
        {pr.reviewers.map((r, k) => (
          <Text key={`r-${k}`}>
            {k > 0 ? <Text dimColor> · </Text> : null}
            <Text color={r.state === 'APPROVED' ? 'success' : r.state === 'CHANGES_REQUESTED' ? 'error' : undefined}>
              {r.isBot ? '🤖 ' : ''}{r.name} {reviewGlyph(r.state)}
            </Text>
            <Text dimColor> {ago(r.at, d.now)}</Text>
          </Text>
        ))}
        {pr.requested.length ? <Text dimColor> · awaiting {pr.requested.join(', ')}</Text> : null}
      </Text>

      <Text wrap="truncate-end">
        {'\n'}
        <Text weight="bold">threads </Text>
        {pr.threadsTotal === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          <Text>
            <Text color={open.length === 0 ? 'success' : 'warning'}>{bar(pr.threadsResolved, pr.threadsTotal, barWidth)}</Text>
            {' '}{pr.threadsResolved}/{pr.threadsTotal} resolved
            {open.length ? <Text color="warning"> · {open.length} open</Text> : <Text color="success"> · all addressed</Text>}
            {pr.threadsOutdated ? <Text dimColor> · {pr.threadsOutdated} outdated by later commits</Text> : null}
          </Text>
        )}
      </Text>
      {open.slice(0, 12).map(th => renderThread(t, th, d.now, W))}
      {open.length > 12 ? <Text dimColor>  … {open.length - 12} more open</Text> : null}
      {resolved.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          {'  ✓ '}{resolved.length} resolved
          {resolvedBy(resolved)}
        </Text>
      ) : null}

      <Text wrap="truncate-end">
        {'\n'}
        <Text weight="bold">commits </Text>
        <Text dimColor>newest first · "addresses n" = resolved threads opened before it</Text>
      </Text>
      {pr.commits.slice(0, 8).map(c => (
        <Text key={`cm-${c.sha}`} wrap="truncate-end">
          {'  '}
          <Text color={TONE[c.checks]}>{glyph(c.checks)}</Text> {c.sha} <Text dimColor>{ago(c.at, d.now)}</Text> {truncate(c.headline, Math.max(10, W - 46))}
          {c.coAuthors.length ? <Text color="claude"> · {c.coAuthors.join(', ')}</Text> : <Text dimColor> · {c.author}</Text>}
          {c.threadsAddressed ? <Text color="success"> · addresses {c.threadsAddressed}</Text> : null}
        </Text>
      ))}
      {pr.commits.length > 8 ? <Text dimColor>  … {pr.commits.length - 8} earlier</Text> : null}

      <Text wrap="truncate-end">
        {'\n'}
        <Text weight="bold">agents on this PR </Text>
        {pr.agents.length ? <Text color="claude">{pr.agents.join(' · ')}</Text> : <Text dimColor>none detected</Text>}
      </Text>

      <Text weight="bold">{'\n'}activity</Text>
      {pr.activity.slice(0, 6).map((ev, k) => (
        <Text key={`ev-${k}`} dimColor wrap="truncate-end">
          {'  '}{ago(ev.at, d.now)} {ev.isBot ? '🤖 ' : ''}{ev.who}: {truncate(ev.what, Math.max(10, W - 24))}
        </Text>
      ))}
    </Box>
  )
}

function resolvedBy(resolved: Thread[]): string {
  const counts = new Map<string, number>()
  for (const t of resolved) {
    const who = t.resolvedBy ?? 'unknown'
    counts.set(who, (counts.get(who) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([who, n]) => `${who} ${n}`)
  return parts.length ? ` · by ${parts.join(', ')}` : ''
}

function renderRuleChecklist(t: Table, pr: PrDetail, rules: RuleSummary) {
  const { Text } = t
  const items: { ok: boolean | null; text: string }[] = []
  for (const name of rules.requiredChecks) {
    const check = pr.checks.find(c => c.name === name)
    items.push({ ok: check ? check.state === 'success' : null, text: `check ${name} ${check ? check.state : 'not reported yet'}` })
  }
  if (rules.requiredApprovals > 0) {
    const approvals = pr.reviewers.filter(r => r.state === 'APPROVED' && !r.isBot).length
    items.push({ ok: approvals >= rules.requiredApprovals, text: `${approvals}/${rules.requiredApprovals} approvals` })
  }
  if (rules.requiresThreadResolution) {
    const open = pr.threadsTotal - pr.threadsResolved
    items.push({ ok: open === 0, text: open === 0 ? 'all threads resolved' : `${open} threads still open` })
  }
  if (rules.requiresCodeOwners) items.push({ ok: pr.reviewDecision === 'APPROVED', text: 'code owner review' })
  if (items.length === 0) return <Text dimColor>  rules: {rules.names.join(', ') || 'branch protection'} (nothing gating merge)</Text>
  return (
    <Text wrap="truncate-end">
      {'  rules: '}
      {items.map((it, k) => (
        <Text key={`rule-${k}`}>
          {k > 0 ? <Text dimColor> · </Text> : null}
          <Text color={it.ok === true ? 'success' : it.ok === false ? 'error' : 'warning'}>{it.ok === true ? '✓' : it.ok === false ? '✗' : '○'} {it.text}</Text>
        </Text>
      ))}
    </Text>
  )
}

function renderThread(t: Table, th: Thread, now: number, W: number) {
  const { Text } = t
  const who = th.openedByIsBot ? displayName(th.openedBy) : th.openedBy
  const where = `${th.path}${th.line ? `:${th.line}` : ''}`
  let status: { text: string; tone: 'success' | 'warning' | 'error' | 'subtle' }
  if (th.replies > 0 && th.commitsSince > 0) status = { text: `replied by ${th.lastReplyBy ?? '?'} · ${th.commitsSince} commit${th.commitsSince === 1 ? '' : 's'} since · awaiting resolve`, tone: 'success' }
  else if (th.replies > 0) status = { text: `replied by ${th.lastReplyBy ?? '?'} · no commit yet`, tone: 'warning' }
  else if (th.commitsSince > 0) status = { text: `${th.commitsSince} commit${th.commitsSince === 1 ? '' : 's'} since · no reply`, tone: 'warning' }
  else status = { text: 'waiting', tone: 'error' }
  if (th.isOutdated) status = { ...status, text: `${status.text} · code changed` }
  return (
    <Text key={`th-${th.id}`} wrap="truncate-end">
      {'  ○ '}
      {th.severity ? <Text color={/P0|P1|Critical|Major|High|block/i.test(th.severity) ? 'error' : 'warning'}>{th.severity} </Text> : null}
      <Text dimColor>{truncate(where, Math.max(12, Math.floor(W / 3)))} </Text>
      {th.openedByIsBot ? '🤖 ' : ''}{who} <Text dimColor>{ago(th.openedAt, now)}</Text>
      {'  '}{truncate(th.title, Math.max(10, W - 40))}
      <Text color={status.tone}> · {status.text}</Text>
    </Text>
  )
}

export function renderStats(t: Table, d: StatsData, a: Actions) {
  const { Box, Text, Button } = t
  const W = Math.max(20, d.width)
  const r = d.stats
  const narrow = W < 100
  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Button key="back" hotkey="b" plain onPress={a.back}>
            ‹ PRs
          </Button>
          <Text wrap="truncate-end">
            {'  '}
            <Text weight="bold">review bots</Text>
            <Text dimColor> · {d.repo ?? 'all repos'}{r?.sinceDays ? ` · last ${r.sinceDays} days` : ''}</Text>
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          {r && r.unjudgedPairs > 0 ? (
            <Button key="judge" hotkey="j" plain onPress={a.judge}>
              judge {r.unjudgedPairs}
            </Button>
          ) : null}
          <Button key="refresh" hotkey="r" plain onPress={a.stats}>
            refresh
          </Button>
        </Box>
      </Box>
      {d.progress ? (
        <Text color={d.progress.running ? 'warning' : 'subtle'} wrap="truncate-end">
          backfill {d.progress.running ? '⟳ ' : ''}{d.progress.total ? `${d.progress.done}/${d.progress.total} · ` : ''}{d.progress.message}
        </Text>
      ) : null}
      {d.error ? <Text color="error" wrap="truncate-end">{d.error}</Text> : null}
      {!r ? <Text dimColor>No stats computed yet. /prs stats, or /prs backfill 30 to sweep merged PRs into the ledger.</Text> : null}
      {r && r.bots.length === 0 ? <Text dimColor>No bot review threads on record. Drill into a PR, or /prs backfill 30.</Text> : null}
      {r && r.bots.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          {r.totalThreads} findings across {r.totalPrs} PRs · computed {ago(r.generatedAt, d.now)} ago
        </Text>
      ) : null}
      {r && r.bots.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          {'\n'}{'bot'.padEnd(17)} {'found'.padStart(5)} {'PRs'.padStart(4)} {'used'.padStart(5)} {'dismis'.padStart(6)} {'unk'.padStart(4)} {'open'.padStart(4)} {'used%'.padStart(5)} {'resp'.padStart(6)} {'uniq'.padStart(5)} {'dup'.padStart(4)}
        </Text>
      ) : null}
      {(r?.bots ?? []).map(b => (
        <Text key={`bot-${b.bot}`} wrap="truncate-end">
          <Text weight="bold">{truncate(b.bot, 17).padEnd(17)}</Text> {String(b.findings).padStart(5)} {String(b.prs).padStart(4)}{' '}
          <Text color="success">{String(b.used).padStart(5)}</Text> <Text color="error">{String(b.dismissed).padStart(6)}</Text>{' '}
          <Text dimColor>{String(b.resolved).padStart(4)}</Text> <Text color="warning">{String(b.open).padStart(4)}</Text>{' '}
          <Text color={b.usedRate !== null && b.usedRate >= 0.6 ? 'success' : b.usedRate !== null && b.usedRate < 0.3 ? 'error' : undefined}>{pct(b.usedRate).padStart(5)}</Text>{' '}
          {fmtSeconds(b.medianResponseSeconds).padStart(6)} {String(b.unique).padStart(5)} <Text color={b.duplicated > b.unique ? 'warning' : undefined}>{String(b.duplicated).padStart(4)}</Text>
        </Text>
      ))}
      {(r?.bots ?? []).map(b => (
        <Text key={`sev-${b.bot}`} dimColor wrap="truncate-end">
          {'  '}{truncate(b.bot, 17)}: severities {Object.entries(b.severities).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}
        </Text>
      ))}
      {r && r.pairs.length > 0 ? (
        <Text weight="bold">{'\n'}overlap between bots <Text dimColor weight="regular">same finding on the same file, judged by the model</Text></Text>
      ) : null}
      {(r?.pairs ?? []).map(p => (
        <Text key={`pair-${p.botA}-${p.botB}`} wrap="truncate-end">
          {'  '}{p.botA} × {p.botB}: <Text color={p.judged && p.same / p.judged > 0.4 ? 'warning' : undefined}>{p.same} same</Text> of {p.judged} judged
          {p.unjudged ? <Text dimColor> · {p.unjudged} unjudged</Text> : null}
        </Text>
      ))}
      <Text dimColor wrap={narrow ? 'wrap' : 'truncate-end'}>
        {'\n'}used = code moved after it (commit touched the file, diff outdated, or reply says fixed) · dismissed = reply says no, no change · unk = resolved, no evidence · resp = median time from push to comment
      </Text>
      <Text dimColor wrap="truncate-end">b back · j judge pending pairs · r recompute · /prs stats 30 · /prs stats all all-repos · /prs db</Text>
    </Box>
  )
}
