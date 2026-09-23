import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'provider-1', uuid: crypto.randomUUID(), ...fields }
}

function spawnResult(toolUseId: string, isError = false): Record<string, unknown> {
  return {
    type: 'user',
    session_id: 'provider-1',
    uuid: crypto.randomUUID(),
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Found 3 flaky tests',
          is_error: isError
        }
      ]
    }
  }
}

const foregroundAgent = system('task_started', {
  task_id: 'agent-fg',
  tool_use_id: 'toolu_fg',
  task_type: 'local_agent',
  subagent_type: 'Explore',
  description: 'Find flaky tests',
  is_backgrounded: false
})
const backgroundAgent = system('task_started', {
  task_id: 'agent-bg',
  tool_use_id: 'toolu_bg',
  task_type: 'local_agent',
  description: 'Audit the build',
  is_backgrounded: true
})

function drained(tracker: ClaudeBackgroundTaskTracker, at = 500): AgentChildWorkEvidence[] {
  return tracker.drainChildWorkEvidence(at)
}

describe('Claude child-work evidence from the task tracker', () => {
  it('names a started child by its task id and the spawn call of this run', () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(foregroundAgent)
    expect(drained(tracker)).toEqual([
      {
        type: 'live',
        observedAt: 500,
        child: {
          handle: { idKind: 'task_id', id: 'agent-fg', runId: 'toolu_fg' },
          kind: 'agent',
          residency: 'foreground',
          state: 'working',
          name: 'Explore',
          agentType: 'Explore',
          description: 'Find flaky tests',
          stoppable: false
        }
      }
    ])
    expect(drained(tracker)).toEqual([])
  })

  it("carries a FOREGROUND child's progress to its record while its legacy row stays as it was", () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(foregroundAgent)
    drained(tracker)
    const before = tracker.state
    expect(
      tracker.observe(
        system('task_progress', {
          task_id: 'agent-fg',
          description: 'Running Bash',
          last_tool_name: 'Bash',
          summary: 'Reproducing the flake',
          usage: { total_tokens: 1_200, tool_uses: 3, duration_ms: 900 }
        })
      )
    ).toBe(false)
    expect(tracker.state).toEqual(before)
    expect(drained(tracker, 600)).toEqual([
      expect.objectContaining({
        type: 'live',
        observedAt: 600,
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: 'agent-fg', runId: 'toolu_fg' },
          residency: 'foreground',
          // The progress description restates the tool; the task keeps its own.
          description: 'Find flaky tests',
          operation: { toolName: 'Bash', basis: 'reported', observedAt: 600 },
          lastMessage: 'Reproducing the flake',
          totalTokens: 1_200
        })
      })
    ])
  })

  it('reports how a child ended in the outcome vocabulary, not the legacy run state', () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(backgroundAgent)
    drained(tracker)
    tracker.observe(
      system('task_notification', {
        task_id: 'agent-bg',
        status: 'failed',
        summary: 'Build broke',
        usage: { total_tokens: 900 }
      })
    )
    // The legacy row keeps calling a failure `blocked`; the record hears `failed`.
    expect(tracker.state?.settledTasks).toBeUndefined()
    expect(drained(tracker)).toEqual([
      {
        type: 'ended',
        observedAt: 500,
        handle: { idKind: 'task_id', id: 'agent-bg' },
        outcome: 'failed',
        lastMessage: 'Build broke',
        totalTokens: 900
      }
    ])
    for (const [status, outcome] of [
      ['completed', 'succeeded'],
      ['killed', 'cancelled'],
      ['stopped', 'cancelled'],
      ['whatever', 'unknown']
    ]) {
      tracker.observe(system('task_notification', { task_id: 'agent-bg', status }))
      expect(drained(tracker)).toEqual([expect.objectContaining({ type: 'ended', outcome })])
    }
    tracker.observe(
      system('task_updated', { task_id: 'agent-bg', patch: { status: 'failed', error: 'OOM' } })
    )
    expect(drained(tracker)).toEqual([
      expect.objectContaining({ type: 'ended', outcome: 'failed', lastMessage: 'OOM' })
    ])
  })

  it("ends a foreground child on its spawn call's result, and ignores a backgrounded spawn's", () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(foregroundAgent)
    tracker.observe(backgroundAgent)
    drained(tracker)
    const rows = tracker.state
    expect(tracker.observe(spawnResult('toolu_bg'))).toBe(false)
    expect(drained(tracker)).toEqual([])
    expect(tracker.observe(spawnResult('toolu_fg', true))).toBe(false)
    expect(tracker.state).toEqual(rows)
    expect(drained(tracker)).toEqual([
      {
        type: 'ended',
        observedAt: 500,
        handle: { idKind: 'task_id', id: 'agent-fg', runId: 'toolu_fg' },
        outcome: 'failed',
        lastMessage: 'Found 3 flaky tests'
      }
    ])
  })

  it('lists the whole background roster as one inventory, after the tracker applied it', () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(backgroundAgent)
    drained(tracker)
    tracker.observe(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: 'sleep 30' }]
      })
    )
    expect(drained(tracker)).toEqual([
      {
        type: 'inventory',
        observedAt: 500,
        residency: 'background',
        children: [
          expect.objectContaining({
            handle: { idKind: 'task_id', id: 'shell-1' },
            kind: 'command',
            residency: 'background',
            description: 'sleep 30',
            stoppable: true
          })
        ]
      }
    ])
  })

  it('tells a restart under a new spawn call from a late start of the run that ended', () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(backgroundAgent)
    tracker.observe(system('task_notification', { task_id: 'agent-bg', status: 'completed' }))
    drained(tracker)
    tracker.observe(backgroundAgent)
    expect(drained(tracker)).toEqual([])
    const before = tracker.state
    tracker.observe(
      system('task_started', {
        task_id: 'agent-bg',
        tool_use_id: 'toolu_resume',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(tracker.state).toEqual(before)
    expect(drained(tracker)).toEqual([
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: 'agent-bg', runId: 'toolu_resume' },
          residency: 'background'
        })
      })
    ])
    // Until a roster lists it, the new run's progress still reaches its record.
    tracker.observe(system('task_progress', { task_id: 'agent-bg', last_tool_name: 'Read' }))
    expect(tracker.state).toEqual(before)
    expect(drained(tracker)).toEqual([
      expect.objectContaining({
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: 'agent-bg', runId: 'toolu_resume' },
          operation: expect.objectContaining({ toolName: 'Read' })
        })
      })
    ])
    // A roster listing hands the run back to the live map under its new spawn call.
    tracker.observe(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'agent-bg', task_type: 'local_agent' }]
      })
    )
    expect(drained(tracker)).toEqual([
      expect.objectContaining({
        type: 'inventory',
        children: [
          expect.objectContaining({
            handle: { idKind: 'task_id', id: 'agent-bg', runId: 'toolu_resume' }
          })
        ]
      })
    ])
  })

  it("ends a restarted foreground run on its own spawn call's result", () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe(foregroundAgent)
    tracker.observe(system('task_notification', { task_id: 'agent-fg', status: 'completed' }))
    tracker.observe({ ...foregroundAgent, tool_use_id: 'toolu_fg_2' })
    drained(tracker)
    tracker.observe(spawnResult('toolu_fg'))
    expect(drained(tracker)).toEqual([])
    tracker.observe(spawnResult('toolu_fg_2', true))
    expect(drained(tracker)).toEqual([
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'agent-fg', runId: 'toolu_fg_2' },
        outcome: 'failed'
      })
    ])
  })

  it('marks a turn boundary and the end of the provider session', () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    tracker.observe({ type: 'result', subtype: 'success' })
    tracker.observe({ type: 'user' }, true)
    tracker.clear()
    expect(drained(tracker)).toEqual([
      { type: 'turn-ended', observedAt: 500 },
      { type: 'turn-ended', observedAt: 500 },
      { type: 'session-ended', observedAt: 500 }
    ])
  })
})
