import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

const ready = readFileSync(
  new URL('./__fixtures__/kimi-sessionless-ready.txt', import.meta.url),
  'utf8'
)

async function kimiPane(data = '') {
  return createTranscriptPane({
    paneTitle: 'kimi',
    foregroundProcess: 'kimi',
    launchAgent: 'kimi',
    data
  })
}

async function pendingProbe() {
  const captured = await kimiPane(ready)
  const snapshot = await captured.runtime.readTerminal(captured.handle, { limit: 100 })
  expect(isKnownReadyPromptPreview(snapshot.tail.join('\n'), 'kimi')).toBe(true)

  const { runtime, handle } = await kimiPane()
  let release!: (value: RuntimeTerminalRead) => void
  const read = vi.spyOn(runtime, 'readTerminal').mockImplementation(
    () =>
      new Promise<RuntimeTerminalRead>((resolve) => {
        release = resolve
      })
  )
  const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 200 })
  expect(read).toHaveBeenCalledWith(
    handle,
    {},
    expect.objectContaining({ visibleScreenOnly: true })
  )
  const sendStatus = (state: string) =>
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      `${String.fromCharCode(27)}]9999;${JSON.stringify({ state, agentType: 'kimi' })}${String.fromCharCode(7)}`,
      Date.now()
    )
  const finishRead = (tail = snapshot.tail) =>
    release({ ...snapshot, handle, source: 'screen', tail })
  return { result, sendStatus, finishRead }
}

describe('Kimi status arriving during a visible-screen probe', () => {
  it.each(['working', 'blocked', 'waiting'])(
    'does not settle a stale ready snapshot after %s arrives',
    async (state) => {
      const { result, sendStatus, finishRead } = await pendingProbe()
      const check = expect(result).rejects.toThrow('timeout')
      sendStatus(state)
      finishRead()
      await check
    }
  )

  it('accepts a ready snapshot with no first-party status', async () => {
    const { result, finishRead } = await pendingProbe()
    finishRead()
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('uses the latest status when a working agent finishes during the read', async () => {
    const { result, sendStatus, finishRead } = await pendingProbe()
    sendStatus('working')
    sendStatus('done')
    finishRead()
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('still reports a blocked prompt when first-party status is waiting', async () => {
    const { result, sendStatus, finishRead } = await pendingProbe()
    sendStatus('waiting')
    finishRead(['Do you trust the files in this folder?'])
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })
})
