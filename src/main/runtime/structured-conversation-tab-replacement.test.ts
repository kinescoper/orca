import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { replaceConversationInSnapshot } from './structured-conversation-tab-replacement'

describe('conversation pane replacement', () => {
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'folder',
    publicationEpoch: 'epoch',
    snapshotVersion: 4,
    activeGroupId: 'right',
    activeTabId: 'old-tab',
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: 'old-tab',
        sessionId: 'old-session',
        agent: 'claude',
        title: 'Old title',
        isActive: true,
        isPinned: true
      }
    ],
    tabGroups: [
      { id: 'right', tabOrder: ['old-tab'], activeTabId: 'old-tab', recentTabIds: ['old-tab'] }
    ]
  }
  const replacement = {
    workspaceId: 'folder',
    sourceSessionId: 'old-session',
    sessionId: 'new-session',
    agent: 'claude' as const
  }
  it('keeps the tab, its group, position, selection and pinning while the conversation behind it moves', () => {
    // The tab id is the host's own and outlives the conversation it shows: read state,
    // notification ids and every client's placement key on it, so a `/clear` must not rename it.
    const result = replaceConversationInSnapshot(snapshot, replacement)
    expect(result).toMatchObject({
      publicationEpoch: 'epoch',
      snapshotVersion: 5,
      activeGroupId: 'right',
      activeTabId: 'old-tab'
    })
    expect(result.tabs[0]).toMatchObject({
      id: 'old-tab',
      sessionId: 'new-session',
      title: 'Claude Chat',
      replacesSessionId: 'old-session',
      isPinned: true
    })
    expect(result.tabGroups?.[0]).toMatchObject({
      tabOrder: ['old-tab'],
      recentTabIds: ['old-tab']
    })
    expect(snapshot.tabs[0]).toMatchObject({ sessionId: 'old-session' })
    expect(replaceConversationInSnapshot(result, replacement)).toBe(result)
  })
  it('folds a tab already published for the replacement session into the kept one', () => {
    const raced: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      tabs: [
        ...snapshot.tabs,
        {
          type: 'agent-session',
          id: 'new-tab',
          sessionId: 'new-session',
          agent: 'claude',
          title: 'Claude Chat',
          isActive: false
        }
      ]
    }
    const result = replaceConversationInSnapshot(raced, replacement)
    expect(result.tabs.map((tab) => tab.id)).toEqual(['old-tab'])
    expect(result.tabs[0]).toMatchObject({ sessionId: 'new-session' })
  })
  it('does not touch another workspace', () => {
    expect(
      replaceConversationInSnapshot(snapshot, { ...replacement, workspaceId: 'elsewhere' })
    ).toBe(snapshot)
  })
})
