// A Claude session's frames, through the real adapter, into the host's child records: the order
// the host receives them in, and whether the parent row the records imply is today's row.

import { describe, expect, it } from 'vitest'
import { foldAgentLeadStatus } from '../../shared/agent-lead-status-fold'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { agentChildWorkLiveness } from '../../shared/agent-status-child-work-liveness'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)

let uuid = 0
function frame(fields: Record<string, unknown>): Record<string, unknown> {
  return { session_id: PROVIDER_SESSION_ID, uuid: `frame-${++uuid}`, ...fields }
}
function system(subtype: string, fields: Record<string, unknown>) {
  return frame({ type: 'system', subtype, ...fields })
}
function toolUse(id: string, name: string, input: unknown, parentToolUseId: string | null = null) {
  return frame({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }]
    }
  })
}
function toolResult(toolUseId: string, text: string, parentToolUseId: string | null = null) {
  return frame({
    type: 'user',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }]
    }
  })
}

type Delivery = { kind: 'journal' | 'legacy' | 'evidence'; detail: string }

async function producer() {
  const claude = fakeClaude()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: (() => {
      let minted = 0
      return () => `child-${++minted}`
    })()
  })
  const deliveries: Delivery[] = []
  const evidenceLog: AgentChildWorkEvidence[][] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumed: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {},
    onBackgroundTasksChanged: (_sessionId, state) =>
      deliveries.push({ kind: 'legacy', detail: String(state?.tasks?.length ?? 0) }),
    onChildWorkEvidence: (sessionId, evidence) => {
      expect(sessionId).toBe('session-1')
      deliveries.push({ kind: 'evidence', detail: evidence.map((edge) => edge.type).join(',') })
      evidenceLog.push(evidence)
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
    }
  })
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity) =>
      deliveries.push({ kind: 'journal', detail: JSON.stringify(identity) }),
    appendTombstone: () => {},
    publish: () => {}
  }
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const send = (message: Record<string, unknown>): Delivery[] => {
    const from = deliveries.length
    claude.connections[0]!.handlers.onMessage?.(message)
    return deliveries.slice(from)
  }
  const records = (): AgentChildWorkRecord[] => store.getChildren(parent)
  const byDescription = (description: string) =>
    records().find((record) => record.description === description)
  return { adapter, store, send, records, byDescription, evidenceLog }
}

describe('Claude structured child-work producer', () => {
  it('delivers evidence only after the journal wrote the frame and the legacy row republished', async () => {
    const { send, records } = await producer()
    send(toolUse('toolu_bg', 'Agent', { description: 'Audit the build' }))
    const deliveries = send(
      system('task_started', {
        task_id: 'agent-bg',
        tool_use_id: 'toolu_bg',
        task_type: 'local_agent',
        subagent_type: 'general-purpose',
        description: 'Audit the build',
        is_backgrounded: true
      })
    )
    const kinds = deliveries.map((delivery) => delivery.kind)
    // The frame's own rows, then the parent's republished row, and only then its children.
    expect(kinds.filter((kind) => kind === 'journal').length).toBeGreaterThan(0)
    expect(kinds.slice(kinds.indexOf('legacy'))).toEqual(['legacy', 'evidence'])
    expect(records()).toEqual([
      expect.objectContaining({ description: 'Audit the build', membership: 'live' })
    ])
  })

  it('records the parent state today reads, frame by frame, while adding outcome and activity', async () => {
    const { adapter, send, records, byDescription } = await producer()
    const steps: {
      message: Record<string, unknown>
      lead: 'working' | 'done'
      check?: () => void
    }[] = [
      {
        message: toolUse('toolu_fg', 'Agent', { description: 'Find flaky tests' }),
        lead: 'working'
      },
      {
        message: system('task_started', {
          task_id: 'agent-fg',
          tool_use_id: 'toolu_fg',
          task_type: 'local_agent',
          subagent_type: 'Explore',
          description: 'Find flaky tests',
          is_backgrounded: false
        }),
        lead: 'working'
      },
      // The foreground child starts a background shell of its own.
      {
        message: toolUse(
          'toolu_bash',
          'Bash',
          { command: 'npm test', run_in_background: true },
          'toolu_fg'
        ),
        lead: 'working'
      },
      {
        message: system('task_started', {
          task_id: 'shell-1',
          tool_use_id: 'toolu_bash',
          task_type: 'local_bash',
          description: 'npm test',
          is_backgrounded: true
        }),
        lead: 'working'
      },
      {
        message: system('background_tasks_changed', {
          tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: 'npm test' }]
        }),
        lead: 'working',
        check: () =>
          expect(byDescription('npm test')?.parentChildWorkId).toBe(
            byDescription('Find flaky tests')?.childWorkId
          )
      },
      {
        message: system('task_progress', {
          task_id: 'agent-fg',
          description: 'Running Bash',
          last_tool_name: 'Bash',
          usage: { total_tokens: 1_200, tool_uses: 2, duration_ms: 800 }
        }),
        lead: 'working',
        check: () =>
          expect(byDescription('Find flaky tests')).toMatchObject({
            operation: { toolName: 'Bash', basis: 'reported' },
            totalTokens: 1_200
          })
      },
      {
        message: toolResult('toolu_fg', 'Two tests flake on CI'),
        lead: 'working',
        check: () =>
          expect(byDescription('Find flaky tests')).toMatchObject({
            membership: 'settled',
            outcome: 'succeeded',
            lastMessage: 'Two tests flake on CI'
          })
      },
      {
        message: toolUse('toolu_bg', 'Agent', { description: 'Audit the build' }),
        lead: 'working'
      },
      {
        message: system('task_started', {
          task_id: 'agent-bg',
          tool_use_id: 'toolu_bg',
          task_type: 'local_agent',
          description: 'Audit the build',
          is_backgrounded: true
        }),
        lead: 'working'
      },
      {
        message: system('background_tasks_changed', {
          tasks: [
            { task_id: 'shell-1', task_type: 'local_bash', description: 'npm test' },
            { task_id: 'agent-bg', task_type: 'local_agent', description: 'Audit the build' }
          ]
        }),
        lead: 'working'
      },
      { message: frame({ type: 'result', subtype: 'success', is_error: false }), lead: 'done' },
      // Claude drops a finished task from the roster BEFORE its outcome frame arrives.
      {
        message: system('background_tasks_changed', {
          tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: 'npm test' }]
        }),
        lead: 'done',
        check: () => expect(byDescription('Audit the build')).toMatchObject({ outcome: 'unknown' })
      },
      {
        message: system('task_notification', {
          task_id: 'agent-bg',
          status: 'failed',
          summary: 'Build broke',
          usage: { total_tokens: 900 }
        }),
        lead: 'done',
        check: () =>
          expect(byDescription('Audit the build')).toMatchObject({
            membership: 'settled',
            outcome: 'failed',
            lastMessage: 'Build broke'
          })
      },
      { message: system('background_tasks_changed', { tasks: [] }), lead: 'done' },
      {
        message: system('task_updated', { task_id: 'shell-1', patch: { status: 'killed' } }),
        lead: 'done',
        check: () => expect(byDescription('npm test')).toMatchObject({ outcome: 'cancelled' })
      },
      // Claude resumes a finished background agent by listing it again.
      {
        message: system('background_tasks_changed', {
          tasks: [{ task_id: 'agent-bg', task_type: 'local_agent', description: 'Audit the build' }]
        }),
        lead: 'done',
        check: () =>
          expect(byDescription('Audit the build')).toMatchObject({
            membership: 'live',
            invocation: { generation: 2 },
            previousInvocations: [expect.objectContaining({ outcome: 'failed' })]
          })
      }
    ]
    for (const [index, step] of steps.entries()) {
      send(step.message)
      const legacy = agentChildWorkLiveness(adapter.backgroundTaskState('session-1')?.tasks)
      const recorded = agentChildWorkLiveness(
        records().filter((record) => record.membership === 'live')
      )
      const fold = (childWorkLiveness: typeof legacy) =>
        foldAgentLeadStatus({ leadState: step.lead, interrupted: false, childWorkLiveness })
      expect({ index, parent: fold(recorded) }).toEqual({ index, parent: fold(legacy) })
      if (step.lead === 'done') {
        expect({ index, liveness: recorded }).toEqual({ index, liveness: legacy })
      }
      step.check?.()
    }
    await adapter.closeSession('session-1')
    expect(records()).toEqual([])
    expect(adapter.backgroundTaskState('session-1')).toBeUndefined()
  })
})
