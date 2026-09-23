import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string | null
    coordinatorPaneKey: string | null
    /** `session:<id>` when the coordinator is a structured session; see orchestration-actor. */
    coordinatorActor?: string | null
  }
): RunRow {
  const coordinator = {
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey,
    actor: params.coordinatorActor ?? null
  }
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.unbindOtherRunsForCoordinator(coordinator)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key, coordinator_actor,
           consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 0)`
      )
      .run(id, params.objective, coordinator.terminalHandle, coordinator.paneKey, coordinator.actor)
    // A structured worker is addressed by its handle and its session, so both reach this Run.
    for (const address of new Set([coordinator.terminalHandle, coordinator.actor])) {
      if (address) {
        this.rememberRunCoordinatorHandle(id, address)
      }
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
