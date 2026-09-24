import {
  SESSION_TABS_CHAT_TAB_ID_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'

type SessionTabsPayload = RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot

/** The spelling every client used before the host owned a chat's tab id. */
export function legacyStructuredAgentSessionTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

export function clientReadsChatTabIds(
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): boolean {
  // In-process callers read the host's own snapshot; only a paired client negotiates a spelling.
  return (
    clientKind === undefined ||
    clientCapabilities?.includes(SESSION_TABS_CHAT_TAB_ID_RUNTIME_CAPABILITY) === true
  )
}

/**
 * Publishes a chat tab under the spelling an older paired client expects. Every field that carries
 * a tab id moves together — the tab itself, the active tab, and each group's order, active tab and
 * recency — or the client would hold a group naming a tab it cannot find.
 */
export function projectSessionTabChatIds<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): TPayload {
  if (clientReadsChatTabIds(clientKind, clientCapabilities)) {
    return payload
  }
  const legacyIdByRawId = new Map<string, string>()
  for (const tab of payload.tabs) {
    if (tab.type === 'agent-session') {
      const legacy = legacyStructuredAgentSessionTabId(tab.sessionId)
      if (legacy !== tab.id) {
        legacyIdByRawId.set(tab.id, legacy)
      }
    }
  }
  if (legacyIdByRawId.size === 0) {
    return payload
  }
  const rename = (id: string): string => legacyIdByRawId.get(id) ?? id
  const renameActive = (id: string | null): string | null => (id === null ? null : rename(id))
  return {
    ...payload,
    activeTabId: renameActive(payload.activeTabId),
    tabs: payload.tabs.map((tab) =>
      legacyIdByRawId.has(tab.id) ? { ...tab, id: rename(tab.id) } : tab
    ),
    ...(payload.tabGroups
      ? {
          tabGroups: payload.tabGroups.map((group) => ({
            ...group,
            activeTabId: renameActive(group.activeTabId),
            tabOrder: group.tabOrder.map(rename),
            ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map(rename) } : {})
          }))
        }
      : {})
  }
}

/**
 * The host's own id for a tab a client named. A client that predates host-owned chat tab ids, and
 * the desktop renderer until it adopts them, name a chat by `agent-session:<sessionId>`; the host
 * resolves that through the session it names rather than refusing it. An id the host already
 * publishes passes through, so nothing else changes shape.
 */
export function resolveClientSessionTabId(raw: SessionTabsPayload, tabId: string): string {
  if (raw.tabs.some((tab) => tab.id === tabId)) {
    return tabId
  }
  const match = raw.tabs.find(
    (tab) =>
      tab.type === 'agent-session' && legacyStructuredAgentSessionTabId(tab.sessionId) === tabId
  )
  return match?.id ?? tabId
}
