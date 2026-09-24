import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The host owns a chat's tab id on its session record. Deriving one from the session id is allowed
 * in exactly the places that translate OLDER state: the record backfill, the helper's fallback for
 * a session with no record, and the two IPC calls that still address the desktop renderer's own
 * derived tab id until it adopts the host's. Anything else is a second spelling coming back.
 */
const ALLOWED = new Set([
  'src/main/runtime/agent-session-record-store-file.ts',
  'src/main/runtime/structured-agent-session-surface-tab-id.ts',
  'src/main/runtime/orca-runtime-get-worktree-ps.ts',
  'src/main/runtime/orca-runtime-refuse-unattributed-mobile-session-tab-close.ts'
])

function shippedSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return shippedSources(path)
    }
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$|test-fixture|test-harness/.test(name)
      ? [path]
      : []
  })
}

describe('chat tab id derivation on the host', () => {
  const root = resolve(__dirname, '..')
  const callers = shippedSources(root)
    .filter((path) => /structuredAgentSessionTabId\(/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(resolve(root, '..', '..'), path))
    .sort()

  it('happens only where older state is translated', () => {
    expect(callers).toEqual([...ALLOWED].sort())
  })

  it('sees the derivation where it is still defined, so an empty scan is real', () => {
    expect(callers.length).toBeGreaterThan(0)
  })
})
