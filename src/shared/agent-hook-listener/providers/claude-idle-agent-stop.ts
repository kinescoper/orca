import type {
  AgentMainAgentStatus,
  AgentStatusState,
  AgentSubagentSnapshot,
  AgentWorkingMode
} from '../../agent-status-types'
import { mainAgentTurnInterrupted } from '../../agent-lead-status-fold'
import {
  claudeRosterToSnapshots,
  stopAllWorkingClaudeSubagents
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { claudeMainAgentStatusForPayload, resolveClaudePaneStatus } from './claude-roster-state'

/** The SERVER inferred, from a Ctrl+C at the idle prompt of a LOCAL pane, that Claude stopped its
 *  background agents: measured live, the CLI kills them at once, paints "All background agents
 *  stopped", and emits no hook (claude-idle-ctrl-c-bg-agent fixture). Retire the working roster
 *  entries with SubagentStop semantics and re-fold. The main agent record is untouched — the
 *  keypress ends no turn; that turn already settled with its own verdict — and shells and crons
 *  are never retired: they survive the keypress and leave only when their inventory says so. */
export function markClaudeBackgroundAgentsStopped(
  state: HookListenerState,
  paneKey: string
): {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  mainAgent?: AgentMainAgentStatus
  subagents?: AgentSubagentSnapshot[]
  interrupted?: true
  turnCompletedAt?: number
} {
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (roster) {
    stopAllWorkingClaudeSubagents(roster)
    if (roster.size === 0) {
      state.claudeSubagentRosterByPaneKey.delete(paneKey)
    }
  }
  const record = state.claudeLeadStateByPaneKey.get(paneKey)
  const resolved = resolveClaudePaneStatus(state, paneKey, record ?? { state: 'done' })
  const mainAgent = record ? claudeMainAgentStatusForPayload(record) : undefined
  const subagents = claudeRosterToSnapshots(state.claudeSubagentRosterByPaneKey.get(paneKey))
  return {
    state: resolved.stateName,
    ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
    ...(mainAgent ? { mainAgent } : {}),
    ...(subagents ? { subagents } : {}),
    ...(resolved.stateName === 'done' && mainAgentTurnInterrupted(record)
      ? { interrupted: true as const }
      : {}),
    ...(record?.turnCompletedAt !== undefined ? { turnCompletedAt: record.turnCompletedAt } : {})
  }
}
