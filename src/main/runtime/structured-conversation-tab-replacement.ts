import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { ConversationReplacement } from '../native-chat/agent-session-wire/structured-conversation-command'

export function replaceConversationInSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  replacement: ConversationReplacement
): RuntimeMobileSessionTabsSnapshot {
  if (snapshot.worktree !== replacement.workspaceId) {
    return snapshot
  }
  const source = snapshot.tabs.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === replacement.sourceSessionId
  )
  if (!source) {
    return snapshot
  }
  // The tab keeps its id and its place; only the conversation behind it moves. A stray tab already
  // published for the replacement session (a republish that raced this) is folded into it.
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    tabs: snapshot.tabs
      .filter(
        (tab) =>
          tab.id === source.id ||
          !(tab.type === 'agent-session' && tab.sessionId === replacement.sessionId)
      )
      .map((tab) =>
        tab.id === source.id
          ? {
              ...tab,
              type: 'agent-session' as const,
              sessionId: replacement.sessionId,
              agent: replacement.agent,
              title: defaultAgentChatLabel(replacement.agent),
              replacesSessionId: replacement.sourceSessionId
            }
          : tab
      )
  }
}
