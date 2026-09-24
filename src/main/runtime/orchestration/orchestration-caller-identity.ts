import type { RunRow } from './types'
import { isEquivalentPaneKey } from './db/pane-key-match'
import { currentRunCoordinatorActor } from './db/runs/run-coordinator-actor'

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
 * Every address one party is reachable at. A structured worker has two, its handle and its session
 * actor, so every consumer that remembers, reroutes or compares a party's mail takes this set.
 */
export function addressSpellingsOf(
  party: Pick<OrchestrationCoordinatorKey, 'terminalHandle' | 'actor'>
): string[] {
  return [...new Set([party.terminalHandle, party.actor])].filter(
    (address): address is string => address !== null
  )
}

/** Who a Run's binding names now; an actor an older binding left behind is not part of it. */
export function runCoordinatorKey(run: RunRow): OrchestrationCoordinatorKey {
  return {
    terminalHandle: run.coordinator_handle,
    paneKey: run.coordinator_pane_key,
    actor: currentRunCoordinatorActor(run)
  }
}

export function runBoundToCoordinator(run: RunRow, caller: OrchestrationCoordinatorKey): boolean {
  if (
    caller.paneKey !== null &&
    run.coordinator_pane_key !== null &&
    isEquivalentPaneKey(run.coordinator_pane_key, caller.paneKey)
  ) {
    return true
  }
  return caller.actor !== null && currentRunCoordinatorActor(run) === caller.actor
}
