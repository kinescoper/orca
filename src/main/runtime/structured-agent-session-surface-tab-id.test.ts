import { afterEach, describe, expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { structuredAgentSessionSurfaceTabId } from './structured-agent-session-surface-tab-id'

function hostWithRecords(surfaceTabIdBySessionId: Record<string, string>): void {
  const host = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          sessionId in surfaceTabIdBySessionId
            ? { sessionId, surfaceTabId: surfaceTabIdBySessionId[sessionId] }
            : null
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the one read-only accessor the code under test touches; the full host is not constructible here.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('the tab id a structured chat shows under', () => {
  it('is the id its session record holds', () => {
    hostWithRecords({ codex_a: 'tab-from-record' })
    expect(structuredAgentSessionSurfaceTabId('codex_a')).toBe('tab-from-record')
  })

  it('falls back to the spelling clients derived only for a session with no record here', () => {
    hostWithRecords({})
    expect(structuredAgentSessionSurfaceTabId('codex_b')).toBe('structured-agent-session-codex_b')
    setStructuredAgentSessionHost(null)
    expect(structuredAgentSessionSurfaceTabId('codex_b')).toBe('structured-agent-session-codex_b')
  })
})
