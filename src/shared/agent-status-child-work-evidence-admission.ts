// One evidence edge about one child, turned into the admission request that records it.

import type {
  AgentChildWorkAdmission,
  AgentChildWorkAdmissionResult,
  AgentChildWorkObservationFields
} from './agent-status-child-work-admission'
import type {
  AgentChildWorkOperation,
  AgentChildWorkOutcome,
  AgentChildWorkRecord
} from './agent-status-child-work'
import type { AgentChildWorkLiveObservation } from './agent-status-child-work-evidence'
import {
  agentChildWorkHandleAliases,
  currentAgentChildWorkAliases,
  isPreviousAgentChildWorkRun,
  ownedStructuredChildWork,
  resolveAgentChildWorkHandle,
  resolveAgentChildWorkOwner,
  STRUCTURED_CHILD_WORK_PROVENANCE,
  type AgentChildWorkEvidenceScope
} from './agent-status-child-work-evidence-resolution'
import { normalizeOptionalField } from './agent-status-field-normalization'

/** Live children admitted per session, sized to the provider trackers' own retention. */
export const STRUCTURED_CHILD_WORK_MAX_LIVE = 256
/** A child's first run, matching the provider roster's first attempt. */
const FIRST_GENERATION = 1
/** The record codec's label bound. */
const CHILD_WORK_LABEL_MAX_LENGTH = 512
const LABEL_SCAN_MAX_LENGTH = CHILD_WORK_LABEL_MAX_LENGTH * 4

export type AgentChildWorkReconcileOutcome = {
  admitted: number
  settled: number
  removed: number
  /** Refusals are facts about one child, never a reason to drop the rest of the evidence. */
  rejected: { handleId: string; reason: string }[]
}

export type AgentChildWorkEvidenceContext = AgentChildWorkEvidenceScope & {
  admission: AgentChildWorkAdmission
  outcome: AgentChildWorkReconcileOutcome
}

function counted(
  ctx: AgentChildWorkEvidenceContext,
  handleId: string,
  result: AgentChildWorkAdmissionResult,
  key: 'admitted' | 'settled'
): void {
  if (result.accepted) {
    ctx.outcome[key] += 1
  } else {
    ctx.outcome.rejected.push({ handleId, reason: result.reason })
  }
}

/** Labels are one-line text: the record codec refuses raw provider text, and a refused label
 *  would cost the child its whole update. */
function childWorkLabel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  let text = ''
  for (const char of value.slice(0, LABEL_SCAN_MAX_LENGTH)) {
    const code = char.charCodeAt(0)
    text += code <= 0x1f || code === 0x7f ? ' ' : char
  }
  return normalizeOptionalField(text, CHILD_WORK_LABEL_MAX_LENGTH)
}

/** An `open` operation ends on its own edge; a `reported` one lasts until the next report. */
function nextOperation(
  reported: AgentChildWorkOperation | null | undefined,
  current: AgentChildWorkOperation | undefined
): AgentChildWorkOperation | undefined {
  if (reported === undefined) {
    return current
  }
  if (reported === null) {
    return current?.basis === 'open' ? undefined : current
  }
  return reported
}

/** Which run a run handle names: the current one (or one the record has no handle for yet), a
 *  run that is already over, or a new one the provider started. */
export function agentChildWorkRunVerdict(
  ctx: AgentChildWorkEvidenceContext,
  existing: AgentChildWorkRecord,
  runId: string | undefined
): 'current' | 'previous' | 'new' {
  const current = currentAgentChildWorkAliases(ctx, existing).runId
  if (runId === undefined || runId === current) {
    return 'current'
  }
  if (isPreviousAgentChildWorkRun(ctx, existing, runId)) {
    return 'previous'
  }
  return current === undefined ? 'current' : 'new'
}

/** `prior` is the record when this evidence continues its current run; a new run starts bare. */
function liveFields(
  ctx: AgentChildWorkEvidenceContext,
  child: AgentChildWorkLiveObservation,
  observedAt: number,
  existing: AgentChildWorkRecord | null,
  prior: AgentChildWorkRecord | null
): AgentChildWorkObservationFields {
  // A record's own clock never runs backwards; a host clock that does must not cost the update.
  const at = existing ? Math.max(observedAt, existing.observedAt) : observedAt
  const owner =
    child.ownerId === undefined ? undefined : resolveAgentChildWorkOwner(ctx, child.ownerId)
  const parentChildWorkId = owner ?? existing?.parentChildWorkId
  const name = childWorkLabel(child.name) ?? existing?.name
  const description = childWorkLabel(child.description) ?? existing?.description
  const agentType = childWorkLabel(child.agentType) ?? existing?.agentType
  const totalTokens = child.totalTokens ?? existing?.totalTokens
  const lastMessage = child.lastMessage ?? prior?.lastMessage
  const operation = nextOperation(child.operation, prior?.operation)
  return {
    kind: child.kind,
    state: child.state,
    membership: 'live',
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(existing?.model !== undefined ? { model: existing.model } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(parentChildWorkId !== undefined ? { parentChildWorkId } : {}),
    residency: child.residency,
    ...(operation ? { operation } : {}),
    ...(lastMessage !== undefined ? { lastMessage } : {}),
    observedAt: at,
    stoppable: child.stoppable,
    provenance: STRUCTURED_CHILD_WORK_PROVENANCE
  }
}

export function applyAgentChildWorkLive(
  ctx: AgentChildWorkEvidenceContext,
  child: AgentChildWorkLiveObservation,
  observedAt: number,
  listed: boolean
): void {
  const { handle } = child
  const resolution = resolveAgentChildWorkHandle(ctx, [handle.idKind], handle.id)
  if (!resolution || resolution.ambiguous) {
    ctx.outcome.rejected.push({ handleId: handle.id, reason: resolution ? 'ambiguous' : 'invalid' })
    return
  }
  const existing = resolution.child
  const request = { parent: ctx.parent, provider: ctx.provider }
  const aliases = agentChildWorkHandleAliases(handle)
  if (!existing) {
    const live = ownedStructuredChildWork(ctx).filter((record) => record.membership === 'live')
    if (live.length >= STRUCTURED_CHILD_WORK_MAX_LIVE) {
      ctx.outcome.rejected.push({ handleId: handle.id, reason: 'ingestion-limit' })
      return
    }
    // Bindings with no record left are retired lifetimes: a forgotten session took its children
    // with it. The id is free again, under a generation past the retired one.
    const retired = resolution.highestGeneration
    const fence = {
      invocationId: handle.runId ?? handle.id,
      generation: retired === null ? FIRST_GENERATION : retired + 1
    }
    const result = ctx.admission.announce({
      ...liveFields(ctx, child, observedAt, null, null),
      ...request,
      aliases,
      fence,
      lifetime: retired === null ? 'current' : 'proven-new'
    })
    counted(ctx, handle.id, result, 'admitted')
    return
  }
  const run = agentChildWorkRunVerdict(ctx, existing, handle.runId)
  if (run === 'previous') {
    return
  }
  // A different spawn call for the same child is the provider starting it again; an
  // authoritative inventory listing a settled child is the provider saying it runs again.
  if (run === 'new' || (existing.membership === 'settled' && listed)) {
    const result = ctx.admission.resume({
      // A reclassification lands on the next edge: resume keeps the kind its bindings carry.
      ...liveFields(ctx, { ...child, kind: existing.kind }, observedAt, existing, null),
      ...request,
      childWorkId: existing.childWorkId,
      expectedFence: existing.invocation,
      nextFence: {
        invocationId: handle.runId ?? existing.invocation.invocationId,
        generation: existing.invocation.generation + 1
      },
      aliases
    })
    counted(ctx, handle.id, result, 'admitted')
    return
  }
  if (existing.membership === 'settled') {
    // Late evidence for a run that already ended.
    return
  }
  const fields = { ...liveFields(ctx, child, observedAt, existing, existing), ...request, aliases }
  const result =
    existing.kind !== child.kind
      ? ctx.admission.adopt({
          ...fields,
          childWorkId: existing.childWorkId,
          expectedFence: existing.invocation
        })
      : ctx.admission.announce({ ...fields, fence: existing.invocation, lifetime: 'current' })
  counted(ctx, handle.id, result, 'admitted')
}

export function settleAgentChildWork(
  ctx: AgentChildWorkEvidenceContext,
  existing: AgentChildWorkRecord,
  outcome: AgentChildWorkOutcome,
  observedAt: number,
  reported: { lastMessage?: string; totalTokens?: number } = {}
): void {
  const current = currentAgentChildWorkAliases(ctx, existing)
  const handleId = current.stableId ?? existing.childWorkId
  if (current.aliases.length === 0) {
    ctx.outcome.rejected.push({ handleId, reason: 'unbound-child' })
    return
  }
  const totalTokens = reported.totalTokens ?? existing.totalTokens
  const lastMessage = reported.lastMessage ?? existing.lastMessage
  const result = ctx.admission.announce({
    kind: existing.kind,
    state: 'done',
    membership: 'settled',
    outcome,
    ...(existing.name !== undefined ? { name: existing.name } : {}),
    ...(existing.description !== undefined ? { description: existing.description } : {}),
    ...(existing.agentType !== undefined ? { agentType: existing.agentType } : {}),
    ...(existing.model !== undefined ? { model: existing.model } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(existing.parentChildWorkId !== undefined
      ? { parentChildWorkId: existing.parentChildWorkId }
      : {}),
    ...(existing.residency !== undefined ? { residency: existing.residency } : {}),
    ...(lastMessage !== undefined ? { lastMessage } : {}),
    observedAt: Math.max(observedAt, existing.observedAt),
    stoppable: false,
    provenance: STRUCTURED_CHILD_WORK_PROVENANCE,
    parent: ctx.parent,
    provider: ctx.provider,
    aliases: current.aliases,
    fence: existing.invocation,
    lifetime: 'current'
  })
  counted(ctx, handleId, result, 'settled')
}
