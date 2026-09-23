import type { RunRow } from './types'
import { isEquivalentPaneKey } from './db/pane-key-match'

/**
 * Who an orchestration caller is, as Run binding and mail routing match it.
 *
 * A PTY agent is its terminal: a handle and a pane key, no actor. An agent that is a structured
 * session is its actor (`session:<id>`); a structured worker also has the handle and pane key it
 * was minted, and an ordinary chat has neither. Methods pass this through whole and never branch
 * on which fields are set; the lookups below own that.
 */
export type OrchestrationCallerIdentity = Readonly<{
  /** Mailbox address the caller sends from and reads: its terminal handle, else its actor. */
  address: string
  terminalHandle: string | null
  paneKey: string | null
  actor: string | null
}>

/** The part of a caller a Run binding stores and matches. */
export type OrchestrationCoordinatorKey = Pick<
  OrchestrationCallerIdentity,
  'terminalHandle' | 'paneKey' | 'actor'
>

/** A caller the dispatch entry resolved from the Orca session id in its injected environment. */
export type OrchestrationSessionCaller = OrchestrationCallerIdentity &
  Readonly<{
    actor: string
    sessionId: string
    /** Where the session runs, from its record; `worker-start --worktree current` places here. */
    workspaceId: string
  }>

/** A caller with neither a pane nor an actor can never be bound to a Run. */
export function hasRunBindingKey(caller: OrchestrationCoordinatorKey): boolean {
  return caller.paneKey !== null || caller.actor !== null
}

/**
 * An actor binding counts only while the row's handle is the one that actor binds with: none for a
 * handle-less session, its own handle for a structured worker. Every binary that predates the actor
 * column rewrites `coordinator_handle` whenever it rebinds or unbinds a Run, so an actor it left
 * behind can never satisfy this and is ignored without a cleanup pass.
 */
export function runBoundToCoordinator(run: RunRow, caller: OrchestrationCoordinatorKey): boolean {
  if (
    caller.paneKey !== null &&
    run.coordinator_pane_key !== null &&
    isEquivalentPaneKey(run.coordinator_pane_key, caller.paneKey)
  ) {
    return true
  }
  return (
    caller.actor !== null &&
    run.coordinator_actor === caller.actor &&
    run.coordinator_handle === caller.terminalHandle
  )
}
