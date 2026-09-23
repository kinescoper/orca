// What a structured provider said about its child work, in the child-work vocabulary.
//
// A producer decodes provider frames into these edges and the host folds them into the one
// record per child it owns. Edges carry facts, not records: which child is live, how one ended,
// which children an authoritative inventory lists. The settlement rules that turn an inventory
// or a turn boundary into endings live with the records, where residency is stored.

import type { AgentChildWorkAliasKind } from './agent-status-child-work-alias'
import type {
  AgentChildWorkKind,
  AgentChildWorkOperation,
  AgentChildWorkOutcome,
  AgentChildWorkResidency,
  AgentChildWorkState
} from './agent-status-child-work'

/** How the provider names one child. `id` is the stable handle today's wire already publishes
 *  (a Claude task id); `runId` names the current run when the provider mints one per run (the
 *  spawn call), and a different one is the provider starting the child again. */
export type AgentChildWorkEvidenceHandle = {
  idKind: Extract<AgentChildWorkAliasKind, 'task_id' | 'thread_id'>
  id: string
  runId?: string
}

/** A child the provider reports live, with every descriptive fact the producer holds for it, so
 *  an edge the host could not admit is healed by the child's next one. */
export type AgentChildWorkLiveObservation = {
  handle: AgentChildWorkEvidenceHandle
  kind: AgentChildWorkKind
  residency: AgentChildWorkResidency
  state: Exclude<AgentChildWorkState, 'done'>
  name?: string
  description?: string
  agentType?: string
  totalTokens?: number
  /** `null`: the operation that was open has ended. Absent: this edge says nothing about it. */
  operation?: AgentChildWorkOperation | null
  lastMessage?: string
  /** Handle id (either alias) of the child that owns this work; absent for the main agent. */
  ownerId?: string
  stoppable: boolean
}

export type AgentChildWorkLiveEvidence = {
  type: 'live'
  observedAt: number
  child: AgentChildWorkLiveObservation
}

/** The child's own terminal frame. `unknown` is an ending whose status the provider did not say. */
export type AgentChildWorkEndedEvidence = {
  type: 'ended'
  observedAt: number
  handle: AgentChildWorkEvidenceHandle
  outcome: AgentChildWorkOutcome
  lastMessage?: string
  totalTokens?: number
}

/** A complete list of the live children of one residency class. A child of that class the host
 *  holds live and the list omits has ended, with an outcome nobody reported. */
export type AgentChildWorkInventoryEvidence = {
  type: 'inventory'
  observedAt: number
  residency: AgentChildWorkResidency
  children: AgentChildWorkLiveObservation[]
}

/** The session's own turn is over: work bound to it can no longer be running. */
export type AgentChildWorkTurnEndedEvidence = { type: 'turn-ended'; observedAt: number }

/** The provider session is gone; its children go with it. */
export type AgentChildWorkSessionEndedEvidence = { type: 'session-ended'; observedAt: number }

export type AgentChildWorkEvidence =
  | AgentChildWorkLiveEvidence
  | AgentChildWorkEndedEvidence
  | AgentChildWorkInventoryEvidence
  | AgentChildWorkTurnEndedEvidence
  | AgentChildWorkSessionEndedEvidence
