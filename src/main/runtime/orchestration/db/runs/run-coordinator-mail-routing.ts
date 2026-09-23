import type { OrchestrationDb } from '../orchestration-db'
import { currentRunCoordinatorActorSql } from './run-coordinator-actor'

/**
 * Mail to an address that is also an active Dispatch assignee in the same Run is that worker's
 * mail, not coordinator mail, whether the address is a terminal handle or a session actor.
 */
export function activeDispatchOwnsAddressSql(runIdSql: string, addressSql: string): string {
  return `EXISTS (
    SELECT 1 FROM dispatch_contexts
    WHERE dispatch_contexts.run_id = ${runIdSql}
      AND (dispatch_contexts.assignee_handle = ${addressSql}
        OR dispatch_contexts.assignee_actor = ${addressSql})
      AND dispatch_contexts.status IN ('pending', 'dispatched')
  )`
}

export function rememberRunCoordinatorHandle(
  this: OrchestrationDb,
  runId: string,
  terminalHandle: string
): void {
  this.db
    .prepare(
      `INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)`
    )
    .run(runId, terminalHandle)
}

const CURRENT_COORDINATOR_ADDRESS_SQL = `COALESCE(runs.coordinator_handle, ${currentRunCoordinatorActorSql('runs')})`

// A handle-less structured-session coordinator is remembered by its current actor (migrate-v42).
export function rememberCurrentRunCoordinatorHandles(this: OrchestrationDb): void {
  this.db.exec(`
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    SELECT id, ${CURRENT_COORDINATOR_ADDRESS_SQL} FROM runs
    WHERE legacy = 0 AND ${CURRENT_COORDINATOR_ADDRESS_SQL} IS NOT NULL
  `)
}

export function createCoordinatorMailRoutingTrigger(this: OrchestrationDb): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_messages_route_coordinator_mail;
      CREATE TRIGGER trg_messages_route_coordinator_mail
      AFTER INSERT ON messages
      WHEN NEW.read = 0 AND NEW.delivery_contract = 'current_delivery'
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.id = NEW.run_id AND runs.legacy = 0
        )
        AND EXISTS (
          SELECT 1 FROM run_coordinator_handles
          WHERE run_id = NEW.run_id AND terminal_handle = NEW.to_handle
        )
        AND NOT ${activeDispatchOwnsAddressSql('NEW.run_id', 'NEW.to_handle')}
      BEGIN
        UPDATE messages SET to_handle = 'run:' || NEW.run_id WHERE sequence = NEW.sequence;
      END;
    `)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function routeAllUnreadDirectMessagesToRunMailbox(
  this: OrchestrationDb,
  runId: string,
  directHandle: string
): void {
  this.db
    .prepare(
      `UPDATE messages SET to_handle = ?
       WHERE run_id = ? AND to_handle = ? AND read = 0
         AND delivery_contract = 'current_delivery'
         AND NOT ${activeDispatchOwnsAddressSql('messages.run_id', 'messages.to_handle')}`
    )
    .run(`run:${runId}`, runId, directHandle)
}

export type RunCoordinatorMailRoutingMethods = {
  rememberRunCoordinatorHandle: typeof rememberRunCoordinatorHandle
  rememberCurrentRunCoordinatorHandles: typeof rememberCurrentRunCoordinatorHandles
  createCoordinatorMailRoutingTrigger: typeof createCoordinatorMailRoutingTrigger
  routeAllUnreadDirectMessagesToRunMailbox: typeof routeAllUnreadDirectMessagesToRunMailbox
}

export function attachRunCoordinatorMailRouting(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    rememberRunCoordinatorHandle,
    rememberCurrentRunCoordinatorHandles,
    createCoordinatorMailRoutingTrigger,
    routeAllUnreadDirectMessagesToRunMailbox
  })
}
