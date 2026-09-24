// The captured Claude cancels (see server-claude-cancel-captures.test.ts) replayed on an SSH pane:
// the hooks go through a real relay-side listener, which owns the provider records, and reach the
// desktop only as relayed payloads. The relay never learns of the cancel the desktop infers from
// Ctrl+C, so everything it restates afterwards still says the main agent is working.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { hookAt, loadCapture, type CapturedHook } from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

type SshPane = {
  relay: RelayAgentHookServer
  /** The desktop the relay forwards to; a desktop restart swaps it. */
  desktop: AgentHookServer
  post: (payload: Record<string, unknown>) => Promise<void>
}

async function startSshPane(desktop: AgentHookServer): Promise<SshPane> {
  const pane: SshPane = {
    desktop,
    relay: new RelayAgentHookServer({
      endpointDir: temporaryDir('orca-relayed-cancel-'),
      token: 'relayed-cancel-token',
      forward: (envelope) => pane.desktop.ingestRemote(envelope, 'conn-1')
    }),
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
  running.push(pane.relay, desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

async function postCaptured(pane: SshPane, hooks: CapturedHook[]): Promise<void> {
  for (const hook of hooks) {
    await pane.post(hook.payload)
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

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

describe('a relayed Claude cancel with a live subagent (captured)', () => {
  const records = loadCapture('claude-cancel-subagent-hooks')
  const upToCancel = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => hookAt(records, index))
  const subagentStop = (index: number): Record<string, unknown> => ({
    ...hookAt(records, index).payload,
    hook_event_name: 'SubagentStop',
    tool_name: undefined,
    tool_input: undefined
  })

  it("keeps the cancel when the child's next hook restates the relay's working main agent", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The child's tool activity after the cancel: the relay's record still has the main agent working.
    const childTool = hookAt(records, 9)
    expect(childTool.payload.agent_id).toBeDefined()
    await pane.post(childTool.payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    // Both children finish on the remote; with nothing left running the cancelled row settles.
    await pane.post(subagentStop(4))
    await pane.post(subagentStop(9))
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
  })

  it("keeps the cancel through a child's permission prompt and its approval", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    const childTool = hookAt(records, 6).payload
    await pane.post({ ...childTool, hook_event_name: 'PermissionRequest' })
    expect(row(pane.desktop)).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    await pane.post(childTool)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('keeps the cancel through a reconnect replay of the relay cache', async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
  })

  it('does not read a restart-seeded local roster for a relayed pane', async () => {
    const userDataPath = temporaryDir('orca-relayed-cancel-restart-')
    const firstDesktop = new AgentHookServer()
    await firstDesktop.start({ env: 'production', userDataPath })
    const pane = await startSshPane(firstDesktop)
    // The main agent Stops with the child running, and the desktop restarts.
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5].map((index) => hookAt(records, index))
    )
    expect(row(firstDesktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
    firstDesktop.flushStatusPersistSync()
    firstDesktop.stop()

    const desktop = new AgentHookServer()
    await desktop.start({ env: 'production', userDataPath })
    pane.desktop = desktop
    running.push(desktop)
    // Hydration seeds the desktop's own roster from the saved row, relayed or not.
    expect(desktop._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE)).toBe(true)

    // The child finishes on the remote, then a new turn starts and is cancelled.
    await pane.post(subagentStop(4))
    expect(row(desktop)).toMatchObject({ state: 'done' })
    await pane.post(hookAt(records, 7).payload)
    expect(row(desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(pressCtrlC(desktop)).toBe(true)

    // Why: nothing runs on the remote; the desktop's seed is not the relay's roster.
    expect(row(desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

describe('a relayed Claude cancel with a background shell (captured)', () => {
  const records = loadCapture('claude-cancel-shell-hooks')

  it('holds the cancel through a replay and releases it at the next prompt', async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5, 6].map((index) => hookAt(records, index))
    )
    expect(pressCtrlC(pane.desktop)).toBe(true)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    // Why: a new turn is the main agent's own fact again; the held verdict must not outlive it.
    await pane.post(hookAt(records, 7).payload)
    expect(row(pane.desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    await pane.post(hookAt(records, 8).payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(pane.desktop).mainAgent).not.toHaveProperty('outcome')
  })
})

describe('a relayed idle-prompt Ctrl+C with a background shell and a background agent (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-bg-agent-hooks')
  const upToCancel = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((index) => hookAt(records, index))

  it("retires the row's agent snapshots and keeps the shell, without a verdict", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The keypress reaches the CLI on the remote host and kills its agents there; the desktop
    // holds only the row, so the row's own snapshots and shell fact are what the retirement reads.
    expect(pressCtrlC(pane.desktop)).toBe(true)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
    expect(row(pane.desktop).interrupted).toBeUndefined()
    expect(row(pane.desktop).mainAgent).not.toHaveProperty('outcome')

    // The relay never learns of the keypress, so a reconnect replay restates the roster it still
    // holds. There is no verdict to latch — the dead child reappears until the next inventory,
    // which is the same re-derivation every roster claim lives under.
    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The next typed turn's Stop carries the relay listener's own corrected inventory.
    await pane.post(hookAt(records, 11).payload)
    await pane.post(hookAt(records, 12).payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
  })

  it('parks a working teammate-shaped snapshot idle instead of dropping it', async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    // A teammate joins after the Stop's inventory (whose fold would otherwise reap the id).
    await pane.post({
      ...hookAt(records, 8).payload,
      agent_id: 'aprobe1-6d3cb5b5',
      agent_type: 'probe1'
    })
    expect(row(pane.desktop).subagents).toHaveLength(2)

    expect(pressCtrlC(pane.desktop)).toBe(true)
    // Why: a teammate's kill is not provable from a snapshot; it parks idle (visible, not
    // gating), while the one-shot the CLI certainly killed leaves the row.
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      subagents: [expect.objectContaining({ id: 'aprobe1-6d3cb5b5', state: 'idle' })],
      mainAgent: { state: 'done' }
    })
  })
})
