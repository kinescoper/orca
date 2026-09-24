import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'
import { settleClaudeExitedSession } from './claude-structured-session-close'
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

/** Publishes an unexpected exit's `ended` event once the retained tree proof has passed, after
 *  persisting the last completed turn; an exit superseded meanwhile only settles its session. */
export function settleClaudeUnexpectedExit(input: {
  sessionId: string
  exit: ClaudeSessionExit
  exits: Map<string, ClaudeSessionExit>
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle' | 'now'>
  emit: (session: ClaudeSession, event: ClaudeStructuredSessionEvent) => void
}): Promise<void> {
  const { sessionId, exit } = input
  exit.settlementPromise ??= (async () => {
    exit.session.unbindReadingControl?.()
    if (input.exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    // Persist the last completed turn before publishing the lifecycle
    // event that lets the host release and reacquire this exact child.
    await persistClaudeSessionHandle(sessionId, exit.session, input.deps).catch(
      (error: unknown) => {
        // Recovery still publishes: the record keeps its last durable point, and the loss is logged.
        console.warn('[claude-resume-point] exit cursor was not persisted:', { sessionId, error })
      }
    )
    if (input.exits.get(sessionId) !== exit) {
      settleClaudeExitedSession(exit.session)
      return
    }
    input.exits.delete(sessionId)
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      sessionId,
      reason: exit.error.message,
      cause: 'unexpected-exit',
      fence: exit.session.fence,
      acquisitionGeneration: exit.session.acquisitionGeneration,
      observedAt: input.deps.now?.() ?? Date.now()
    }
    try {
      input.emit(exit.session, ended)
    } finally {
      settleClaudeExitedSession(exit.session)
    }
  })()
  return exit.settlementPromise
}
