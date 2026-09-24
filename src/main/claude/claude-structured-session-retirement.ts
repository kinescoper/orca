import { isAgentSessionChildReleasedThroughFence } from '../native-chat/agent-session-wire/structured-agent-session-fence-retirement'
import type { ClaudeReleasedChildCleanup } from './claude-released-child-cleanup'
import { settleClaudeExitedSession } from './claude-structured-session-close'
import type {
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

export type ClaudeSessionRetirementInput = {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  exits: Map<string, ClaudeSessionExit>
  cleanup: ClaudeReleasedChildCleanup
  onBackgroundTasksChanged?: ClaudeStructuredSessionAdapterDeps['onBackgroundTasksChanged']
}

function retire(input: ClaudeSessionRetirementInput, session: ClaudeSession): void {
  session.unbindReadingControl?.()
  settleClaudeExitedSession(session)
  if (session.backgroundTasks.clear()) {
    input.onBackgroundTasksChanged?.(input.sessionId, null)
  }
  input.cleanup.adopt(input.sessionId, session.connection)
}

/**
 * The host's lease release is the one decision that a child is closed. The session leaves the
 * index here, whatever its tree proof said, and any unproven descendants become cleanup that no
 * acquisition waits on. Returns the retired session so a resume can reuse its provider handle.
 */
export function retireClaudeReleasedSession(
  input: ClaudeSessionRetirementInput
): ClaudeSession | undefined {
  const session = input.sessions.get(input.sessionId)
  if (session) {
    input.sessions.delete(input.sessionId)
    retire(input, session)
  }
  const exit = input.exits.get(input.sessionId)
  if (exit) {
    input.exits.delete(input.sessionId)
    retire(input, exit.session)
  }
  return session ?? exit?.session
}

/**
 * Retires the indexed child only once it is past its lease. Two facts deliver the released fence:
 * an acknowledged release names it, and an acquisition at fence F means F-1 is gone. A stale
 * acknowledgement can never reach a child acquired at a newer fence.
 */
export function retireClaudeSessionReleasedThrough(
  input: ClaudeSessionRetirementInput & { releasedFence: number }
): ClaudeSession | undefined {
  const indexed = input.sessions.get(input.sessionId) ?? input.exits.get(input.sessionId)?.session
  if (
    !indexed ||
    !isAgentSessionChildReleasedThroughFence({
      childFence: indexed.fence,
      releasedFence: input.releasedFence,
      rootSeenLive: indexed.connection.exitVerdict.root === 'live'
    })
  ) {
    return undefined
  }
  return retireClaudeReleasedSession(input)
}
