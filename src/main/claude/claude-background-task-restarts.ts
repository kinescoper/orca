// Tasks Claude started again, under a new spawn call, after they had ended.
//
// The legacy row keeps such a task hidden until a roster lists it again, so it stays out of the
// tracker's live map. Its record hears the new run at once, and holding the run here is what lets
// that run's own progress and spawn result reach the record in the meantime.

import {
  classifyClaudeBackgroundTaskKind,
  taskAliasId,
  taskDescription,
  taskName
} from './claude-background-task-frames'
import { pendingClaudeTaskLive, type ClaudePendingChildWork } from './claude-child-work-evidence'
import type { TrackedClaudeBackgroundTask } from './claude-settled-background-tasks'

const MAX_RESTARTED_TASKS = 256

export class ClaudeTaskRestarts {
  readonly tasks = new Map<string, TrackedClaudeBackgroundTask>()

  /** A start for a task that already ended. The spawn call it ended under, or none at all, is a
   *  late frame for the run that ended; a new one is the provider running the child again. */
  observe(
    id: string,
    message: Record<string, unknown>,
    endedUnder: string | undefined
  ): ClaudePendingChildWork | null {
    const toolUseId = taskAliasId(message.tool_use_id)
    if (
      toolUseId === undefined ||
      toolUseId === endedUnder ||
      message.ambient === true ||
      message.skip_transcript === true
    ) {
      return null
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    const task: TrackedClaudeBackgroundTask = {
      backgrounded: message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor',
      liveInTurn: true,
      kind,
      description: taskDescription(message.description),
      name: taskName(message),
      startedAt: 0,
      toolUseId
    }
    this.tasks.delete(id)
    this.tasks.set(id, task)
    if (this.tasks.size > MAX_RESTARTED_TASKS) {
      this.tasks.delete(this.tasks.keys().next().value ?? id)
    }
    return pendingClaudeTaskLive(id, task)
  }

  get(id: string): TrackedClaudeBackgroundTask | undefined {
    return this.tasks.get(id)
  }

  /** The run ended again, or a roster listed it and the tracker holds it from now on. */
  take(id: string): TrackedClaudeBackgroundTask | undefined {
    const task = this.tasks.get(id)
    this.tasks.delete(id)
    return task
  }

  clear(): void {
    this.tasks.clear()
  }
}
