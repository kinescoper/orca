import { describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES,
  SESSION_TABS_CHAT_TAB_ID_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'
import {
  legacyStructuredAgentSessionTabId,
  projectSessionTabChatIds,
  resolveClientSessionTabId
} from './session-tab-chat-id-projection'
import { projectSessionTabsForClient } from './session-tabs-inventory'

const CAPABLE = [SESSION_TABS_CHAT_TAB_ID_RUNTIME_CAPABILITY]

/** A chat under a host-owned id, a chat whose record was backfilled with the derived spelling, and
 *  a terminal, so the projection has both kinds of chat id and a non-chat to leave alone. */
const SNAPSHOT: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'wt-1',
  publicationEpoch: 'epoch',
  snapshotVersion: 3,
  activeGroupId: 'g1',
  activeTabId: 'tab-owned',
  activeTabType: 'agent-session',
  tabs: [
    {
      type: 'agent-session',
      id: 'tab-owned',
      sessionId: 'codex_new',
      agent: 'codex',
      title: 'Codex Chat',
      isActive: true
    },
    {
      type: 'agent-session',
      id: 'structured-agent-session-codex_old',
      sessionId: 'codex_old',
      agent: 'codex',
      title: 'Codex Chat',
      isActive: false
    },
    {
      type: 'terminal',
      id: 'term-1::leaf-1',
      parentTabId: 'term-1',
      leafId: 'leaf-1',
      ptyId: 'pty-1',
      title: 'Terminal 1',
      isActive: false
    }
  ],
  tabGroups: [
    {
      id: 'g1',
      activeTabId: 'tab-owned',
      tabOrder: ['tab-owned', 'structured-agent-session-codex_old', 'term-1'],
      recentTabIds: ['structured-agent-session-codex_old', 'tab-owned']
    }
  ]
}

describe('publishing a chat tab id to a client', () => {
  it('rewrites every id-bearing field to the legacy spelling for a paired client without the capability', () => {
    const projected = projectSessionTabChatIds(SNAPSHOT, 'mobile', [])

    expect(projected.tabs.map((tab) => tab.id)).toEqual([
      'agent-session:codex_new',
      'agent-session:codex_old',
      'term-1::leaf-1'
    ])
    expect(projected.activeTabId).toBe('agent-session:codex_new')
    expect(projected.tabGroups?.[0]).toEqual({
      id: 'g1',
      activeTabId: 'agent-session:codex_new',
      tabOrder: ['agent-session:codex_new', 'agent-session:codex_old', 'term-1'],
      recentTabIds: ['agent-session:codex_old', 'agent-session:codex_new']
    })
    // Not a mutation of the host's own snapshot.
    expect(SNAPSHOT.activeTabId).toBe('tab-owned')
  })

  it('hands the raw id to a paired client that advertises the capability', () => {
    expect(projectSessionTabChatIds(SNAPSHOT, 'runtime', CAPABLE)).toBe(SNAPSHOT)
  })

  it('hands the raw id to an in-process caller, which reads the host snapshot as its own', () => {
    expect(projectSessionTabChatIds(SNAPSHOT, undefined, undefined)).toBe(SNAPSHOT)
  })

  it('is a host capability, so a client can learn before it stops deriving', () => {
    expect(RUNTIME_CAPABILITIES).toContain(SESSION_TABS_CHAT_TAB_ID_RUNTIME_CAPABILITY)
    expect(SESSION_TABS_CHAT_TAB_ID_RUNTIME_CAPABILITY).toBe('session.tabs.chat-tab-id.v1')
  })
})

describe('the id a client names a chat tab by', () => {
  it('resolves the legacy spelling through the session it names', () => {
    expect(
      resolveClientSessionTabId(SNAPSHOT, legacyStructuredAgentSessionTabId('codex_new'))
    ).toBe('tab-owned')
  })

  it('passes a published id through', () => {
    expect(resolveClientSessionTabId(SNAPSHOT, 'tab-owned')).toBe('tab-owned')
    expect(resolveClientSessionTabId(SNAPSHOT, 'term-1')).toBe('term-1')
  })

  it('leaves an id it cannot place for the caller to refuse', () => {
    expect(resolveClientSessionTabId(SNAPSHOT, 'agent-session:nobody')).toBe('agent-session:nobody')
  })
})

describe('the projection every session.tabs reply goes through', () => {
  it('applies the legacy spelling for a paired client without the capability', () => {
    // A client that renders chats but predates host-owned ids. The list result differs from the
    // snapshot only in how it carries terminals, so the chat tabs alone make a valid one.
    const listed: RuntimeMobileSessionTabsResult = {
      ...SNAPSHOT,
      tabs: SNAPSHOT.tabs.filter((tab) => tab.type === 'agent-session')
    }
    const projected = projectSessionTabsForClient(
      listed,
      'runtime',
      [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ],
      true
    )
    expect(projected.tabs.map((tab) => tab.id)).toContain('agent-session:codex_new')
  })
})
