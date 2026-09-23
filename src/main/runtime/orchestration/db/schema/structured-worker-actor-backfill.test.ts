import { afterEach, describe, expect, it } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../structured-worker-identity'
import { OrchestrationDb } from '../orchestration-db'
import { backfillStructuredWorkerActors } from './structured-worker-actor-backfill'

const SESSION_A = '0d2f4b6a-8c1e-4a3b-9d5f-7e0a2c4b6d81'
const SESSION_B = '1e3a5c7b-9d2f-4b4c-8e6a-0f1b3d5c7e92'
const SESSION_C = '2f4b6d8c-0e3a-4c5d-9f7b-1a2c4e6d8fa3'
const UNCAPPED = Number.MAX_SAFE_INTEGER
const SYSTEM = { kind: 'system' } as const

describe('structured worker actor backfill', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  function dispatch(params: {
    handle: string
    paneKey: string
    incarnation?: string
    creator?: { kind: 'terminal'; handle: string; paneKey: string }
  }): string {
    const task = db.createTask({ runId: 'run_legacy_local', spec: `work for ${params.handle}` })
    return db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: params.handle,
      assigneePaneKey: params.paneKey,
      processIncarnation: params.incarnation,
      creator: params.creator ?? SYSTEM,
      maxDepth: UNCAPPED
    }).id
  }

  function actors(dispatchId: string): { assignee: string | null; creator: string | null } {
    const row = db.getDispatchContextById(dispatchId)
    return { assignee: row?.assignee_actor ?? null, creator: row?.creator_actor ?? null }
  }

  it('proves a handle through the session this host recorded against it', () => {
    db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const pane = mintStructuredWorkerPaneKey(SESSION_B)
    // The worker's own row carries no incarnation; its terminal resource row does.
    const handleOnly = dispatch({ handle, paneKey: pane })
    db.createWorkerTerminalResourceStatement({
      dispatchId: handleOnly,
      worktreeId: 'wt_1',
      terminalHandle: handle,
      paneKey: pane,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_B),
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      ownership: 'owned'
    })

    backfillStructuredWorkerActors(db.db)

    expect(actors(handleOnly)).toEqual({ assignee: `session:${SESSION_B}`, creator: null })
  })

  it('leaves every row it cannot tie to exactly one valid session NULL', () => {
    db = new OrchestrationDb(':memory:')
    const unrecorded = mintStructuredWorkerHandle()
    const noRecord = dispatch({
      handle: unrecorded,
      paneKey: mintStructuredWorkerPaneKey(SESSION_A)
    })
    const invalidId = dispatch({
      handle: mintStructuredWorkerHandle(),
      paneKey: 'tab_x:44444444-4444-4444-8444-444444444444',
      incarnation: 'structured:not a session id'
    })
    // A terminal in a structured session's tab: the pane key names a session, the process does not.
    const terminalInSessionTab = dispatch({
      handle: 'term_tui',
      paneKey: mintStructuredWorkerPaneKey(SESSION_C),
      incarnation: 'pty_proc_1a2b:777'
    })
    const shared = mintStructuredWorkerHandle()
    const conflicting = dispatch({
      handle: shared,
      paneKey: mintStructuredWorkerPaneKey(SESSION_A),
      incarnation: structuredWorkerProcessIncarnation(SESSION_A)
    })
    db.createWorkerTerminalResourceStatement({
      dispatchId: conflicting,
      worktreeId: 'wt_1',
      terminalHandle: shared,
      paneKey: null,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_B),
      ownership: 'owned'
    })
    // Rows a writer without the actor column left; a current writer records the incarnation's actor.
    db.db.exec('UPDATE dispatch_contexts SET assignee_actor = NULL, creator_actor = NULL')

    backfillStructuredWorkerActors(db.db)

    for (const id of [noRecord, invalidId, terminalInSessionTab, conflicting]) {
      expect(actors(id), id).toEqual({ assignee: null, creator: null })
    }
  })

  it('fills only NULLs and never rewrites an actor a writer recorded', () => {
    db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const id = dispatch({
      handle,
      paneKey: mintStructuredWorkerPaneKey(SESSION_A),
      incarnation: structuredWorkerProcessIncarnation(SESSION_A)
    })
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_actor = ? WHERE id = ?')
      .run(`session:${SESSION_C}`, id)

    backfillStructuredWorkerActors(db.db)

    expect(actors(id).assignee).toBe(`session:${SESSION_C}`)
  })

  it("fills a worker-coordinated Run over an actor an older binding's generation left behind", () => {
    db = new OrchestrationDb(':memory:')
    const runFor = (sessionId: string): string => {
      const handle = mintStructuredWorkerHandle()
      const paneKey = mintStructuredWorkerPaneKey(sessionId)
      dispatch({ handle, paneKey, incarnation: structuredWorkerProcessIncarnation(sessionId) })
      return db.createRun({
        objective: sessionId,
        coordinatorHandle: handle,
        coordinatorPaneKey: paneKey
      }).id
    }
    const stale = runFor(SESSION_A)
    const recorded = runFor(SESSION_B)
    const setActor = db.db.prepare(
      `UPDATE runs SET coordinator_actor = ?, coordinator_actor_generation = consumer_generation - ?
       WHERE id = ?`
    )
    // An older binary rebound this Run to the worker over session C's actor, which it cannot see.
    setActor.run(`session:${SESSION_C}`, 1, stale)
    // A writer recorded this one at the current generation.
    setActor.run(`session:${SESSION_C}`, 0, recorded)

    backfillStructuredWorkerActors(db.db)

    const filled = db.getRunRaw(stale)
    expect(filled?.coordinator_actor).toBe(`session:${SESSION_A}`)
    expect(filled?.coordinator_actor_generation).toBe(filled?.consumer_generation)
    expect(db.getRunRaw(recorded)?.coordinator_actor).toBe(`session:${SESSION_C}`)
  })

  it("clears a worker's actor an older binary's unbind left behind, never a chat's binding", () => {
    db = new OrchestrationDb(':memory:')
    const workerActor = `session:${SESSION_A}`
    const chatActor = `session:${SESSION_B}`
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_A)
    dispatch({ handle, paneKey, incarnation: structuredWorkerProcessIncarnation(SESSION_A) })
    const unbound = db.createRun({
      objective: 'worker coordinated, then unbound by an older binary',
      coordinatorHandle: handle,
      coordinatorPaneKey: paneKey,
      coordinatorActor: workerActor
    })
    const chat = db.createRun({
      objective: 'a chat coordinates',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: chatActor
    })
    // The older binary's pane unbind clears handle and pane and cannot see the actor.
    db.db
      .prepare(
        'UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL WHERE id = ?'
      )
      .run(unbound.id)
    const handleless = (actor: string) => ({ terminalHandle: null, paneKey: null, actor })
    // The residue reads as that session's handle-less binding until it is repaired.
    expect(db.getCurrentRunForCoordinator(handleless(workerActor))?.id).toBe(unbound.id)

    backfillStructuredWorkerActors(db.db)

    expect(db.getRunRaw(unbound.id)?.coordinator_actor).toBeNull()
    expect(db.getCurrentRunForCoordinator(handleless(workerActor))).toBeUndefined()
    expect(db.getRunRaw(chat.id)?.coordinator_actor).toBe(chatActor)
    expect(db.getCurrentRunForCoordinator(handleless(chatActor))?.id).toBe(chat.id)
  })

  it("keeps a worker's actor while its Run still carries its handle", () => {
    db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_A)
    dispatch({ handle, paneKey, incarnation: structuredWorkerProcessIncarnation(SESSION_A) })
    const bound = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: handle,
      coordinatorPaneKey: paneKey,
      coordinatorActor: `session:${SESSION_A}`
    })

    backfillStructuredWorkerActors(db.db)

    expect(db.getRunRaw(bound.id)?.coordinator_actor).toBe(`session:${SESSION_A}`)
  })
})
