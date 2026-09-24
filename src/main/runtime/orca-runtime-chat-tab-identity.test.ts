import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'wt-chat-identity'

function hostWithRecords(surfaceTabIdBySessionId: Record<string, string>): void {
  const host = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          sessionId in surfaceTabIdBySessionId
            ? { sessionId, surfaceTabId: surfaceTabIdBySessionId[sessionId] }
            : null
      }
    },
    setSessionTabVisibility: async () => {},
    conversationReplacements: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the one read-only accessor the code under test touches; the full host is not constructible here.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('a chat tab under the id its session record holds', () => {
  it('is published under that id, and a legacy spelling still activates and closes it', async () => {
    hostWithRecords({ codex_a: 'tab-from-record' })
    const runtime = new OrcaRuntimeService()
    const focusEditorTab = vi.fn()
    const closeSessionTab = vi.fn(async () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two notifier members this test observes; the rest are never called on this path.
    runtime.setNotifier({ focusEditorTab, closeSessionTab } as never)

    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: 'codex_a',
      agent: 'codex',
      activate: false
    })
    const published = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(published.tabs.map((tab) => tab.id)).toEqual(['tab-from-record'])

    // The renderer names the chat by `agent-session:<sessionId>` until it adopts the host's id.
    await runtime.activateMobileSessionTab(`id:${WORKTREE_ID}`, 'agent-session:codex_a')
    // Resolved to the published tab rather than refused as unknown; the renderer is told about
    // the tab the host holds. (Which spelling the renderer needs is the next change's concern.)
    expect(focusEditorTab).toHaveBeenCalledWith('tab-from-record', WORKTREE_ID)

    const closed = await runtime.closeMobileSessionTab(
      `id:${WORKTREE_ID}`,
      'agent-session:codex_a',
      {
        reason: 'user'
      }
    )
    expect(closed.refused).toBeFalsy()
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('publishes a session with no record here under the spelling clients derived', async () => {
    hostWithRecords({})
    const runtime = new OrcaRuntimeService()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: 'codex_b',
      agent: 'codex',
      activate: false
    })
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs[0]?.id).toBe(
      'structured-agent-session-codex_b'
    )
  })
})
