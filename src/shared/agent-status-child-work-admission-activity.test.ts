import { describe, expect, it, vi } from 'vitest'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import { createAgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'ssh:host-a',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

function observation(
  overrides: Partial<AgentChildWorkAnnounceRequest> = {}
): AgentChildWorkAnnounceRequest {
  return {
    parent,
    provider: 'claude',
    aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
    fence: { invocationId: 'invocation-1', generation: 1 },
    lifetime: 'current',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    observedAt: 10,
    stoppable: true,
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  }
}

function setup() {
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let sequence = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: vi.fn(() => `child-${++sequence}`)
  })
  return { store, admission }
}

describe('child-work admission of what a child is doing', () => {
  it('folds raw provider text to the one-line previews a status row carries', () => {
    const { store, admission } = setup()
    const command = `  npm test\n-- --run ${'x'.repeat(200)}`
    expect(
      admission.announce(
        observation({
          operation: {
            toolName: `mcp__${'long_server_name_'.repeat(5)}tool`,
            input: command,
            basis: 'open',
            observedAt: 10
          },
          lastMessage: 'Line one\n\nLine two'
        })
      )
    ).toMatchObject({ accepted: true })

    const child = store.getChild('child-1')
    expect(child?.operation?.toolName).toHaveLength(60)
    expect(child?.operation?.input?.startsWith('npm test -- --run xxx')).toBe(true)
    expect(child?.operation?.input).toHaveLength(160)
    expect(child?.lastMessage).toBe('Line one Line two')
  })

  it('carries owner and residency through, and clears the operation of a parked child', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    admission.announce(
      observation({
        aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'shell-1' }],
        kind: 'command',
        parentChildWorkId: 'child-1',
        residency: 'background'
      })
    )
    expect(store.getChild('child-2')).toMatchObject({
      parentChildWorkId: 'child-1',
      residency: 'background'
    })

    admission.announce(
      observation({
        state: 'idle',
        observedAt: 12,
        operation: { toolName: 'Bash', basis: 'reported', observedAt: 11 }
      })
    )
    expect(store.getChild('child-1')).toMatchObject({ state: 'idle' })
    expect(store.getChild('child-1')).not.toHaveProperty('operation')
  })
})

describe('child-work identity by provider thread', () => {
  it('keeps one host id for a subagent named by its own thread', () => {
    const { store, admission } = setup()
    const codexChild = observation({
      provider: 'codex',
      aliases: [{ segmentId: 'thread-parent', aliasKind: 'thread_id', alias: 'thread-child' }],
      fence: { invocationId: 'turn-1', generation: 1 },
      residency: 'background'
    })
    expect(admission.announce(codexChild)).toMatchObject({ accepted: true, created: true })
    expect(admission.announce({ ...codexChild, observedAt: 12 })).toMatchObject({
      accepted: true,
      childWorkId: 'child-1',
      created: false
    })
    expect(store.getAliasesForChild('child-1')).toMatchObject([
      { aliasKind: 'thread_id', alias: 'thread-child' }
    ])
  })
})

describe('child-work settlement stamping', () => {
  it('admits a settle that still names an operation, clears it and keeps the last message', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ operation: { toolName: 'Bash', basis: 'open', observedAt: 10 } })
    )

    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          outcome: 'failed',
          observedAt: 20,
          operation: { toolName: 'Bash', basis: 'open', observedAt: 10 },
          lastMessage: 'Exit code 1'
        })
      )
    ).toMatchObject({ accepted: true })
    const child = store.getChild('child-1')
    expect(child).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      settledAt: 20,
      lastMessage: 'Exit code 1'
    })
    expect(child).not.toHaveProperty('operation')
  })

  it('stamps the settle time once and keeps it through later settled evidence', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'succeeded', observedAt: 20 })
    )
    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          outcome: 'succeeded',
          observedAt: 25,
          lastMessage: 'Summary arrived late'
        })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).toMatchObject({ observedAt: 25, settledAt: 20 })
  })

  it('accepts later evidence for an ending first reported without an outcome', () => {
    const { store, admission } = setup()
    admission.announce(observation())
    admission.announce(observation({ state: 'done', membership: 'settled', observedAt: 20 }))
    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          observedAt: 22,
          lastMessage: 'Final words'
        })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).toMatchObject({
      outcome: 'unknown',
      settledAt: 20,
      lastMessage: 'Final words'
    })
  })

  it('stamps a child first seen already settled at that observation', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'cancelled', observedAt: 14 })
    )
    expect(store.getChild('child-1')).toMatchObject({ firstObservedAt: 14, settledAt: 14 })
  })

  it('records when the previous invocation settled, not its newest evidence, on resume', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 20 })
    )
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'failed', observedAt: 25 })
    )

    expect(
      admission.resume({
        ...observation({ observedAt: 30 }),
        childWorkId: 'child-1',
        expectedFence: { invocationId: 'invocation-1', generation: 1 },
        nextFence: { invocationId: 'invocation-2', generation: 2 }
      })
    ).toMatchObject({ accepted: true })
    const child = store.getChild('child-1')
    expect(child?.previousInvocations).toEqual([
      {
        fence: { invocationId: 'invocation-1', generation: 1 },
        outcome: 'failed',
        settledAt: 20
      }
    ])
    expect(child).toMatchObject({ membership: 'live', state: 'working' })
    expect(child).not.toHaveProperty('settledAt')
    expect(child).not.toHaveProperty('outcome')
  })
})
