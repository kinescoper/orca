import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

/**
 * The host-owned id of the tab that shows a structured chat: what the snapshot publishes, what the
 * status address and worker keys prefix, and what every client copies.
 *
 * Read from the session record, which every session on this host has. The derived string is the
 * answer only for a session this process holds no record for (a host not yet installed, or a test
 * runtime without one); it is what an older record was backfilled with, so the two never disagree.
 */
export function structuredAgentSessionSurfaceTabId(sessionId: string): string {
  try {
    const recorded = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.surfaceTabId
    if (recorded) {
      return recorded
    }
  } catch {
    // A host mid-teardown answers as if it held no record.
  }
  return structuredAgentSessionTabId(sessionId)
}
