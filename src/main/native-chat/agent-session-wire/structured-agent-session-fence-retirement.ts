/**
 * Whether a provider child indexed at `childFence` is past its lease. The lease grants a later
 * fence after a release, or over an unreleased lease whose owner probe proved the recorded process
 * dead; either way a fence at or below `releasedFence` no longer owns the session. Neither grant
 * is evidence about the child's own process, so a root not yet seen to exit is never past it.
 */
export function isAgentSessionChildReleasedThroughFence(input: {
  childFence: number
  releasedFence: number
  rootSeenLive: boolean
}): boolean {
  return input.childFence <= input.releasedFence && !input.rootSeenLive
}
