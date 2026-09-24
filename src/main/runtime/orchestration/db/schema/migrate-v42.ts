import type { OrchestrationDb } from '../orchestration-db'
import { currentRunCoordinatorActorSql } from '../runs/run-coordinator-actor'

const ACTOR_COLUMNS = [
  ['runs', 'coordinator_actor', 'TEXT'],
  ['runs', 'coordinator_actor_generation', 'INTEGER'],
  ['dispatch_contexts', 'assignee_actor', 'TEXT'],
  ['dispatch_contexts', 'creator_actor', 'TEXT']
] as const

const NEW_COORDINATOR_ADDRESS_SQL = `COALESCE(NEW.coordinator_handle, ${currentRunCoordinatorActorSql('NEW')})`

/**
 * Orchestration actor columns (`session:<id>`, see orchestration-actor): who a Run's coordinator
 * and a Dispatch's assignee and creator are when that party is a structured session. PTY rows keep
 * NULL and keep their handle and pane-key identity. Existing structured-worker rows get their actor
 * from `backfillStructuredWorkerActors`, which runs after migrate on every open. A coordinator actor
 * carries the consumer generation it was written at and counts only at that generation.
 *
 * Dev databases stamped v42 by an earlier prototype hold `*_principal` columns instead, and ones
 * stamped by an earlier build of this step lack `coordinator_actor_generation`. They are
 * unsupported: the version-skew probe finds a column missing and replays the chain, which adds these
 * columns and leaves the stale ones unread. An actor with no generation never counts.
 */
export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  // Guarded because createTables runs first on every open and already gives a fresh database these.
  for (const [table, column, type] of ACTOR_COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_coordinator_actor
      ON runs(coordinator_actor) WHERE coordinator_actor IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_actor
      ON dispatch_contexts(assignee_actor) WHERE assignee_actor IS NOT NULL;
  `)
  // A handle-less coordinator is remembered by its current actor, which is already a mailbox
  // address, so every reader of this cache matches it unchanged. This step owns the trigger form: the static
  // createTables SQL must stay handle-only (see create-core-tables-sql), and CREATE TRIGGER IF NOT
  // EXISTS never replaces an existing database's triggers, so they are dropped and recreated by name.
  this.db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_insert;
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_update;
    CREATE TRIGGER trg_runs_remember_coordinator_insert
    AFTER INSERT ON runs
    WHEN NEW.legacy = 0 AND ${NEW_COORDINATOR_ADDRESS_SQL} IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
      VALUES (NEW.id, ${NEW_COORDINATOR_ADDRESS_SQL});
    END;
    CREATE TRIGGER trg_runs_remember_coordinator_update
    AFTER UPDATE OF coordinator_handle, coordinator_actor, coordinator_actor_generation ON runs
    WHEN NEW.legacy = 0 AND ${NEW_COORDINATOR_ADDRESS_SQL} IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
      VALUES (NEW.id, ${NEW_COORDINATOR_ADDRESS_SQL});
    END;
  `)
}
