/**
 * Resolves an orchestration caller that names itself by the Orca agent session id in its injected
 * environment. Both dispatchers call this once, before params parse and the unary/streaming split,
 * so it runs ahead of legacy compatibility, receipt lookup and every method. Before parsing, so a
 * session caller need not name itself in a param that requires a caller.
 *
 * The id names the caller; nothing here is a credential. Every agent on this host runs as the same
 * user, so the checks are about getting the identity right, not about keeping anyone out:
 * - Same host only. A paired client, an SSH environment or a WSL shell is another host, where
 *   "same machine, same user" does not hold, so a session claim from one is refused.
 * - The Orca id, never the provider's: that one rotates on `/clear`.
 * - A live lease under either owner (native chat or terminal view), so a handoff keeps the actor.
 * - The session wins over any declared caller: a declared handle must name this same session, and
 *   a structured worker's session id maps to the handle and pane it was minted.
 */
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  formatOrchestrationActor,
  sessionOrchestrationActor
} from '../../../shared/orchestration-actor'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { isRecordedStructuredWorkerActor } from '../orchestration/db/schema/structured-worker-actor-backfill'
import {
  lookupOrcaAgentSession,
  readAgentSessionRecordStore,
  sessionOrchestrationIdentity
} from '../orchestration/structured-session-mail-address'
import { structuredWorkerHostScope } from '../structured-worker-identity'
import type { RpcRequest } from './core'

type CallerParam = 'from' | 'terminal' | 'callerTerminalHandle'

/**
 * Every method that consults caller identity, and the param it names its caller in. This list is
 * the contract: a method that starts reading caller identity is added here with its own test.
 * Methods not listed carry no caller identity for any actor; a session claim on them is still
 * validated, then they run exactly as they do for a terminal caller.
 */
export const ORCHESTRATION_CALLER_PARAM: Readonly<Record<string, CallerParam>> = {
  'orchestration.runCreate': 'from',
  'orchestration.runUse': 'from',
  'orchestration.runCurrent': 'from',
  'orchestration.check': 'terminal',
  'orchestration.send': 'from',
  'orchestration.reply': 'from',
  'orchestration.ask': 'from',
  'orchestration.dispatch': 'from',
  'orchestration.gateCreate': 'from',
  'orchestration.gateResolve': 'from',
  'orchestration.gateList': 'from',
  'orchestration.taskCreate': 'callerTerminalHandle',
  'orchestration.taskList': 'callerTerminalHandle',
  'orchestration.taskUpdate': 'callerTerminalHandle',
  'orchestration.workerStart': 'from'
}

export type OrchestrationRequestRoute = {
  /** Set only by the paired WebSocket route: the request came from another host's client. */
  pairedDeviceId?: string
}

export type ResolvedOrchestrationRequest = {
  /** The request with its declared caller bound to the session and its evidence reduced to it. */
  request: RpcRequest
  caller?: OrchestrationSessionCaller
}

const NO_EFFECTS = { effectsApplied: false } as const

/**
 * Whether this request names its caller by a session id. Checked synchronously so every other
 * request, terminal callers included, reaches its method without an extra async hop.
 */
export function claimsOrchestrationSession(request: RpcRequest): boolean {
  return (
    request.method.startsWith('orchestration.') &&
    request.orchestrationCompatibilityEvidence?.agentSessionId !== undefined
  )
}

/** Only for a request `claimsOrchestrationSession` accepts. Throws the refusal, if any. */
export async function resolveOrchestrationSessionCaller(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  route: OrchestrationRequestRoute | undefined
): Promise<ResolvedOrchestrationRequest> {
  const evidence = request.orchestrationCompatibilityEvidence
  const claimed: unknown = evidence?.agentSessionId
  if (route?.pairedDeviceId !== undefined) {
    throw hostBoundary(
      'This request reached Orca from a paired client, and an agent session id identifies a caller only on the host that runs that session.'
    )
  }
  if (evidence?.host) {
    throw hostBoundary(
      `This command ran in ${evidence.host.kind === 'ssh' ? 'an SSH' : 'a WSL'} environment, and an agent session id identifies a caller only on the host that runs that session.`
    )
  }
  const actor = sessionOrchestrationActor(typeof claimed === 'string' ? claimed : '')
  if (!actor) {
    throw new OrchestrationError(
      CODES.unknown,
      'The caller named an agent session id that is not an Orca session id. No effects were applied.',
      NO_EFFECTS
    )
  }
  const sessionId = actor.id
  const record = await readSessionRecord(runtime, sessionId)
  assertSessionCanAct(sessionId, record)
  const db = runtime.getOrchestrationDb()
  // A cleared chat acts as its conversation (the lineage root's actor), never as its own new id.
  const identity = sessionOrchestrationIdentity(sessionId, db, readAgentSessionRecordStore())
  if (identity.terminalHandle === null && isRecordedStructuredWorkerActor(db.db, identity.actor)) {
    // Why: acting handle-less would split one worker into two identities, and bind like a chat.
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${sessionId} is a structured worker whose worker identity this host no longer has, so it cannot act in orchestration. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const caller: OrchestrationSessionCaller = Object.freeze({
    ...identity,
    sessionId,
    workspaceId: record.location.workspaceId
  })
  return {
    request: {
      ...request,
      params: bindDeclaredCaller(request.method, request.params, caller),
      // Why: the session wins, so terminal evidence inherited from a terminal view never attests.
      orchestrationCompatibilityEvidence: { agentSessionId: sessionId }
    },
    caller
  }
}

async function readSessionRecord(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<AgentSessionRecord> {
  let store: ReturnType<typeof readAgentSessionRecordStore>
  try {
    await runtime.ensureStructuredAgentSessionHost()
    store = readAgentSessionRecordStore()
  } catch {
    store = null
  }
  if (!store) {
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${sessionId} cannot be verified: this Orca is not running its agent-session host. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const found = lookupOrcaAgentSession(store, sessionId)
  if (found.kind === 'found') {
    return found.record
  }
  if (found.kind === 'provider-id') {
    throw new OrchestrationError(
      CODES.providerId,
      `${sessionId} is the provider's own session id, which changes on /clear. This session's Orca id is ${found.orcaSessionId}; use that instead. No effects were applied.`,
      { ...NO_EFFECTS, orcaSessionId: found.orcaSessionId }
    )
  }
  throw new OrchestrationError(
    CODES.unknown,
    `No Orca agent session ${sessionId} exists on this host. No effects were applied.`,
    NO_EFFECTS
  )
}

function assertSessionCanAct(sessionId: string, record: AgentSessionRecord): void {
  if (!structuredWorkerHostScope(record.location)) {
    throw hostBoundary(
      `Agent session ${sessionId} runs on another host, and an agent session id identifies a caller only on the host that runs that session.`
    )
  }
  if (agentSessionLeaseAdmitsWriter(record.lease)) {
    return
  }
  const { lease } = record
  const reason =
    lease.claimStatus === 'released'
      ? // Why not "ended": a released lease is evicted and wakeable; only a running process may act.
        'is not running right now. A new message or user turn revives it; retry then.'
      : lease.handoffStage !== null
        ? 'is switching between chat and terminal view. Retry when the switch finishes.'
        : 'has no live owner on this host right now. Retry once it is running.'
  throw new OrchestrationError(
    CODES.notLive,
    `Agent session ${sessionId} ${reason} No effects were applied.`,
    NO_EFFECTS
  )
}

/** The declared caller, if any, must name this session; it is then replaced by its address. */
function bindDeclaredCaller(
  method: string,
  params: unknown,
  caller: OrchestrationSessionCaller
): unknown {
  const name = ORCHESTRATION_CALLER_PARAM[method]
  if (!name || !params || typeof params !== 'object' || Array.isArray(params)) {
    return params
  }
  const values: Record<string, unknown> = { ...params }
  const declared = values[name]
  const names: unknown[] = [
    caller.address,
    caller.actor,
    caller.sessionId,
    formatOrchestrationActor({ kind: 'session', id: caller.sessionId }),
    caller.terminalHandle
  ]
  if (declared !== undefined && !names.includes(declared)) {
    throw consumerFenced(caller, String(declared))
  }
  // Why: check's restart fallback takes a pane key from the caller; a session has its own or none.
  if (values.terminalPaneKey !== undefined && values.terminalPaneKey !== caller.paneKey) {
    throw consumerFenced(caller, `pane ${String(values.terminalPaneKey)}`)
  }
  values[name] = caller.address
  return values
}

function consumerFenced(caller: OrchestrationSessionCaller, declared: string): OrchestrationError {
  return new OrchestrationError(
    'consumer_fenced',
    `This caller is agent session ${caller.sessionId} and cannot act as ${declared}. No effects were applied.`,
    NO_EFFECTS
  )
}

function hostBoundary(reason: string): OrchestrationError {
  return new OrchestrationError(
    CODES.hostBoundary,
    `${reason} Run the command on that host. No effects were applied.`,
    NO_EFFECTS
  )
}
