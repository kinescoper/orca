// Claude's `background_tasks_changed`: a full replacement of the live BACKGROUND roster.
// Moved out of the tracker unchanged; the tracker owns when it runs and what it publishes.

import {
  classifyClaudeBackgroundTaskKind,
  liveClaudeTaskRunState,
  record,
  taskDescription,
  taskId,
  taskName
} from './claude-background-task-frames'
import type { ClaudeTaskRestarts } from './claude-background-task-restarts'
import type {
  ClaudeSettledBackgroundTasks,
  TrackedClaudeBackgroundTask
} from './claude-settled-background-tasks'

export type ClaudeAggregateRosterInput = {
  value: unknown[]
  /** The tracker's live tasks; replaced in place. */
  tasks: Map<string, TrackedClaudeBackgroundTask>
  retention: ClaudeSettledBackgroundTasks
  /** Terminal edges already seen; a listed id is live again. */
  terminalTaskIds: Map<string, string | undefined>
  /** Runs started again after they ended; a listing hands one back to the live map. */
  restarts: Pick<ClaudeTaskRestarts, 'take'>
  /** Read only for a task the roster lists for the first time. */
  now: () => number
  maxTasks: number
}

/** Apply one roster; returns the ids it listed, in the provider's order. */
export function replaceClaudeAggregateRoster(input: ClaudeAggregateRosterInput): string[] {
  const { tasks, retention, terminalTaskIds, maxTasks } = input
  const prior = new Map(tasks)
  tasks.clear()
  const roster = new Map<string, TrackedClaudeBackgroundTask>()
  for (const valueTask of input.value) {
    if (roster.size >= maxTasks) {
      break
    }
    const task = record(valueTask)
    if (!task || task.ambient === true) {
      continue
    }
    const id = taskId(task)
    if (!id) {
      continue
    }
    // An authoritative live roster supersedes an earlier terminal edge — for
    // the ids it actually lists. Wiping the whole set left a finished
    // FOREGROUND id undefended, since the start guard now convicts only
    // backgrounded starts.
    terminalTaskIds.delete(id)
    const restarted = input.restarts.take(id)
    const existing = prior.get(id) ?? retention.resume(id)
    const toolUseId = restarted?.toolUseId ?? existing?.toolUseId
    const kind = classifyClaudeBackgroundTaskKind(task.task_type)
    roster.set(id, {
      backgrounded: true,
      liveInTurn: true,
      kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
      description: taskDescription(task.description) ?? existing?.description,
      name: taskName(task) ?? existing?.name,
      state: liveClaudeTaskRunState(task.status) ?? existing?.state,
      startedAt: existing?.startedAt ?? input.now(),
      totalTokens: existing?.totalTokens,
      ...(toolUseId !== undefined ? { toolUseId } : {})
    })
  }
  // Live foreground work is not in a BACKGROUND roster and is not superseded
  // by one. Budget counted up front so eviction drops the STALEST retained
  // rows rather than the newest, and roster entries are never starved.
  const retainable = [...prior].filter(
    ([id, task]) => !task.backgrounded && task.liveInTurn && !roster.has(id)
  )
  let evict = Math.max(0, roster.size + retainable.length - maxTasks)
  // Retained rows keep their own relative order and stay ahead of the roster,
  // so a live row the user is reading does not drop below it when a roster
  // frame lands. Within the roster the PROVIDER's order wins — including for
  // a task it reports live again, which belongs where the provider lists it
  // rather than appended after the rows that outlived it.
  for (const [id, task] of retainable) {
    if (evict > 0) {
      evict -= 1
      continue
    }
    tasks.set(id, task)
  }
  for (const [id, task] of roster) {
    tasks.set(id, task)
  }
  for (const [id, task] of prior) {
    if (task.backgrounded && !tasks.has(id)) {
      retention.rememberRemoved(id, task)
    }
  }
  return [...roster.keys()]
}
