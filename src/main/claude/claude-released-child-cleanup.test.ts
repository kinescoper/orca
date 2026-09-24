import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import {
  ClaudeReleasedChildCleanup,
  type ClaudeReleasedChildCleanupReport
} from './claude-released-child-cleanup'
import { fakeClaude } from './claude-structured-session-test-support'

async function releasedChild(
  closeResults: boolean[],
  verdict: ClaudeStreamJsonConnection['exitVerdict'] = { root: 'exited', tree: 'unverifiable' }
) {
  const connection = await fakeClaude({ unprovenCloseVerdict: verdict }).openConnection({
    pathToClaudeCodeExecutable: 'claude',
    options: {},
    cwd: '/work/repo'
  })
  const close = vi.fn(async () => closeResults.shift() ?? false)
  connection.close = close
  return { connection, close }
}

describe('ClaudeReleasedChildCleanup', () => {
  let reports: ClaudeReleasedChildCleanupReport[]
  let cleanup: ClaudeReleasedChildCleanup

  beforeEach(() => {
    vi.useFakeTimers()
    reports = []
    cleanup = new ClaudeReleasedChildCleanup({
      retryDelaysMs: [10, 20],
      report: (report) => reports.push(report)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up after its schedule and reports the verdict it last saw', async () => {
    const { connection, close } = await releasedChild([])
    cleanup.adopt('session-1', connection)

    await vi.advanceTimersByTimeAsync(10)
    expect(close).toHaveBeenCalledTimes(1)
    expect(reports).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(close).toHaveBeenCalledTimes(2)

    expect(reports).toEqual([
      { sessionId: 'session-1', pid: 4321, verdict: { root: 'exited', tree: 'unverifiable' } }
    ])
    expect(cleanup.size).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('stops as soon as a retry proves the tree gone', async () => {
    const { connection, close } = await releasedChild([true])
    cleanup.adopt('session-1', connection)

    await vi.advanceTimersByTimeAsync(100)

    expect(close).toHaveBeenCalledTimes(1)
    expect(reports).toEqual([])
    expect(cleanup.size).toBe(0)
  })

  it('tells its owner once whether a retry proved the tree or the schedule gave up', async () => {
    const provenChild = await releasedChild([true])
    const stuckChild = await releasedChild([])
    const settled: [string, boolean][] = []
    cleanup.adopt('session-1', provenChild.connection, (proven) => settled.push(['s1', proven]))
    cleanup.adopt('session-2', stuckChild.connection, (proven) => settled.push(['s2', proven]))

    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toEqual([['s1', true]])
    await vi.advanceTimersByTimeAsync(20)

    expect(settled).toEqual([
      ['s1', true],
      ['s2', false]
    ])
    expect(reports.map((report) => report.sessionId)).toEqual(['session-2'])
  })

  it('never adopts a child whose tree is already proven', async () => {
    const { connection } = await releasedChild([], { root: 'exited', tree: 'exited' })
    cleanup.adopt('session-1', connection)

    expect(cleanup.size).toBe(0)
  })

  it('makes one final attempt at shutdown and reports without throwing', async () => {
    const unproven = await releasedChild([false])
    const proven = await releasedChild([true])
    cleanup.adopt('session-1', unproven.connection)
    cleanup.adopt('session-2', proven.connection)

    await expect(cleanup.closeAll()).resolves.toBeUndefined()

    expect(unproven.close).toHaveBeenCalledOnce()
    expect(proven.close).toHaveBeenCalledOnce()
    expect(reports.map((report) => report.sessionId)).toEqual(['session-1'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(unproven.close).toHaveBeenCalledOnce()
  })
})
