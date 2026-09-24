import type { RunRow } from '../../types'

type RunCoordinatorActorFields = Pick<
  RunRow,
  'coordinator_actor' | 'coordinator_actor_generation' | 'consumer_generation'
>

/**
 * A Run's coordinator actor counts only at the `consumer_generation` it was written at. Every write
 * that rebinds or unbinds a Run bumps that generation, including one from a binary that predates
 * the actor column, so an actor such a write leaves behind stops counting with nothing to clear it.
 */
export function currentRunCoordinatorActor(run: RunCoordinatorActorFields): string | null {
  return run.coordinator_actor_generation === run.consumer_generation ? run.coordinator_actor : null
}

/** The same rule in SQL, for a `runs` row named `row` (a table name, alias, or `NEW`). */
export function currentRunCoordinatorActorSql(row: string): string {
  return `(CASE WHEN ${row}.coordinator_actor_generation = ${row}.consumer_generation
    THEN ${row}.coordinator_actor END)`
}
