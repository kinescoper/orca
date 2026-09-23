import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { replaceClaudeAggregateRoster } from './claude-background-task-aggregate-roster'
import {
  classifyClaudeBackgroundTaskKind,
  liveClaudeTaskRunState,
  record,
  taskAliasId,
  taskDescription,
  taskId,
  taskName,
  taskUsageTotalTokens,
  terminalClaudeTaskRunState
} from './claude-background-task-frames'
import {
  claudeSpawnResults,
  claudeTaskProgressFacts,
  pendingClaudeInventory,
  pendingClaudeNotification,
  pendingClaudeSessionEnded,
  pendingClaudeTaskLive,
  pendingClaudeTerminalUpdate,
  pendingClaudeTurnEnded,
  type ClaudePendingChildWork
} from './claude-child-work-evidence'
import { ClaudeTaskRestarts } from './claude-background-task-restarts'
import {
  ClaudeSettledBackgroundTasks,
  claudeBackgroundTaskDetail,
  type TrackedClaudeBackgroundTask
} from './claude-settled-background-tasks'

// `claude-subagent-*` reads this channel through these names; the readers themselves
// live in the frames module so both consumers share one definition.
export {
  classifyClaudeBackgroundTaskKind,
  isBoundedClaudeTaskId,
  taskDescription as claudeTaskDescription,
  taskId as claudeTaskId
} from './claude-background-task-frames'
export type { ClaudeBackgroundTaskKind } from './claude-background-task-frames'

const MAX_TRACKED_TASKS = 256

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedClaudeBackgroundTask>()
  private readonly retention = new ClaudeSettledBackgroundTasks()
  /** Terminal edges seen, with the spawn call each ended under. */
  private readonly terminalTaskIds = new Map<string, string | undefined>()
  private readonly restarts = new ClaudeTaskRestarts()
  /** Child-work evidence decided since the last drain; see `claude-child-work-evidence`. */
  private readonly childWork: ClaudePendingChildWork[] = []
  private aggregateRosterObserved = false
  private monitoring = false
  private publishedTasksFingerprint = ''

  constructor(private readonly now: () => number = () => Date.now()) {}

  get state(): AgentSessionBackgroundTaskState | null {
    if (!this.monitoring) {
      return null
    }
    return {
      state: 'monitoring',
      tasks: this.backgroundTaskDetails(),
      ...(this.retention.hasSettled ? { settledTasks: this.retention.settledDetails() } : {})
    }
  }

  get stoppableTaskIds(): string[] {
    return [...this.tasks].flatMap(([id, task]) => (task.backgrounded ? [id] : []))
  }

  /** The evidence queued since the last drain, stamped with the host clock of the caller. */
  drainChildWorkEvidence(observedAt: number): AgentChildWorkEvidence[] {
    return this.childWork.splice(0).map((edge) => edge(observedAt))
  }

  observe(message: Record<string, unknown>, startsTurn = false): boolean {
    // Background work publishes through a foreground turn: the strip stays
    // honest mid-fan-out and the client alone decides when the idle-only
    // monitoring label may speak.
    //
    // A new turn is the same evidence `result` is: nothing the previous turn
    // left foreground is still that turn's work. CLEANUP ONLY — a row's
    // visibility never consults `startsTurn`, which is Orca's own
    // dispatch-correlation bookkeeping and false by design for undispatched
    // turns, so a missed one degrades to the old behaviour and can never hide
    // live work.
    if (startsTurn || message.type === 'result') {
      this.settleForegroundTasks()
      this.childWork.push(pendingClaudeTurnEnded)
    }
    // The legacy row keeps a foreground child until `result`; only the record learns its ending.
    this.childWork.push(...claudeSpawnResults(message, [this.tasks, this.restarts.tasks]))
    if (message.type === 'system') {
      if (!this.observeSystemFrame(message) && !startsTurn) {
        return false
      }
    } else if (!startsTurn && message.type !== 'result') {
      return false
    }
    return this.refreshMonitoring()
  }

  clear(): boolean {
    this.tasks.clear()
    this.retention.clear()
    this.terminalTaskIds.clear()
    this.restarts.clear()
    this.aggregateRosterObserved = false
    this.childWork.push(pendingClaudeSessionEnded)
    return this.refreshMonitoring()
  }

  /** `result` is the outcome of every task the provider marked foreground, so
   *  they stop being live work. Backgrounded tasks outlive the turn and are
   *  never swept here — only their own terminal frame retires them. */
  private settleForegroundTasks(): void {
    for (const task of this.tasks.values()) {
      if (!task.backgrounded) {
        task.liveInTurn = false
      }
    }
  }

  private settle(
    id: string,
    state: AgentSessionBackgroundTaskRunState,
    outcome: { totalTokens?: number } = {}
  ): void {
    this.retention.settle(id, state, outcome, this.tasks.get(id))
    this.finish(id)
  }

  private observeSystemFrame(message: Record<string, unknown>): boolean {
    if (message.subtype === 'background_tasks_changed') {
      this.replaceAggregateRoster(message.tasks)
      return true
    }
    const id = taskId(message)
    if (!id) {
      return false
    }
    if (message.subtype === 'task_notification') {
      // The notification is affirmative terminal evidence even when its status
      // field is unreadable — matching the liveness semantics this edge always had.
      this.settle(id, terminalClaudeTaskRunState(message.status) ?? 'done', {
        totalTokens: taskUsageTotalTokens(message)
      })
      this.childWork.push(pendingClaudeNotification(id, message))
      return true
    }
    if (message.subtype === 'task_progress') {
      // Progress `description` is the current activity ("Running <tool>"), not
      // the task's name — only usage (and a missing identity) may update.
      const existing = this.tasks.get(id)
      const run = existing ?? this.restarts.get(id)
      if (run) {
        // Every child's progress reaches its record; the legacy row takes a background one's usage.
        const named = { ...run, name: run.name ?? taskName(message) }
        this.childWork.push(pendingClaudeTaskLive(id, named, claudeTaskProgressFacts(message)))
      }
      const totalTokens = taskUsageTotalTokens(message)
      if (!existing?.backgrounded || totalTokens === undefined) {
        return false
      }
      this.tasks.set(id, { ...existing, totalTokens, name: existing.name ?? taskName(message) })
      return true
    }
    if (message.subtype === 'task_updated') {
      return this.observeTaskUpdated(id, message)
    }
    if (message.subtype !== 'task_started') {
      return false
    }
    if (this.terminalTaskIds.has(id)) {
      const restart = this.restarts.observe(id, message, this.terminalTaskIds.get(id))
      if (restart) {
        this.childWork.push(restart)
      }
      return false
    }
    if (message.ambient === true || message.skip_transcript === true) {
      this.finish(id)
      return true
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    const backgrounded =
      message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor'
    // The aggregate roster enumerates BACKGROUND work only, so it is authoritative
    // over that class alone. A foreground start it could never have listed is not
    // stale evidence, and dropping it here silently killed foreground rows.
    if (this.aggregateRosterObserved && backgrounded && !this.tasks.has(id)) {
      return false
    }
    this.upsert(id, {
      backgrounded,
      kind,
      description: taskDescription(message.description),
      name: taskName(message),
      state: liveClaudeTaskRunState(message.status) ?? undefined,
      startedAt: this.now(),
      toolUseId: taskAliasId(message.tool_use_id)
    })
    return true
  }

  private observeTaskUpdated(id: string, message: Record<string, unknown>): boolean {
    const patch = record(message.patch)
    if (!patch) {
      return false
    }
    const settledState = terminalClaudeTaskRunState(patch.status)
    if (settledState) {
      this.settle(id, settledState)
      this.childWork.push(pendingClaudeTerminalUpdate(id, message))
      return true
    }
    const existing = this.tasks.get(id)
    // Classification is re-derived per transition: a later frame that reveals a
    // real type moves the task between buckets instead of pinning first-seen.
    const patchKind =
      'task_type' in patch ? classifyClaudeBackgroundTaskKind(patch.task_type) : undefined
    const liveState = liveClaudeTaskRunState(patch.status)
    const hasContent =
      patch.is_backgrounded === true ||
      taskDescription(patch.description) !== undefined ||
      taskName(patch) !== undefined ||
      liveState !== null ||
      (patchKind !== undefined && patchKind !== 'unknown')
    if (hasContent && (!this.aggregateRosterObserved || existing)) {
      this.upsert(id, {
        backgrounded: patch.is_backgrounded === true || existing?.backgrounded === true,
        kind: patchKind ?? existing?.kind ?? 'unknown',
        description: taskDescription(patch.description),
        name: taskName(patch),
        state: liveState ?? undefined,
        startedAt: this.now()
      })
      return true
    }
    return false
  }

  private replaceAggregateRoster(value: unknown): void {
    if (!Array.isArray(value)) {
      return
    }
    this.aggregateRosterObserved = true
    const listed = replaceClaudeAggregateRoster({
      value,
      tasks: this.tasks,
      retention: this.retention,
      terminalTaskIds: this.terminalTaskIds,
      restarts: this.restarts,
      now: this.now,
      maxTasks: MAX_TRACKED_TASKS
    })
    this.childWork.push(
      pendingClaudeInventory(
        listed.flatMap((id) => {
          const task = this.tasks.get(id)
          return task ? [[id, task] as const] : []
        })
      )
    )
  }

  private upsert(id: string, task: Omit<TrackedClaudeBackgroundTask, 'liveInTurn'>): void {
    if (!this.tasks.has(id) && this.tasks.size >= MAX_TRACKED_TASKS) {
      let foregroundId: string | undefined
      for (const [candidateId, candidate] of this.tasks) {
        if (!candidate.backgrounded) {
          foregroundId = candidateId
          break
        }
      }
      if (!foregroundId) {
        return
      }
      this.tasks.delete(foregroundId)
    }
    const existing = this.tasks.get(id) ?? this.retention.resume(id)
    this.terminalTaskIds.delete(id)
    const next: TrackedClaudeBackgroundTask = existing
      ? {
          backgrounded: existing.backgrounded || task.backgrounded,
          // A settled foreground task is not revived by a late edge frame.
          liveInTurn: existing.liveInTurn,
          kind: task.kind !== 'unknown' ? task.kind : existing.kind,
          description: task.description ?? existing.description,
          name: task.name ?? existing.name,
          state: task.state ?? existing.state,
          startedAt: existing.startedAt,
          totalTokens: existing.totalTokens,
          toolUseId: task.toolUseId ?? existing.toolUseId
        }
      : { ...task, liveInTurn: true }
    this.tasks.set(id, next)
    this.childWork.push(pendingClaudeTaskLive(id, next))
  }

  private finish(id: string): void {
    const restarted = this.restarts.take(id)
    const toolUseId = (this.tasks.get(id) ?? restarted)?.toolUseId
    this.tasks.delete(id)
    this.terminalTaskIds.delete(id)
    this.terminalTaskIds.set(id, toolUseId)
    if (this.terminalTaskIds.size > MAX_TRACKED_TASKS) {
      const oldest = this.terminalTaskIds.keys().next()
      if (!oldest.done) {
        this.terminalTaskIds.delete(oldest.value)
      }
    }
  }

  private refreshMonitoring(): boolean {
    const details = this.backgroundTaskDetails()
    if (details.length === 0 && this.retention.hasSettled) {
      this.retention.flushSettled()
    }
    const next = details.length > 0
    const fingerprint = next ? JSON.stringify([details, this.retention.settledDetails()]) : ''
    if (next === this.monitoring && fingerprint === this.publishedTasksFingerprint) {
      return false
    }
    this.monitoring = next
    this.publishedTasksFingerprint = fingerprint
    return true
  }

  private backgroundTaskDetails(): AgentSessionBackgroundTask[] {
    const details: AgentSessionBackgroundTask[] = []
    for (const [id, task] of this.tasks) {
      if (!task.backgrounded && !task.liveInTurn) {
        continue
      }
      details.push(claudeBackgroundTaskDetail(id, task))
    }
    return details
  }
}
