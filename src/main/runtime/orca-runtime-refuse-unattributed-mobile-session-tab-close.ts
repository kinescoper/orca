// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { resolveClientSessionTabId } from './rpc/methods/session-tab-chat-id-projection'
import { SESSION_TAB_NOT_FOUND_ERROR } from '../../shared/session-tab-close'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './orca-runtime-apply-mobile-session-tab-navigation'
import type { RuntimeMobileSessionTabCloseResult } from '../../shared/runtime-types'

export class OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    requestedTabId: string
  ): Promise<RuntimeMobileSessionTabCloseResult> {
    const snapshot = await this.listMobileSessionTabs(worktreeSelector)
    const tabId = resolveClientSessionTabId(snapshot, requestedTabId)
    const tabExists = snapshot.tabs.some(
      (candidate) =>
        candidate.id === tabId ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
        (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
    )
    if (!tabExists) {
      throw new Error('tab_not_found')
    }
    // Why: a legacy client may already have hidden its mirror; a new snapshot
    // restores it without granting an unattributed request destructive authority.
    this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    return {
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    }
  }

  /**
   * Tells the desktop renderer a chat's tab is closed. Addressed by the spelling the renderer
   * derives for its own tab until it adopts the host's id; a renderer that already removed the
   * tab answers not-found, which is an idempotent close rather than a veto.
   */
  protected async notifyRendererStructuredTabClosed(
    sessionId: string,
    worktreeId: string
  ): Promise<void> {
    if (!this.notifier?.closeSessionTab) {
      return
    }
    try {
      await this.notifier.closeSessionTab(structuredAgentSessionTabId(sessionId), worktreeId)
    } catch (error) {
      if (!(error instanceof Error && error.message === SESSION_TAB_NOT_FOUND_ERROR)) {
        throw error
      }
    }
  }
}
