import { afterEach, describe, expect, it } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../structured-worker-identity'
import { OrchestrationDb } from '../../db'

const CHAT_X = 'session:1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13'
const CHAT_Y = 'session:6d2a9e41-0c7b-4f38-9a15-b3e8c1d57f20'
const WORKER_SESSION = '9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48'
const WORKER_ACTOR = `session:${WORKER_SESSION}`
const OTHER_WORKER_SESSION = '2e8b4d61-5a3c-4e97-b0f2-7c1d9a6e3b54'
const PTY_PANE = 'tab_pty:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_other:22222222-2222-4222-8222-222222222222'
const UNCAPPED = Number.MAX_SAFE_INTEGER

function chat(actor: string) {
  return { terminalHandle: null, paneKey: null, actor }
}

describe('Run binding by orchestration actor', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  function createChatRun(actor: string, objective = 'chat run') {
    return db.createRun({
      objective,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: actor
    })
  }

  function directMail(runId: string, to: string, subject = 'direct') {
    return db.insertMessage({ from: 'term_sender', to, subject, body: '', runId })
  }

  function structuredWorker(sessionId = WORKER_SESSION) {
    return {
      terminalHandle: mintStructuredWorkerHandle(),
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      actor: `session:${sessionId}`
    }
  }

  // A binary without the actor column: its bindRun and unbindOtherRunsForPane statements.
  function olderBinaryRebind(runId: string, handle: string, paneKey: string) {
    db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(handle, paneKey, runId)
  }

  function olderBinaryUnbind(runId: string) {
    db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(runId)
  }

  /** Unread mail addressed straight to `to`, as a row written before the address was cached. */
  function strayMail(runId: string, to: string) {
    const message = directMail(runId, 'term_late', `to ${to}`)
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(to, message.id)
    return message.id
  }

  it('binds a handle-less session by its actor and remembers the actor as its address', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X)

    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_actor: CHAT_X
    })
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X))?.id).toBe(run.id)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_X)).toEqual([run.id])
    // Mail to the session's address reaches the Run mailbox, as mail to a coordinator handle does.
    expect(directMail(run.id, CHAT_X).to_handle).toBe(`run:${run.id}`)
  })

  it("never unbinds another session's Run, and unbinds only the same session's other Runs", () => {
    db = new OrchestrationDb(':memory:')
    const ptyRun = db.createRun({
      objective: 'pty',
      coordinatorHandle: 'term_pty',
      coordinatorPaneKey: PTY_PANE
    })
    const yRun = createChatRun(CHAT_Y, 'y')
    const xFirst = createChatRun(CHAT_X, 'x first')
    const pending = db.insertMessage({
      from: 'term_sender',
      to: 'term_late',
      subject: 'queued before the rebind',
      body: '',
      runId: xFirst.id
    })
    // Mail addressed to the session that the cache did not reroute on insert, as a pre-cache row.
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(CHAT_X, pending.id)
    const generation = db.getRunRaw(xFirst.id)?.consumer_generation ?? 0

    const xSecond = createChatRun(CHAT_X, 'x second')

    expect(db.getCurrentRunForCoordinator(chat(CHAT_X))?.id).toBe(xSecond.id)
    expect(db.getCurrentRunForCoordinator(chat(CHAT_Y))?.id).toBe(yRun.id)
    expect(db.getRunRaw(yRun.id)?.coordinator_actor).toBe(CHAT_Y)
    expect(db.getRunRaw(ptyRun.id)?.coordinator_pane_key).toBe(PTY_PANE)
    expect(db.getRunRaw(xFirst.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_actor: null,
      consumer_generation: generation + 1
    })
    // Pending coordinator mail follows the Run, as it does when a pane is unbound.
    expect(db.getMessageById(pending.id)?.to_handle).toBe(`run:${xFirst.id}`)
  })

  it('stops counting an actor once a binary without the column rebinds the Run to a terminal', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X)
    olderBinaryRebind(run.id, 'term_taker', PTY_PANE)

    expect(db.getCurrentRunForCoordinator(chat(CHAT_X))).toBeUndefined()
    expect(
      db.getCurrentRunForCoordinator({
        terminalHandle: 'term_taker',
        paneKey: PTY_PANE,
        actor: null
      })?.id
    ).toBe(run.id)
    createChatRun(CHAT_X, 'next')
    expect(db.getRunRaw(run.id)?.coordinator_handle).toBe('term_taker')
  })

  it('does not hand a chat back a Run an older binary rebound and then unbound', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X)
    olderBinaryRebind(run.id, 'term_taker', PTY_PANE)
    olderBinaryUnbind(run.id)

    // Handle and pane are gone and the actor is still there: the shape of a live chat binding.
    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_actor: CHAT_X
    })
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X))).toBeUndefined()
    const next = createChatRun(CHAT_X, 'next')
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X))?.id).toBe(next.id)
  })

  it("stops counting a structured worker's actor once an older binary unbinds its Run", () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorActor: worker.actor
    })
    expect(db.getCurrentRunForCoordinator(worker)?.id).toBe(run.id)
    olderBinaryUnbind(run.id)
    expect(db.getCurrentRunForCoordinator(worker)).toBeUndefined()
    expect(db.getCurrentRunForCoordinator(chat(worker.actor))).toBeUndefined()
  })

  it('remembers a coordinating structured worker at its handle and its session address', () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorActor: worker.actor
    })

    expect(db.getRunMailboxOwnerIdsForHandle(worker.terminalHandle)).toEqual([run.id])
    expect(db.getRunMailboxOwnerIdsForHandle(WORKER_ACTOR)).toEqual([run.id])
    expect(directMail(run.id, WORKER_ACTOR).to_handle).toBe(`run:${run.id}`)
  })

  it('hands a Run to a different session like a terminal takeover: fenced, rerouted, remembered', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X)
    const pending = directMail(run.id, 'term_late')
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(CHAT_X, pending.id)
    const before = db.getRunRaw(run.id)?.consumer_generation ?? 0

    db.bindRun({
      runId: run.id,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: CHAT_Y
    })

    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_actor: CHAT_Y,
      consumer_generation: before + 1
    })
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X))).toBeUndefined()
    expect(db.getCurrentRunForCoordinator(chat(CHAT_Y))?.id).toBe(run.id)
    expect(db.getMessageById(pending.id)?.to_handle).toBe(`run:${run.id}`)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_Y)).toEqual([run.id])
  })

  it('rebinding the same session is not a new consumer, and fills a missing actor in place', () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey
    })
    // As an older binary writes the row: no actor, and no generation for one.
    db.db.prepare('UPDATE runs SET coordinator_actor_generation = NULL WHERE id = ?').run(run.id)
    const before = db.getRunRaw(run.id)?.consumer_generation

    db.bindRun({
      runId: run.id,
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorActor: worker.actor
    })

    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_actor: WORKER_ACTOR,
      consumer_generation: before
    })
    // Written at the current generation, so the filled actor counts on its own.
    expect(db.getCurrentRunForCoordinator(chat(WORKER_ACTOR))?.id).toBe(run.id)
  })

  it("reroutes and remembers both of each worker's addresses when one takes a Run from another", () => {
    db = new OrchestrationDb(':memory:')
    const first = structuredWorker()
    const second = structuredWorker(OTHER_WORKER_SESSION)
    const run = db.createRun({
      objective: 'first worker coordinates',
      coordinatorHandle: first.terminalHandle,
      coordinatorPaneKey: first.paneKey,
      coordinatorActor: first.actor
    })
    const addresses = [first.terminalHandle, first.actor, second.terminalHandle, second.actor]
    const stray = addresses.map((address) => strayMail(run.id, address))

    db.bindRun({
      runId: run.id,
      coordinatorHandle: second.terminalHandle,
      coordinatorPaneKey: second.paneKey,
      coordinatorActor: second.actor
    })

    for (const id of stray) {
      expect(db.getMessageById(id)?.to_handle).toBe(`run:${run.id}`)
    }
    for (const address of addresses) {
      expect(db.getRunMailboxOwnerIdsForHandle(address)).toEqual([run.id])
    }
  })

  it("reroutes both of a worker's addresses when its next Run unbinds the last", () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const bind = {
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorActor: worker.actor
    }
    const last = db.createRun({ objective: 'last', ...bind })
    const stray = [worker.terminalHandle, worker.actor].map((address) =>
      strayMail(last.id, address)
    )

    db.createRun({ objective: 'next', ...bind })

    for (const id of stray) {
      expect(db.getMessageById(id)?.to_handle).toBe(`run:${last.id}`)
    }
  })
})

describe('mail owned by an active Dispatch assignee addressed by its actor', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  /** A structured worker that coordinates its own Run and is also an active assignee in it. */
  function workerCoordinatingItsOwnDispatch() {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(WORKER_SESSION)
    const run = db.createRun({
      objective: 'nested',
      coordinatorHandle: handle,
      coordinatorPaneKey: paneKey,
      coordinatorActor: WORKER_ACTOR
    })
    const dispatch = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'own work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      creator: { kind: 'system' },
      maxDepth: UNCAPPED
    })
    return { run, dispatch, handle }
  }

  it('keeps mail to the session address out of the Run mailbox, as it does for the handle', () => {
    db = new OrchestrationDb(':memory:')
    const { run } = workerCoordinatingItsOwnDispatch()

    expect(
      db.insertMessage({ from: 'term_x', to: WORKER_ACTOR, subject: 's', body: '', runId: run.id })
        .to_handle
    ).toBe(WORKER_ACTOR)
  })

  it('leaves that mail in place when the Run is rebound', () => {
    db = new OrchestrationDb(':memory:')
    const { run } = workerCoordinatingItsOwnDispatch()
    const mail = db.insertMessage({
      from: 'term_x',
      to: WORKER_ACTOR,
      subject: 's',
      body: '',
      runId: run.id
    })

    db.routeAllUnreadDirectMessagesToRunMailbox(run.id, WORKER_ACTOR)

    expect(db.getMessageById(mail.id)?.to_handle).toBe(WORKER_ACTOR)
  })

  it("sweeps the session's stray mail from another Run into its Dispatch mailbox", () => {
    db = new OrchestrationDb(':memory:')
    const { run, dispatch } = workerCoordinatingItsOwnDispatch()
    db.createRun({
      objective: 'elsewhere',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: OTHER_PANE
    })
    const stray = db.insertMessage({
      from: 'term_x',
      to: WORKER_ACTOR,
      subject: 's',
      body: '',
      runId: run.id
    })

    const routed = db.routeForeignDirectMessagesToOwnedMailboxes(WORKER_ACTOR)

    expect(routed.routedCount).toBe(1)
    expect(db.getMessageById(stray.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)
  })
})

describe('stray mail to a session address that is only an assignee', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('sweeps it into the Dispatch mailbox, as stray mail to an assignee handle is', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'pty coordinator',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: OTHER_PANE
    })
    const dispatch = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: mintStructuredWorkerHandle(),
      assigneePaneKey: mintStructuredWorkerPaneKey(WORKER_SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      creator: { kind: 'system' },
      maxDepth: UNCAPPED
    })
    // The worker coordinates nothing, so no address cache entry can claim this mail.
    const stray = db.insertMessage({
      from: 'term_c',
      to: WORKER_ACTOR,
      subject: 's',
      body: '',
      runId: run.id
    })
    expect(db.getMessageById(stray.id)?.to_handle).toBe(WORKER_ACTOR)

    expect(db.routeForeignDirectMessagesToOwnedMailboxes(WORKER_ACTOR).routedCount).toBe(1)
    expect(db.getMessageById(stray.id)?.to_handle).toBe(`dispatch:${dispatch.id}`)
  })
})

describe('Dispatch actors recorded by every writer', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('records the assignee actor from a structured incarnation and a creator actor', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'r',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: CHAT_X
    })
    const handle = mintStructuredWorkerHandle()
    const assigned = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'structured' }).id,
      assigneeHandle: handle,
      assigneePaneKey: mintStructuredWorkerPaneKey(WORKER_SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      creator: { kind: 'actor', actor: CHAT_X },
      maxDepth: UNCAPPED
    })
    const pty = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'pty' }).id,
      assigneeHandle: 'term_pty',
      assigneePaneKey: PTY_PANE,
      processIncarnation: 'pty_proc:1',
      creator: { kind: 'terminal', handle: 'term_c', paneKey: OTHER_PANE },
      maxDepth: UNCAPPED
    })

    expect(assigned).toMatchObject({
      assignee_actor: WORKER_ACTOR,
      creator_handle: null,
      creator_pane_key: null,
      creator_actor: CHAT_X
    })
    expect(pty).toMatchObject({ assignee_actor: null, creator_actor: null })
  })

  it('records the starting creator and the attached assignee of a worker-start', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'r',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: CHAT_X
    })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'actor', actor: CHAT_X },
      maxDepth: UNCAPPED,
      taskSpec: 'work',
      taskRunId: run.id,
      startOptions: {}
    })
    expect(started.dispatch).toMatchObject({ creator_actor: CHAT_X, assignee_actor: null })

    const handle = mintStructuredWorkerHandle()
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey: mintStructuredWorkerPaneKey(WORKER_SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable'
    })

    expect(db.getDispatchContextById(started.dispatch.id)?.assignee_actor).toBe(WORKER_ACTOR)
  })
})
