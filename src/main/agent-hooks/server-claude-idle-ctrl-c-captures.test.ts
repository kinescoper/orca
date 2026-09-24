// A single Ctrl+C at Claude's IDLE prompt is not a turn cancel, but it is not inert either.
// These stories replay hook payloads recorded from Claude Code 2.1.280 over a real PTY
// (src/shared/__fixtures__/claude-idle-ctrl-c-*-hooks.jsonl, sidecars beside them) through the
// server's own HTTP ingress. The captures established that the keypress kills every background
// agent immediately ("All background agents stopped"; the processes died before the next ps),
// fires NO hook of any kind, writes only a session-transcript `system/agents_killed` record that
// names no agent ids, and leaves background shells running. With only a shell running, or after
// the agent already finished, the same keypress does nothing. The rules below are written against
// those payloads, not a remembered screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  loadCapture,
  type CapturedHook,
  type CapturedRecord
} from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  return server
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

async function post(server: AgentHookServer, hook: CapturedHook): Promise<void> {
  await expect(postHookEvent(server, buildBody(hook.payload))).resolves.toMatchObject({
    status: 204
  })
}

/** The renderer's part: capture the row as the baseline and, once the settle window passes with
 *  no hook (the captures show none ever comes), ask the server to infer from the Ctrl+C. */
function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

function transcriptScan(records: CapturedRecord[], label: string) {
  const scan = records.find((record) => record.kind === 'transcript' && record.label === label)
  if (scan?.kind !== 'transcript') {
    throw new Error(`Captured transcript scan ${label} not found`)
  }
  return scan
}

describe('an idle-prompt Ctrl+C with a background shell and a background agent (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-bg-agent-hooks')

  it('retires the agents the CLI killed, keeps the shell monitoring, and adds no verdict', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        await post(server, hookAt(records, index))
      }
      // Both turns settled; the row is held open by the child work their Stops listed.
      expect(hookAt(records, 9).payload.background_tasks).toEqual([
        expect.objectContaining({ type: 'shell', status: 'running', command: 'sleep 600' }),
        expect.objectContaining({ type: 'subagent', status: 'running' })
      ])
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done' },
        subagents: [expect.objectContaining({ id: 'a2303994f3dfae83c', state: 'working' })]
      })
      expect(row(server).workingMode).toBeUndefined()

      // What the capture proved about the keypress itself: the CLI killed the agents at once,
      // painted "All background agents stopped" (never "Interrupted"), fired no hook before the
      // next typed prompt, and recorded agents_killed — with no agent ids — in its transcript.
      const cancel = cancelLabelled(records, 'CTRL-C-idle-with-bg-shell-and-bg-agent')
      expect(cancel.all_bg_agents_stopped_painted).toBe(true)
      expect(cancel.interrupted_painted).toBe(false)
      expect(cancel.hooks_before_next_typed_prompt).toEqual([])
      const killed = transcriptScan(records, 'after-idle-ctrl-c').agents_killed_records
      expect(killed).toHaveLength(1)
      // JSON.parse returns any; the subtype assertion below is the shape proof.
      const killedRecord: Record<string, unknown> = JSON.parse(killed[0])
      expect(killedRecord).toMatchObject({ type: 'system', subtype: 'agents_killed' })
      expect(killedRecord).not.toHaveProperty('agent_id')
      expect(killedRecord).not.toHaveProperty('agent_ids')

      // The inference mirrors the CLI: agents retired, shell kept, the settled main agent's own
      // verdict untouched — no fabricated cancellation, no `interrupted` flag.
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
      expect(row(server).subagents).toBeUndefined()
      expect(row(server).interrupted).toBeUndefined()
      expect(row(server).mainAgent).not.toHaveProperty('outcome')

      // A second Ctrl+C has nothing left to retire (the capture's #2 only armed the quit hint).
      const before = row(server)
      expect(pressCtrlC(server)).toBe(false)
      expect(row(server)).toEqual(before)

      // The next typed turn's Stop restates what the CLI now knows: the shell alone.
      await post(server, hookAt(records, 11))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      const settled = hookAt(records, 12)
      expect(settled.payload.background_tasks).toEqual([
        expect.objectContaining({ type: 'shell', status: 'running' })
      ])
      await post(server, settled)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
      expect(row(server).subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('settles the row to done when the killed agent was the only thing holding it open', async () => {
    // The rig always kept a shell alive, so this story takes the captured turn and removes the
    // shell from its inventories; the agent-only fold is what changes, not the payload shapes.
    const server = await startServer()
    try {
      await post(server, hookAt(records, 0))
      for (const index of [5, 6, 7, 8]) {
        await post(server, hookAt(records, index))
      }
      const stop = hookAt(records, 9)
      const tasks = stop.payload.background_tasks
      if (!Array.isArray(tasks)) {
        throw new Error('captured Stop lost its inventory')
      }
      await post(server, {
        ...stop,
        payload: {
          ...stop.payload,
          background_tasks: tasks.filter(
            (task) =>
              typeof task === 'object' && task !== null && Reflect.get(task, 'type') === 'subagent'
          )
        }
      })
      await post(server, hookAt(records, 10))
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })

      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      expect(row(server).workingMode).toBeUndefined()
      expect(row(server).subagents).toBeUndefined()
      expect(row(server).interrupted).toBeUndefined()
      expect(row(server).mainAgent).not.toHaveProperty('outcome')
    } finally {
      server.stop()
    }
  })
})

describe('an idle-prompt Ctrl+C with only a background shell (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-shell-only-hooks')

  it('changes nothing, because the CLI kills nothing', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4]) {
        await post(server, hookAt(records, index))
      }
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })

      // The capture: no "All background agents stopped", no hook, no agents_killed record, and
      // the shell process survived into the next Stop's inventory.
      const cancel = cancelLabelled(records, 'CTRL-C-idle-with-bg-shell-only')
      expect(cancel.all_bg_agents_stopped_painted).toBe(false)
      expect(cancel.hooks_before_next_typed_prompt).toEqual([])
      expect(transcriptScan(records, 'after-idle-ctrl-c').agents_killed_records).toEqual([])

      const before = row(server)
      expect(pressCtrlC(server)).toBe(false)
      expect(row(server)).toEqual(before)

      await post(server, hookAt(records, 5))
      const settled = hookAt(records, 6)
      expect(settled.payload.background_tasks).toEqual([
        expect.objectContaining({ type: 'shell', status: 'running' })
      ])
      await post(server, settled)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
    } finally {
      server.stop()
    }
  })
})

describe('an idle-prompt Ctrl+C after the background agent already finished (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-finished-agent-hooks')

  it('finds nothing to retire on an already-settled row', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        await post(server, hookAt(records, index))
      }
      // A NATURAL finish, unlike a kill, does announce itself: SubagentStop fires and the CLI
      // injects a task-notification turn whose Stop reports the drained inventory.
      expect(hookAt(records, 8).payload.hook_event_name).toBe('SubagentStop')
      expect(String(hookAt(records, 9).payload.prompt)).toContain('<task-notification>')
      await post(server, hookAt(records, 9))
      const drained = hookAt(records, 10)
      expect(drained.payload).toMatchObject({ hook_event_name: 'Stop', background_tasks: [] })
      await post(server, drained)
      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })

      const cancel = cancelLabelled(records, 'CTRL-C-idle-after-agent-finished')
      expect(cancel.all_bg_agents_stopped_painted).toBe(false)
      expect(cancel.hooks_before_next_typed_prompt).toEqual([])

      const before = row(server)
      expect(pressCtrlC(server)).toBe(false)
      expect(row(server)).toEqual(before)
    } finally {
      server.stop()
    }
  })
})
