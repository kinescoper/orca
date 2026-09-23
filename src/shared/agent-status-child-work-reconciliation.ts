// Fold one structured session's child-work evidence into the host's records.
//
// The store holds the only current record per child; evidence patches it. Settlement from
// evidence that names no single child (an inventory, a turn boundary) is decided here from the
// residency the record stores, so every producer shares one rule. It owns only the records its
// own producer admitted, and never claims an outcome the evidence did not report.

import type { AgentChildWorkAdmission } from './agent-status-child-work-admission'
import type {
  AgentChildWorkEndedEvidence,
  AgentChildWorkEvidence,
  AgentChildWorkInventoryEvidence,
  AgentChildWorkOperationEvidence
} from './agent-status-child-work-evidence'
import {
  applyAgentChildWorkLive,
  settleAgentChildWork,
  agentChildWorkRunVerdict,
  STRUCTURED_CHILD_WORK_MAX_LIVE,
  type AgentChildWorkEvidenceContext,
  type AgentChildWorkReconcileOutcome
} from './agent-status-child-work-evidence-admission'
import {
  currentAgentChildWorkAliases,
  ownedStructuredChildWork,
  resolveAgentChildWorkHandle,
  type AgentChildWorkEvidenceScope
} from './agent-status-child-work-evidence-resolution'

export type { AgentChildWorkReconcileOutcome } from './agent-status-child-work-evidence-admission'

/** Settled children kept per session. The oldest go first, never one that owns live work. */
export const STRUCTURED_CHILD_WORK_MAX_SETTLED = 32

export type AgentChildWorkReconcileInput = AgentChildWorkEvidenceScope & {
  admission: AgentChildWorkAdmission
  evidence: readonly AgentChildWorkEvidence[]
}

type ReconcileContext = AgentChildWorkEvidenceContext

function applyEnded(ctx: ReconcileContext, edge: AgentChildWorkEndedEvidence): void {
  const resolution = resolveAgentChildWorkHandle(ctx, [edge.handle.idKind], edge.handle.id)
  const existing = resolution?.child
  if (resolution?.ambiguous) {
    ctx.outcome.rejected.push({ handleId: edge.handle.id, reason: 'ambiguous' })
    return
  }
  if (!existing) {
    return
  }
  if (agentChildWorkRunVerdict(ctx, existing, edge.handle.runId) !== 'current') {
    return
  }
  // A reported ending latches. An `unknown` one (an inventory omitted the child before its own
  // terminal frame arrived) learns the outcome that frame reports.
  if (existing.membership === 'settled' && existing.outcome !== 'unknown') {
    return
  }
  settleAgentChildWork(ctx, existing, edge.outcome, edge.observedAt, {
    ...(edge.lastMessage !== undefined ? { lastMessage: edge.lastMessage } : {}),
    ...(edge.totalTokens !== undefined ? { totalTokens: edge.totalTokens } : {})
  })
}

/** A live child's current operation, and nothing else about it. */
function applyOperation(ctx: ReconcileContext, edge: AgentChildWorkOperationEvidence): void {
  const resolution = resolveAgentChildWorkHandle(
    ctx,
    ['task_id', 'thread_id', 'tool_use_id'],
    edge.childId
  )
  const record = resolution?.ambiguous ? null : resolution?.child
  if (!record || record.membership !== 'live' || record.state === 'done' || !record.residency) {
    return
  }
  const { stable, runId } = currentAgentChildWorkAliases(ctx, record)
  if (!stable) {
    return
  }
  applyAgentChildWorkLive(
    ctx,
    {
      handle: { ...stable, ...(runId !== undefined ? { runId } : {}) },
      kind: record.kind,
      residency: record.residency,
      state: record.state,
      stoppable: record.stoppable,
      operation: edge.operation
    },
    edge.observedAt,
    false
  )
}

function applyInventory(ctx: ReconcileContext, edge: AgentChildWorkInventoryEvidence): void {
  const listed = new Set<string>()
  for (const child of edge.children.slice(0, STRUCTURED_CHILD_WORK_MAX_LIVE)) {
    listed.add(child.handle.id)
    applyAgentChildWorkLive(ctx, child, edge.observedAt, true)
  }
  for (const record of ownedStructuredChildWork(ctx)) {
    const stableId = currentAgentChildWorkAliases(ctx, record).stableId
    if (
      record.membership === 'live' &&
      record.residency === edge.residency &&
      (stableId === undefined || !listed.has(stableId))
    ) {
      settleAgentChildWork(ctx, record, 'unknown', edge.observedAt)
    }
  }
}

function settleResidents(ctx: ReconcileContext, residency: 'foreground', observedAt: number): void {
  for (const record of ownedStructuredChildWork(ctx)) {
    if (record.membership === 'live' && record.residency === residency) {
      settleAgentChildWork(ctx, record, 'unknown', observedAt)
    }
  }
}

function removeChildren(ctx: ReconcileContext, childWorkIds: string[]): void {
  if (childWorkIds.length > 0 && ctx.store.applyMutation({ removeChildren: childWorkIds })) {
    ctx.outcome.removed += childWorkIds.length
  }
}

/** Oldest-settled first; a settled child that still owns live work stays so its work keeps an owner. */
function trimSettled(ctx: ReconcileContext): void {
  const owned = ownedStructuredChildWork(ctx)
  const settled = owned.filter((record) => record.membership === 'settled')
  const excess = settled.length - STRUCTURED_CHILD_WORK_MAX_SETTLED
  if (excess <= 0) {
    return
  }
  const owners = new Set(
    owned.flatMap((record) =>
      record.membership === 'live' && record.parentChildWorkId ? [record.parentChildWorkId] : []
    )
  )
  const removable = settled
    .filter((record) => !owners.has(record.childWorkId))
    .sort((a, b) => (a.settledAt ?? a.observedAt) - (b.settledAt ?? b.observedAt))
  removeChildren(
    ctx,
    removable.slice(0, excess).map((record) => record.childWorkId)
  )
}

/** Apply one batch of evidence. The parent must already be held: the store refuses a child whose
 *  parent it does not hold, which keeps a producer from inventing a parent of its own. */
export function reconcileAgentChildWorkEvidence(
  input: AgentChildWorkReconcileInput
): AgentChildWorkReconcileOutcome {
  const ctx: ReconcileContext = {
    ...input,
    outcome: { admitted: 0, settled: 0, removed: 0, rejected: [] }
  }
  for (const edge of input.evidence) {
    if (!Number.isFinite(edge.observedAt) || edge.observedAt < 0) {
      continue
    }
    if (edge.type === 'live') {
      applyAgentChildWorkLive(ctx, edge.child, edge.observedAt, false)
    } else if (edge.type === 'operation') {
      applyOperation(ctx, edge)
    } else if (edge.type === 'ended') {
      applyEnded(ctx, edge)
    } else if (edge.type === 'inventory') {
      applyInventory(ctx, edge)
    } else if (edge.type === 'turn-ended') {
      settleResidents(ctx, 'foreground', edge.observedAt)
    } else {
      removeChildren(
        ctx,
        ownedStructuredChildWork(ctx).map((record) => record.childWorkId)
      )
    }
  }
  trimSettled(ctx)
  return ctx.outcome
}
