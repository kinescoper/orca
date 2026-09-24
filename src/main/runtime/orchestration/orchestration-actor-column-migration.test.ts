import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import {
  currentRunCoordinatorActor,
  currentRunCoordinatorActorSql
} from './db/runs/run-coordinator-actor'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

const SESSION_ID = '5f0c1d9e-2b7a-4c3e-8f61-0a9d2e7b4c11'
const SESSION_ACTOR = `session:${SESSION_ID}`
const CHAT_SESSION_ACTOR = 'session:9a4e7c1b-3d2f-4b6a-8e5c-7f1d0b2a6c93'
const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const PTY_WORKER_PANE = 'tab_pty:22222222-2222-4222-8222-222222222222'
const NESTED_PANE = 'tab_nested:33333333-3333-4333-8333-333333333333'
const UNCAPPED = Number.MAX_SAFE_INTEGER

// The coordinator-address triggers exactly as main stamped them at v41 and before.
const HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL = `
  CREATE TRIGGER trg_runs_remember_coordinator_insert
  AFTER INSERT ON runs
  WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
  BEGIN
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    VALUES (NEW.id, NEW.coordinator_handle);
  END;
  CREATE TRIGGER trg_runs_remember_coordinator_update
  AFTER UPDATE OF coordinator_handle ON runs
  WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
  BEGIN
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    VALUES (NEW.id, NEW.coordinator_handle);
  END;`

const V41_RUN_COLUMNS =
  'id, objective, home_database, coordinator_handle, coordinator_pane_key, consumer_generation, legacy, created_at, updated_at'

type SeededRows = {
  ptyRunId: string
  structuredRunId: string
  structuredDispatchId: string
  ptyDispatchId: string
  nestedDispatchId: string
  workerHandle: string
}

/** One PTY coordinator with a structured worker and a PTY worker; the structured worker runs a nested Run. */
function seedStructuredAndPtyRows(db: OrchestrationDb): SeededRows {
  const workerHandle = mintStructuredWorkerHandle()
  const workerPane = mintStructuredWorkerPaneKey(SESSION_ID)
  const coordinator = { kind: 'terminal', handle: 'term_coord', paneKey: COORDINATOR_PANE } as const
  const ptyRun = db.createRun({
    objective: 'pty coordinator',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const structuredDispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: ptyRun.id, spec: 'structured worker' }).id,
    assigneeHandle: workerHandle,
    assigneePaneKey: workerPane,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    creator: coordinator,
    maxDepth: UNCAPPED
  })
  const ptyDispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: ptyRun.id, spec: 'pty worker' }).id,
    assigneeHandle: 'term_pty_worker',
    assigneePaneKey: PTY_WORKER_PANE,
    processIncarnation: 'pty_proc_7f3a:4242',
    creator: coordinator,
    maxDepth: UNCAPPED
  })
  const structuredRun = db.createRun({
    objective: 'structured worker coordinates a nested run',
    coordinatorHandle: workerHandle,
    coordinatorPaneKey: workerPane
  })
  const nestedDispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: structuredRun.id, spec: 'nested' }).id,
    assigneeHandle: 'term_nested',
    assigneePaneKey: NESTED_PANE,
    creator: { kind: 'terminal', handle: workerHandle, paneKey: workerPane },
    maxDepth: UNCAPPED
  })
  return {
    ptyRunId: ptyRun.id,
    structuredRunId: structuredRun.id,
    structuredDispatchId: structuredDispatch.id,
    ptyDispatchId: ptyDispatch.id,
    nestedDispatchId: nestedDispatch.id,
    workerHandle
  }
}

/** Strips a current database back to the shape main stamps at v41 and stamps `version`. */
function stripActorSchema(path: string, version: number): void {
  const raw = new Database(path)
  raw.exec(`
    DROP INDEX idx_runs_coordinator_actor;
    DROP INDEX idx_dispatch_assignee_actor;
    DROP TRIGGER trg_runs_remember_coordinator_insert;
    DROP TRIGGER trg_runs_remember_coordinator_update;
    ALTER TABLE runs DROP COLUMN coordinator_actor;
    ALTER TABLE runs DROP COLUMN coordinator_actor_generation;
    ALTER TABLE dispatch_contexts DROP COLUMN assignee_actor;
    ALTER TABLE dispatch_contexts DROP COLUMN creator_actor;
    ${HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL}
  `)
  raw.pragma(`user_version = ${version}`)
  raw.close()
}

function coordinatorTriggerSql(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger'
       AND name IN ('trg_runs_remember_coordinator_insert', 'trg_runs_remember_coordinator_update')
       ORDER BY name`
    )
    .all()
    .map((row) => String(row.sql))
}

function actorColumns(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT name FROM pragma_table_info('runs')
       UNION ALL SELECT name FROM pragma_table_info('dispatch_contexts')`
    )
    .all()
    .map((column) => String(column.name))
    .filter((name) => name.endsWith('_actor'))
    .sort()
}

function coordinatorAddresses(db: Database.Database, runIds: string[]): string[] {
  return db
    .prepare(
      `SELECT run_id, terminal_handle FROM run_coordinator_handles
       WHERE run_id IN (${runIds.map(() => '?').join(', ')})`
    )
    .all(...runIds)
    .map((row) => `${String(row.run_id)} ${String(row.terminal_handle)}`)
    .sort()
}

describe('orchestration actor column migration', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function tempDbPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-actor-column-migration-'))
    tempRoots.push(root)
    return join(root, 'orchestration.db')
  }

  it('starts a v41 database at v41 and gives exactly its structured-worker rows an actor', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripActorSchema(path, 41)

    const probe = new Database(path)
    try {
      // Why: a v42 skew entry registered under v41 makes this 6 and replays the whole chain.
      expect(resolveOrchestrationMigrationStartVersion(probe, 41, SCHEMA_VERSION)).toBe(41)
    } finally {
      probe.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(db.getDispatchContextById(rows.structuredDispatchId)).toMatchObject({
        assignee_actor: SESSION_ACTOR,
        creator_actor: null
      })
      expect(db.getDispatchContextById(rows.ptyDispatchId)).toMatchObject({
        assignee_actor: null,
        creator_actor: null
      })
      expect(db.getDispatchContextById(rows.nestedDispatchId)).toMatchObject({
        assignee_actor: null,
        creator_actor: SESSION_ACTOR
      })
      expect(
        db.db.prepare('SELECT id FROM dispatch_contexts WHERE assignee_actor IS NOT NULL').all()
      ).toEqual([{ id: rows.structuredDispatchId }])
      expect(db.getRunRaw(rows.ptyRunId)?.coordinator_actor).toBeNull()
      expect(db.getRunRaw(rows.structuredRunId)?.coordinator_actor).toBe(SESSION_ACTOR)
      // A handle-bearing coordinator stays remembered by its handle alone, as before v42.
      expect(coordinatorAddresses(db.db, [rows.ptyRunId, rows.structuredRunId])).toEqual(
        [`${rows.ptyRunId} term_coord`, `${rows.structuredRunId} ${rows.workerHandle}`].sort()
      )
      // CREATE TRIGGER IF NOT EXISTS alone would have kept the handle-only form here.
      for (const sql of coordinatorTriggerSql(db.db)) {
        expect(sql).toContain('NEW.coordinator_actor_generation = NEW.consumer_generation')
      }
    } finally {
      db.close()
    }
  })

  it('starts a v40 database at v40 and runs v41 before v42', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripActorSchema(path, 40)
    const raw = new Database(path)
    // The v40 shape of the one object v41 changed: a unique outstanding-delivery index.
    raw.exec(`
      DROP TRIGGER trg_deliveries_one_outstanding;
      DROP VIEW outstanding_deliveries;
      DROP INDEX idx_deliveries_one_outstanding;
      CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
    `)
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 40, SCHEMA_VERSION)).toBe(40)
    } finally {
      raw.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(actorColumns(db.db)).toEqual(['assignee_actor', 'coordinator_actor', 'creator_actor'])
      const index = db.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_deliveries_one_outstanding'")
        .get()
      expect(String(index?.sql)).not.toContain('UNIQUE')
      expect(db.getDispatchContextById(rows.structuredDispatchId)?.assignee_actor).toBe(
        SESSION_ACTOR
      )
      expect(db.getDispatchContextById(rows.ptyDispatchId)?.assignee_actor).toBeNull()
    } finally {
      db.close()
    }
  })

  it('upgrades a database from before the coordinator cache through the static triggers', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripActorSchema(path, 27)
    const raw = new Database(path)
    raw.exec(`
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      DROP TABLE run_coordinator_handles;
    `)
    raw.close()

    // createTables installs its static triggers before this chain's v40 step inserts into runs, so
    // a static form naming coordinator_actor would fail to prepare here.
    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      for (const sql of coordinatorTriggerSql(db.db)) {
        expect(sql).toContain('NEW.coordinator_actor_generation = NEW.consumer_generation')
      }
      expect(db.getRunRaw(rows.structuredRunId)?.coordinator_actor).toBe(SESSION_ACTOR)
      expect(coordinatorAddresses(db.db, [rows.ptyRunId])).toEqual([`${rows.ptyRunId} term_coord`])
    } finally {
      db.close()
    }
  })

  it('lets a v41 binary read and write a v42 database with actors in it', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    const upgraded = new OrchestrationDb(path)
    expect(upgraded.getRunRaw(rows.structuredRunId)?.coordinator_actor).toBe(SESSION_ACTOR)
    upgraded.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_actor, coordinator_actor_generation, consumer_generation, legacy
         ) VALUES ('run_session', 'session coordinator', ?, 1, 1, 0)`
      )
      .run(CHAT_SESSION_ACTOR)
    upgraded.close()

    // A raw connection stands in for the v41 binary; each statement below is v41's own SQL.
    const v41 = new Database(path)
    try {
      // v41's migrate returns early on a newer stamp, so nothing rewrites the v42 objects.
      expect(resolveOrchestrationMigrationStartVersion(v41, SCHEMA_VERSION, 41)).toBe(
        SCHEMA_VERSION
      )
      expect(
        v41.prepare(`SELECT ${V41_RUN_COLUMNS} FROM runs WHERE id = ?`).get('run_session')
      ).toMatchObject({ id: 'run_session', coordinator_handle: null, coordinator_pane_key: null })
      expect(
        v41.prepare(`SELECT ${V41_RUN_COLUMNS} FROM runs WHERE id = ?`).get(rows.ptyRunId)
      ).toMatchObject({ coordinator_handle: 'term_coord', coordinator_pane_key: COORDINATOR_PANE })
      // v41's listRuns reads `SELECT *`; the extra column rides along and every v41 column is intact.
      const listed = v41.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all()
      expect(listed.map((run) => run.id).sort()).toEqual(
        ['run_legacy_local', 'run_session', rows.ptyRunId, rows.structuredRunId].sort()
      )

      // v41's createTables runs these on every open.
      v41.exec(
        HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL.replaceAll(
          'CREATE TRIGGER',
          'CREATE TRIGGER IF NOT EXISTS'
        )
      )
      v41
        .prepare(
          `INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, consumer_generation, legacy)
           VALUES ('run_v41', 'written by v41', 'term_v41', 'tab_v41:44444444-4444-4444-8444-444444444444', 1, 0)`
        )
        .run()
      // An older binary rebinding a structured-coordinated Run cannot clear an actor it cannot see.
      v41
        .prepare(
          `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
             consumer_generation = consumer_generation + 1, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run('term_taker', PTY_WORKER_PANE, rows.structuredRunId)
      v41.exec(`INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT id, coordinator_handle FROM runs WHERE legacy = 0 AND coordinator_handle IS NOT NULL`)

      expect(v41.prepare('SELECT coordinator_actor FROM runs WHERE id = ?').get('run_v41')).toEqual(
        {
          coordinator_actor: null
        }
      )
      expect(
        v41.prepare('SELECT coordinator_actor FROM runs WHERE id = ?').get(rows.structuredRunId)
      ).toEqual({ coordinator_actor: SESSION_ACTOR })
      expect(coordinatorAddresses(v41, ['run_v41', rows.structuredRunId])).toEqual(
        [
          `${rows.structuredRunId} ${rows.workerHandle}`,
          `${rows.structuredRunId} term_taker`,
          'run_v41 term_v41'
        ].sort()
      )
      // The v42 trigger form survives v41's IF NOT EXISTS create.
      for (const sql of coordinatorTriggerSql(v41)) {
        expect(sql).toContain('coordinator_actor')
      }
    } finally {
      v41.close()
    }

    const rolledForward = new OrchestrationDb(path)
    try {
      expect(rolledForward.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(rolledForward.getRun('run_v41')?.coordinator_handle).toBe('term_v41')
      expect(rolledForward.getRunMailboxOwnerIdsForHandle(CHAT_SESSION_ACTOR)).toEqual([
        'run_session'
      ])
      // v41's rebind bumped the generation, so the actor it could not clear no longer counts.
      const rebound = rolledForward.getRunRaw(rows.structuredRunId)
      expect(rebound?.coordinator_actor).toBe(SESSION_ACTOR)
      expect(rebound && currentRunCoordinatorActor(rebound)).toBeNull()
    } finally {
      rolledForward.close()
    }
  })

  it('fills structured-worker rows written after the stamp reached v42 on the next open', () => {
    const path = tempDbPath()
    const first = new OrchestrationDb(path)
    // No writer records an actor yet, which is also the shape a binary rolled back past v42 writes.
    const rows = seedStructuredAndPtyRows(first)
    expect(first.getDispatchContextById(rows.structuredDispatchId)?.assignee_actor).toBeNull()
    first.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(reopened.getDispatchContextById(rows.structuredDispatchId)?.assignee_actor).toBe(
        SESSION_ACTOR
      )
      expect(reopened.getDispatchContextById(rows.nestedDispatchId)?.creator_actor).toBe(
        SESSION_ACTOR
      )
      expect(reopened.getRunRaw(rows.structuredRunId)?.coordinator_actor).toBe(SESSION_ACTOR)
      expect(reopened.getDispatchContextById(rows.ptyDispatchId)?.assignee_actor).toBeNull()
    } finally {
      reopened.close()
    }
  })

  it('drives a dev database stamped v42 with prototype principal columns to add the actors', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    stripActorSchema(path, 41)
    const raw = new Database(path)
    // An unmerged prototype stamped v42 with differently named columns and triggers over them.
    raw.exec(`
      ALTER TABLE runs ADD COLUMN coordinator_principal TEXT;
      ALTER TABLE dispatch_contexts ADD COLUMN assignee_principal TEXT;
      ALTER TABLE dispatch_contexts ADD COLUMN creator_principal TEXT;
      ALTER TABLE worker_terminal_resources ADD COLUMN principal TEXT;
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      CREATE TRIGGER trg_runs_remember_coordinator_insert
      AFTER INSERT ON runs
      WHEN NEW.legacy = 0 AND (NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_principal IS NOT NULL)
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_principal));
      END;
      CREATE TRIGGER trg_runs_remember_coordinator_update
      AFTER UPDATE OF coordinator_handle, coordinator_principal ON runs
      WHEN NEW.legacy = 0 AND (NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_principal IS NOT NULL)
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_principal));
      END;
    `)
    raw.pragma('user_version = 42')
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 42, SCHEMA_VERSION)).toBe(6)
    } finally {
      raw.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(actorColumns(db.db)).toEqual(['assignee_actor', 'coordinator_actor', 'creator_actor'])
      expect(coordinatorTriggerSql(db.db).join('\n')).not.toContain('principal')
      expect(db.getDispatchContextById(rows.structuredDispatchId)?.assignee_actor).toBe(
        SESSION_ACTOR
      )
      expect(() =>
        db.createRun({
          objective: 'after the replay',
          coordinatorHandle: 'term_after',
          coordinatorPaneKey: 'tab_after:55555555-5555-4555-8555-555555555555'
        })
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('stops counting a chat coordinator actor once a v41 binary rebinds and then unbinds the Run', () => {
    const path = tempDbPath()
    const seeded = new OrchestrationDb(path)
    seeded.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_actor, coordinator_actor_generation, consumer_generation, legacy
         ) VALUES ('run_chat', 'chat coordinated', ?, 1, 1, 0)`
      )
      .run(CHAT_SESSION_ACTOR)
    // The cache row this binding wrote; a later open must not be able to write it back.
    seeded.db.prepare('DELETE FROM run_coordinator_handles WHERE run_id = ?').run('run_chat')
    seeded.close()

    // Each statement below is v41's own SQL.
    const v41 = new Database(path)
    // A terminal takes the Run over (bindRun)...
    v41
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run('term_taker', PTY_WORKER_PANE, 'run_chat')
    // ...then claims another Run from the same pane, which unbinds this one (unbindOtherRunsForPane).
    v41
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run('run_chat')
    // Without the generation this row is byte-identical to a live chat binding.
    expect(
      v41
        .prepare(
          `SELECT coordinator_handle, coordinator_pane_key, coordinator_actor, consumer_generation
           FROM runs WHERE id = ?`
        )
        .get('run_chat')
    ).toEqual({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_actor: CHAT_SESSION_ACTOR,
      consumer_generation: 3
    })
    v41.close()

    const reopened = new OrchestrationDb(path)
    try {
      const run = reopened.getRunRaw('run_chat')
      expect(run && currentRunCoordinatorActor(run)).toBeNull()
      expect(
        reopened.db
          .prepare(`SELECT id FROM runs WHERE ${currentRunCoordinatorActorSql('runs')} = ?`)
          .all(CHAT_SESSION_ACTOR)
      ).toEqual([])
      expect(coordinatorAddresses(reopened.db, ['run_chat'])).toEqual(['run_chat term_taker'])
    } finally {
      reopened.close()
    }
  })

  it('replays a database stamped v42 before the coordinator actor carried its generation', () => {
    const path = tempDbPath()
    const seed = new OrchestrationDb(path)
    const rows = seedStructuredAndPtyRows(seed)
    seed.close()
    const raw = new Database(path)
    raw.exec(`
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      ALTER TABLE runs DROP COLUMN coordinator_actor_generation;
      ${HANDLE_ONLY_COORDINATOR_TRIGGERS_SQL}
    `)
    raw.pragma('user_version = 42')
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 42, SCHEMA_VERSION)).toBe(6)
    } finally {
      raw.close()
    }

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      for (const sql of coordinatorTriggerSql(db.db)) {
        expect(sql).toContain('NEW.coordinator_actor_generation = NEW.consumer_generation')
      }
      const run = db.getRunRaw(rows.structuredRunId)
      expect(run && currentRunCoordinatorActor(run)).toBe(SESSION_ACTOR)
    } finally {
      db.close()
    }
  })
})
