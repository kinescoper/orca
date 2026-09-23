// Claude task frames, decoded into child-work evidence for the host's records.
//
// The background-task tracker already reads every task frame and decides when a task is live,
// settled, or dropped by a roster; it queues an edge at each of those decisions. This module
// holds what those edges say, the frames only this path reads (a spawn call's result, the
// progress the tracker's legacy row ignores), and the owner lookup through the journal's
// linkage. Edges are stamped with the host clock when drained, after the journal has handled the
// frame, so the host never admits evidence ahead of the frame's own rows.

import type {
  AgentChildWorkOperation,
  AgentChildWorkOutcome
} from '../../shared/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle,
  AgentChildWorkLiveObservation
} from '../../shared/agent-status-child-work-evidence'
import {
  classifyClaudeBackgroundTaskKind,
  record,
  taskAliasId,
  taskDescription,
  taskName,
  taskText,
  taskUsageTotalTokens
} from './claude-background-task-frames'
import { isAgentChildWorkKind } from '../../shared/agent-status-child-work-liveness'
import type { TrackedClaudeBackgroundTask } from './claude-settled-background-tasks'
import type { ClaudeSession } from './claude-structured-session-state'
import { deriveToolInputPreview } from '../../shared/agent-hook-listener/tool-input-preview'
import {
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from './claude-structured-item-translation'

/** An edge the tracker decided on, stamped with the host clock once the frame is journaled. */
export type ClaudePendingChildWork = (observedAt: number) => AgentChildWorkEvidence

type ClaudeTaskFacts = {
  /** The tool the provider last reported; stamped at drain. */
  toolName?: string
  lastMessage?: string
  totalTokens?: number
}

/** Provider status → how the child ended. `killed` and `stopped` are deliberate stops; a status
 *  a terminal frame does not state is an ending nobody classified, never a success. */
export function claudeChildWorkOutcome(status: unknown): AgentChildWorkOutcome {
  switch (status) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'killed':
    case 'stopped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function claudeTaskHandle(id: string, toolUseId?: string): AgentChildWorkEvidenceHandle {
  return { idKind: 'task_id', id, ...(toolUseId !== undefined ? { runId: toolUseId } : {}) }
}

/** One tracked task as the host reads it: the tracker's own live row, plus what this frame said. */
export function claudeTaskObservation(
  id: string,
  task: TrackedClaudeBackgroundTask,
  facts: ClaudeTaskFacts = {},
  observedAt = 0
): AgentChildWorkLiveObservation {
  const totalTokens = facts.totalTokens ?? task.totalTokens
  const operation: AgentChildWorkOperation | undefined = facts.toolName
    ? { toolName: facts.toolName, basis: 'reported', observedAt }
    : undefined
  return {
    handle: claudeTaskHandle(id, task.toolUseId),
    kind: task.kind,
    residency: task.backgrounded ? 'background' : 'foreground',
    // The legacy row's own state rule, so both read the same child the same way.
    state: task.state === 'working' || task.kind !== 'monitor' ? 'working' : 'monitoring',
    // The published row names a task's type as both its name and its agent type.
    ...(task.name ? { name: task.name, agentType: task.name } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(operation ? { operation } : {}),
    ...(facts.lastMessage ? { lastMessage: facts.lastMessage } : {}),
    // Only a backgrounded task has a stop the host can target.
    stoppable: task.backgrounded
  }
}

export function pendingClaudeTaskLive(
  id: string,
  task: TrackedClaudeBackgroundTask,
  facts: ClaudeTaskFacts = {}
): ClaudePendingChildWork {
  const snapshot = { ...task }
  return (observedAt) => ({
    type: 'live',
    observedAt,
    child: claudeTaskObservation(id, snapshot, facts, observedAt)
  })
}

/** What a `task_progress` frame says: the tool the child last ran, its newest summary, usage.
 *  Its `description` restates the tool ("Running Bash") and is not the task's own. */
export function claudeTaskProgressFacts(message: Record<string, unknown>): ClaudeTaskFacts {
  const toolName = taskText(message.last_tool_name)
  const lastMessage = taskText(message.summary)
  const totalTokens = taskUsageTotalTokens(message)
  return {
    ...(toolName ? { toolName } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  }
}

function pendingClaudeTaskEnded(
  id: string,
  outcome: AgentChildWorkOutcome,
  reported: { lastMessage?: string; totalTokens?: number; toolUseId?: string }
): ClaudePendingChildWork {
  return (observedAt) => ({
    type: 'ended',
    observedAt,
    handle: claudeTaskHandle(id, reported.toolUseId),
    outcome,
    ...(reported.lastMessage ? { lastMessage: reported.lastMessage } : {}),
    ...(reported.totalTokens !== undefined ? { totalTokens: reported.totalTokens } : {})
  })
}

export const pendingClaudeTurnEnded: ClaudePendingChildWork = (observedAt) => ({
  type: 'turn-ended',
  observedAt
})

export const pendingClaudeSessionEnded: ClaudePendingChildWork = (observedAt) => ({
  type: 'session-ended',
  observedAt
})

/** A `task_notification`: the child's own ending, with its final summary and usage. */
export function pendingClaudeNotification(
  id: string,
  message: Record<string, unknown>
): ClaudePendingChildWork {
  return pendingClaudeTaskEnded(id, claudeChildWorkOutcome(message.status), {
    lastMessage: taskText(message.summary),
    totalTokens: taskUsageTotalTokens(message)
  })
}

/** A terminal `task_updated`: its error, when it has one, is the child's last word. */
export function pendingClaudeTerminalUpdate(
  id: string,
  message: Record<string, unknown>
): ClaudePendingChildWork {
  const patch = record(message.patch)
  return pendingClaudeTaskEnded(id, claudeChildWorkOutcome(patch?.status), {
    lastMessage: taskText(patch?.error)
  })
}

/** The roster's complete live BACKGROUND inventory: a background child it omits has ended. */
export function pendingClaudeInventory(
  listed: readonly (readonly [string, TrackedClaudeBackgroundTask])[]
): ClaudePendingChildWork {
  const children = listed.map(([id, task]) => [id, { ...task }] as const)
  return (observedAt) => ({
    type: 'inventory',
    observedAt,
    residency: 'background',
    children: children.map(([id, task]) => claudeTaskObservation(id, task))
  })
}

/**
 * A start for a task that already ended. The legacy row waits for the roster to list it again;
 * a start under a NEW spawn call is the provider running the child again, and the record hears
 * it now. The spawn call it ended under, or none at all, is a late frame for the run that ended.
 */
export function pendingClaudeRestart(
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
  return pendingClaudeTaskLive(id, {
    backgrounded: message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor',
    liveInTurn: true,
    kind,
    description: taskDescription(message.description),
    name: taskName(message),
    startedAt: 0,
    toolUseId
  })
}

function foregroundAgentFor(
  tasks: ReadonlyMap<string, TrackedClaudeBackgroundTask>,
  toolUseId: string
): string | null {
  for (const [id, task] of tasks) {
    if (task.toolUseId === toolUseId && !task.backgrounded && isAgentChildWorkKind(task.kind)) {
      return id
    }
  }
  return null
}

/**
 * A spawn call's result, for each FOREGROUND agent task this frame answers. The call blocked on
 * the child, so its result is the child's ending; a backgrounded spawn returns at launch and
 * proves nothing.
 */
export function claudeSpawnResults(
  message: Record<string, unknown>,
  tasks: ReadonlyMap<string, TrackedClaudeBackgroundTask>
): ClaudePendingChildWork[] {
  const envelope = message.type === 'user' ? readClaudeMessageEnvelope(message) : null
  if (!envelope) {
    return []
  }
  return claudeToolResults(envelope).flatMap((result) => {
    const id = foregroundAgentFor(tasks, result.toolUseId)
    if (id === null) {
      return []
    }
    return [
      pendingClaudeTaskEnded(id, result.failed ? 'failed' : 'succeeded', {
        lastMessage: taskText(result.output),
        toolUseId: result.toolUseId
      })
    ]
  })
}

/** Name the child that owns each live child: the agent whose own traffic made the spawn (or
 *  shell) call. A call the session's own agent made has no owner, and neither does work a
 *  backgrounded child launched: such a child sends no traffic to attribute. */
export function withClaudeChildWorkOwners(
  evidence: AgentChildWorkEvidence[],
  ownerOf: ((toolUseId: string) => string | null) | undefined
): AgentChildWorkEvidence[] {
  if (!ownerOf) {
    return evidence
  }
  const owned = (child: AgentChildWorkLiveObservation): AgentChildWorkLiveObservation => {
    const ownerId = child.handle.runId === undefined ? null : ownerOf(child.handle.runId)
    return ownerId !== null && ownerId !== child.handle.id ? { ...child, ownerId } : child
  }
  return evidence.map((edge) =>
    edge.type === 'live'
      ? { ...edge, child: owned(edge.child) }
      : edge.type === 'inventory'
        ? { ...edge, children: edge.children.map(owned) }
        : edge
  )
}

/**
 * A child's own tool traffic, read after the journal handled the frame: the call the child has
 * open now (a foreground child's traffic reaches the parent's stream; a backgrounded child's does
 * not), previewed as a hook-reported row previews its own tool. A frame that only delivers the
 * caller's own spawn result belongs to the caller, not the child it names.
 */
export function claudeChildOperation(
  message: Record<string, unknown>,
  activityOf:
    | ((parentToolUseId: string) => { agentId: string; openTool: ClaudeToolUse | null })
    | undefined,
  observedAt: number
): AgentChildWorkEvidence[] {
  const envelope = activityOf ? readClaudeMessageEnvelope(message) : null
  const parentRef = envelope?.parentToolUseId
  if (!envelope || !parentRef || !activityOf) {
    return []
  }
  const toolTraffic =
    claudeToolUses(envelope).length > 0 ||
    claudeToolResults(envelope).some((result) => result.toolUseId !== parentRef)
  if (!toolTraffic) {
    return []
  }
  const { agentId, openTool } = activityOf(parentRef)
  const input = openTool ? deriveToolInputPreview(openTool.name, openTool.input) : undefined
  return [
    {
      type: 'operation',
      observedAt,
      childId: agentId,
      operation: openTool
        ? { toolName: openTool.name, ...(input ? { input } : {}), basis: 'open', observedAt }
        : null
    }
  ]
}

/** Everything one frame (or a close) said about the session's child work, owners named. */
export function drainClaudeChildWork(
  session: Pick<ClaudeSession, 'backgroundTasks' | 'translator'> | null | undefined,
  message: Record<string, unknown> | null,
  observedAt: number
): AgentChildWorkEvidence[] {
  if (!session) {
    return []
  }
  const decided = session.backgroundTasks.drainChildWorkEvidence(observedAt)
  return [
    ...withClaudeChildWorkOwners(decided, session.translator?.childToolOwner),
    ...(message ? claudeChildOperation(message, session.translator?.childActivity, observedAt) : [])
  ]
}
