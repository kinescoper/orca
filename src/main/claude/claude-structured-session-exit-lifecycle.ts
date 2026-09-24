import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'
import type { ClaudeReleasedChildCleanup } from './claude-released-child-cleanup'
import {
  claudeAcquisitionCleanupError,
  settleClaudeExitedSession
} from './claude-structured-session-close'
import type {
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

/** Wait for each first-hand exit's publication, including exits observed while waiting. */
export async function drainClaudeObservedExits(
  exits: Map<string, ClaudeSessionExit>
): Promise<void> {
  const awaited = new Set<Promise<void>>()
  for (;;) {
    const pending = [...exits.values()]
      .map((exit) => exit.publication)
      .filter(
        (publication): publication is Promise<void> =>
          publication !== undefined && !awaited.has(publication)
      )
    if (pending.length === 0) {
      return
    }
    for (const publication of pending) {
      awaited.add(publication)
    }
    await Promise.all(pending)
  }
}

export async function persistClaudeSessionHandle(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle'>
): Promise<void> {
  const leafUuid = await settledClaudeTurnEndLeaf(session)
  await deps.persistHandle?.({
    sessionId,
    providerSessionId: session.providerSessionId,
    leafUuid,
    fence: session.fence
  })
}

/**
 * Indexes a first-hand exit, then re-enters the provider's close ladder before publishing lifecycle
 * recovery. The lease follows the root, so an observed root exit publishes `ended` even while the
 * tree is unverifiable. A descendant seen alive only defers it: the bounded cleanup re-runs the
 * ladder and publishes on proof, or at give-up with the last verdict reported.
 */
export function retainClaudeUnexpectedExit(input: {
  sessionId: string
  session: ClaudeSession
  error: Error
  exits: Map<string, ClaudeSessionExit>
  cleanup: ClaudeReleasedChildCleanup
  settle: (exit: ClaudeSessionExit) => Promise<void>
}): void {
  const closePromise = input.session.connection.close().catch(() => false)
  const exit: ClaudeSessionExit = {
    connection: input.session.connection,
    session: input.session,
    error: input.error,
    closePromise
  }
  input.exits.set(input.sessionId, exit)
  exit.publication = closePromise
    .then((proven) => {
      if (proven) {
        return input.settle(exit)
      }
      if (
        claudeAcquisitionCleanupError(exit.connection, exit.error) instanceof
        AgentSessionAcquisitionRootExitObservedError
      ) {
        exit.ended = 'published'
        return input.settle(exit)
      }
      const verdict = exit.connection.exitVerdict
      if (verdict.root !== 'exited' || verdict.tree !== 'live') {
        return undefined
      }
      exit.ended = 'withheld'
      input.cleanup.adopt(input.sessionId, exit.connection, (treeProven) => {
        if (!treeProven) {
          exit.ended = 'published'
        }
        void input.settle(exit).catch(() => undefined)
      })
      return undefined
    })
    .catch(() => undefined)
}

/** Persists the last completed turn, then publishes the `ended` the host releases the lease on. */
export function settleClaudeUnexpectedExit(input: {
  sessionId: string
  exit: ClaudeSessionExit
  exits: Map<string, ClaudeSessionExit>
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle' | 'now'>
  emit: (event: ClaudeStructuredSessionEvent) => void
}): Promise<void> {
  const { sessionId, exit, exits } = input
  exit.settlementPromise ??= (async () => {
    exit.session.unbindReadingControl?.()
    if (exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    await persistClaudeSessionHandle(sessionId, exit.session, input.deps).catch(
      (error: unknown) => {
        // Recovery still publishes: the record keeps its last durable point, and the loss is logged.
        console.warn('[claude-resume-point] exit cursor was not persisted:', { sessionId, error })
      }
    )
    if (exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    // Unproven descendants stay indexed as evidence until the host's release retires them.
    if (exit.ended !== 'published') {
      exits.delete(sessionId)
    }
    try {
      input.emit({
        type: 'ended',
        sessionId,
        reason: exit.error.message,
        cause: 'unexpected-exit',
        fence: exit.session.fence,
        acquisitionGeneration: exit.session.acquisitionGeneration,
        observedAt: input.deps.now?.() ?? Date.now()
      })
    } finally {
      settleClaudeExitedSession(exit.session)
    }
  })()
  return exit.settlementPromise
}
