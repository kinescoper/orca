// The host's lease release is the one decision that a Claude child is closed. These pin how the
// adapter's own session index follows that decision instead of outliving it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import {
  ClaudeReleasedChildCleanup,
  type ClaudeReleasedChildCleanupReport
} from './claude-released-child-cleanup'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor,
  recordingJournalSink
} from './claude-structured-session-test-support'

const ROOT_EXITED_TREE_UNVERIFIABLE = { root: 'exited', tree: 'unverifiable' } as const
const ROOT_EXITED_TREE_LIVE = { root: 'exited', tree: 'live' } as const

async function acquiredWithCleanup(
  closeVerdict?: ClaudeStreamJsonConnection['exitVerdict'],
  claudeConfigDir = '/accounts/claude',
  retryDelaysMs: readonly number[] = []
) {
  const claude = fakeClaude(closeVerdict ? { unprovenCloseVerdict: closeVerdict } : {})
  const events: ClaudeStructuredSessionEvent[] = []
  const unverified: ClaudeReleasedChildCleanupReport[] = []
  const cleanup = new ClaudeReleasedChildCleanup({
    retryDelaysMs,
    report: (report) => unverified.push(report)
  })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumed: false
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {},
    releasedChildCleanup: cleanup
  })
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-7',
    events: recordingJournalSink()
  })
  return { adapter, claude, events, cleanup, unverified }
}

function endedEvents(events: ClaudeStructuredSessionEvent[]) {
  return events.filter((event) => event.type === 'ended')
}

describe('Claude unexpected exit with an unverifiable tree', () => {
  it('publishes ended so the host can release the lease the root held', async () => {
    const { adapter, claude, events } = await acquiredWithCleanup(ROOT_EXITED_TREE_UNVERIFIABLE)

    claude.connections[0]!.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))
    await adapter.drainObservedExits()

    expect(endedEvents(events)).toEqual([
      expect.objectContaining({ cause: 'unexpected-exit', fence: 7 })
    ])
    // Publishing is not a tree claim: cleanup for this child still reports only the root's exit.
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
  })

  it('still withholds ended while a descendant was seen alive', async () => {
    const { adapter, claude, events } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_LIVE,
      undefined,
      [60_000]
    )

    claude.connections[0]!.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))
    await adapter.drainObservedExits()

    expect(endedEvents(events)).toEqual([])
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      AgentSessionAcquisitionExitUnprovenError
    )
  })

  it('stops reporting a turn in flight once ended is out', async () => {
    const accountHome = await mkdtemp(join(tmpdir(), 'orca-claude-release-history-'))
    try {
      const { adapter, claude } = await acquiredWithCleanup(
        ROOT_EXITED_TREE_UNVERIFIABLE,
        accountHome
      )
      await mkdir(join(accountHome, 'projects', 'work'), { recursive: true })
      const rows = [
        { type: 'user', uuid: 'anchor', parentUuid: null, sessionId: PROVIDER_SESSION_ID },
        { type: 'last-prompt', sessionId: PROVIDER_SESSION_ID, leafUuid: 'anchor' }
      ]
      await writeFile(
        join(accountHome, 'projects', 'work', `${PROVIDER_SESSION_ID}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
      )

      claude.connections[0]!.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))
      await adapter.drainObservedExits()

      const window = await adapter.providerHistoryWindow({
        identity: {
          ...identityFor(),
          providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'anchor' }
        },
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: accountHome }
      })
      expect(window?.turnInFlight).toBe(false)
    } finally {
      await rm(accountHome, { recursive: true, force: true })
    }
  })
})

describe('Claude unexpected exit while a descendant was seen alive', () => {
  it('publishes the withheld ended once a cleanup retry proves the tree gone', async () => {
    const { adapter, claude, events, cleanup, unverified } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_LIVE,
      undefined,
      [1, 60_000]
    )
    const connection = claude.connections[0]!
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))
    await adapter.drainObservedExits()
    expect(endedEvents(events)).toEqual([])
    expect(cleanup.size).toBe(1)

    // The surviving descendant exits; the next scheduled ladder run can now prove the tree.
    connection.exitVerdict = { root: 'exited', tree: 'exited' }
    connection.close = async () => true

    await vi.waitFor(() =>
      expect(endedEvents(events)).toEqual([
        expect.objectContaining({ cause: 'unexpected-exit', fence: 7 })
      ])
    )
    expect(cleanup.size).toBe(0)
    expect(unverified).toEqual([])
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
  })

  it('publishes at give-up and reports the descendant as live, never gone', async () => {
    const { adapter, claude, events, unverified } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_LIVE,
      undefined,
      [1]
    )
    claude.connections[0]!.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))

    await vi.waitFor(() => expect(endedEvents(events)).toHaveLength(1))
    expect(unverified).toEqual([
      { sessionId: 'session-1', pid: 4321, verdict: ROOT_EXITED_TREE_LIVE }
    ])
    // The exit stays as evidence: cleanup still reports the descendant unproven.
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      AgentSessionAcquisitionExitUnprovenError
    )
  })
})

describe('Claude acknowledged session release', () => {
  it('forgets a session whose close saw only the root leave, and hands its tree to cleanup', async () => {
    const { adapter, claude, cleanup, unverified } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_UNVERIFIABLE
    )
    await expect(adapter.closeSession('session-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )

    adapter.acknowledgeSessionRelease('session-1', 7)

    expect(adapter.recordsContextUsage('session-1')).toBe(false)
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(claude.connections[0]!.closeCount).toBe(1)
    await cleanup.closeAll()
    expect(unverified).toEqual([
      { sessionId: 'session-1', pid: 4321, verdict: ROOT_EXITED_TREE_UNVERIFIABLE }
    ])
  })

  it('forgets an exit whose ended already went out', async () => {
    const { adapter, claude, cleanup, unverified } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_UNVERIFIABLE
    )
    claude.connections[0]!.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))
    await adapter.drainObservedExits()

    adapter.acknowledgeSessionRelease('session-1', 7)

    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    await cleanup.closeAll()
    expect(unverified).toHaveLength(1)
  })
  it('leaves a child acquired since alone when a stale release arrives late', async () => {
    const { adapter, claude, cleanup, unverified } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_UNVERIFIABLE
    )
    await expect(adapter.closeSession('session-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-8' })
    const current = claude.connections[1]!

    adapter.acknowledgeSessionRelease('session-1', 7)

    expect(adapter.recordsContextUsage('session-1')).toBe(true)
    await cleanup.closeAll()
    expect(current.closeCount).toBe(0)
    expect(unverified).toHaveLength(1)
  })
})

describe('Claude resume past a released child', () => {
  it('does not close a child again once a later fence proves its lease released', async () => {
    const { adapter, claude, cleanup, unverified } = await acquiredWithCleanup(
      ROOT_EXITED_TREE_UNVERIFIABLE
    )
    // No acknowledgement: an acquisition-cleanup release reaches the store, not the adapter.
    await expect(adapter.closeSession('session-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-8' })

    expect(claude.connections).toHaveLength(2)
    expect(claude.connections[0]!.closeCount).toBe(1)
    await cleanup.closeAll()
    expect(unverified.map((report) => report.pid)).toEqual([4321])
  })

  it('still stops a live child first, since a later fence is not evidence it died', async () => {
    const { adapter, claude } = await acquiredWithCleanup()
    const first = claude.connections[0]!

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-8' })

    expect(first.closeCount).toBe(1)
    expect(claude.connections).toHaveLength(2)
  })
})
