import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH,
  agentChildWorkFencesEqual,
  type AgentChildWorkId,
  type AgentChildWorkInput,
  type AgentChildWorkInvocationFence,
  type AgentChildWorkKind,
  type AgentChildWorkOperation,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import { parseAgentChildWorkInput } from './agent-status-child-work-codec'
import { agentChildWorkAllowsOperation } from './agent-status-child-work-legality'
import { normalizeOptionalField } from './agent-status-field-normalization'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import type {
  AgentChildWorkAdmissionResult,
  AgentChildWorkAdoptRequest,
  AgentChildWorkAnnounceRequest,
  AgentChildWorkObservationAlias,
  AgentChildWorkObservationFields
} from './agent-status-child-work-admission'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual, type AgentStatusSubject } from './agent-status-subject'

const MAX_ALIASES_PER_ADMISSION = 32

export function rejectAgentChildWorkAdmission(
  reason: Extract<AgentChildWorkAdmissionResult, { accepted: false }>['reason']
) {
  return { accepted: false, reason } as const
}

export function findAgentChildWork(
  store: AgentStatusStore,
  childWorkId: string
): AgentChildWorkRecord | null {
  return store.getChild(childWorkId)
}

export function agentChildWorkAliasesForChild(
  store: AgentStatusStore,
  childWorkId: string
): AgentChildWorkAliasRecord[] {
  return store.getAliasesForChild(childWorkId)
}

export function buildAgentChildWorkAliases(
  parent: AgentStatusSubject,
  provider: string,
  kind: AgentChildWorkKind,
  aliases: AgentChildWorkObservationAlias[],
  childWorkId: AgentChildWorkId,
  fence: AgentChildWorkInvocationFence
): AgentChildWorkAliasInput[] | null {
  if (aliases.length === 0 || aliases.length > MAX_ALIASES_PER_ADMISSION) {
    return null
  }
  const built: AgentChildWorkAliasInput[] = []
  const keys = new Set<string>()
  try {
    for (const alias of aliases) {
      const candidate = { parent, provider, kind, ...alias, childWorkId, fence }
      const key = serializeAgentChildWorkAliasKey(candidate)
      if (keys.has(key)) {
        return null
      }
      keys.add(key)
      built.push(candidate)
    }
  } catch {
    return null
  }
  return built
}

/** The fields only the host writes: identity, the invocation, and when it settled. */
export type AgentChildWorkHostFields = {
  childWorkId: AgentChildWorkId
  firstObservedAt: number
  invocation: AgentChildWorkInvocationFence
  previousInvocations?: AgentChildWorkInput['previousInvocations']
  settledAt?: number
}

/** Stamped once, when the current invocation first settles; later settled evidence keeps it. */
export function agentChildWorkSettledAt(
  request: Pick<AgentChildWorkObservationFields, 'membership' | 'observedAt'>,
  current?: Pick<AgentChildWorkRecord, 'membership' | 'settledAt'>
): number | undefined {
  if (request.membership !== 'settled') {
    return undefined
  }
  return current?.membership === 'settled' && current.settledAt !== undefined
    ? current.settledAt
    : request.observedAt
}

function admittedOperation(
  request: AgentChildWorkObservationFields,
  firstObservedAt: number
): AgentChildWorkOperation | undefined {
  const operation = request.operation
  if (!operation || !agentChildWorkAllowsOperation(request.membership, request.state)) {
    return undefined
  }
  const toolName = normalizeOptionalField(operation.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
  const input = normalizeOptionalField(operation.input, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  return toolName
    ? {
        toolName,
        ...(input ? { input } : {}),
        basis: operation.basis,
        // A producer may stamp provider time; the host bounds it to the child's evidence window.
        observedAt: Math.min(Math.max(operation.observedAt, firstObservedAt), request.observedAt)
      }
    : undefined
}

export function buildAgentChildWork(
  request: AgentChildWorkObservationFields & {
    parent: AgentStatusSubject
    provider: string
  },
  host: AgentChildWorkHostFields
): AgentChildWorkInput | null {
  const operation = admittedOperation(request, host.firstObservedAt)
  const lastMessage = normalizeOptionalField(
    request.lastMessage,
    AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH
  )
  return parseAgentChildWorkInput({
    childWorkId: host.childWorkId,
    parent: request.parent,
    provider: request.provider,
    kind: request.kind,
    state: request.state,
    membership: request.membership,
    ...(request.outcome !== undefined ? { outcome: request.outcome } : {}),
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.agentType !== undefined ? { agentType: request.agentType } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.totalTokens !== undefined ? { totalTokens: request.totalTokens } : {}),
    ...(request.providerTiming !== undefined ? { providerTiming: request.providerTiming } : {}),
    ...(request.parentChildWorkId !== undefined
      ? { parentChildWorkId: request.parentChildWorkId }
      : {}),
    ...(request.residency !== undefined ? { residency: request.residency } : {}),
    ...(operation ? { operation } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    firstObservedAt: host.firstObservedAt,
    observedAt: request.observedAt,
    ...(host.settledAt !== undefined ? { settledAt: host.settledAt } : {}),
    stoppable: request.stoppable,
    invocation: host.invocation,
    ...(host.previousInvocations !== undefined
      ? { previousInvocations: host.previousInvocations }
      : {}),
    provenance: request.provenance
  })
}

export function commitAgentChildWork(
  store: AgentStatusStore,
  child: AgentChildWorkInput,
  aliases: AgentChildWorkAliasInput[],
  created: boolean,
  removeAliases: string[] = []
): AgentChildWorkAdmissionResult {
  const envelope = store.applyMutation({
    children: [child],
    aliases,
    ...(removeAliases.length > 0 ? { removeAliases } : {})
  })
  return envelope
    ? { accepted: true, childWorkId: child.childWorkId, revision: envelope.revision, created }
    : rejectAgentChildWorkAdmission('store-rejected')
}

/** Settled history only gains precision: an `unknown` ending may become a definite one (a roster
 *  omission can land a tick before the frame naming the outcome); a definite ending never changes,
 *  and a later `unknown` claims nothing about it. An omitted outcome is stored as `unknown`. */
function settledEvidence(
  child: AgentChildWorkRecord,
  request: AgentChildWorkAnnounceRequest | AgentChildWorkAdoptRequest
): 'admit' | 'ignore' | 'conflict' {
  if (request.membership !== 'settled' || request.state !== child.state) {
    return 'conflict'
  }
  const requested = request.outcome ?? 'unknown'
  if (requested === child.outcome || child.outcome === 'unknown') {
    return 'admit'
  }
  return requested === 'unknown' ? 'ignore' : 'conflict'
}

export function updateExistingAgentChildWork(
  store: AgentStatusStore,
  request: AgentChildWorkAnnounceRequest | AgentChildWorkAdoptRequest,
  child: AgentChildWorkRecord,
  aliases: AgentChildWorkAliasInput[],
  removeAliases: string[] = []
): AgentChildWorkAdmissionResult {
  const evidence = child.membership === 'settled' ? settledEvidence(child, request) : 'admit'
  if (evidence === 'conflict') {
    return rejectAgentChildWorkAdmission('stale-invocation')
  }
  if (evidence === 'ignore') {
    return {
      accepted: true,
      childWorkId: child.childWorkId,
      revision: child.revision,
      created: false
    }
  }
  const updated = buildAgentChildWork(request, {
    childWorkId: child.childWorkId,
    firstObservedAt: child.firstObservedAt,
    invocation: child.invocation,
    previousInvocations: child.previousInvocations,
    settledAt: agentChildWorkSettledAt(request, child)
  })
  return updated
    ? commitAgentChildWork(store, updated, aliases, false, removeAliases)
    : rejectAgentChildWorkAdmission('invalid')
}

export function resolveAgentChildWorkAliasRecords(
  store: AgentStatusStore,
  aliases: AgentChildWorkAliasInput[]
): AgentChildWorkAliasRecord[] {
  return store.resolveChildAliases(aliases)
}

export function validateExistingAgentChildWork(
  child: AgentChildWorkRecord | null,
  parent: AgentStatusSubject,
  provider: string,
  expectedFence: AgentChildWorkInvocationFence
): AgentChildWorkAdmissionResult | null {
  if (!child) {
    return rejectAgentChildWorkAdmission('unknown-child')
  }
  if (!agentStatusSubjectsEqual(child.parent, parent) || child.provider !== provider) {
    return rejectAgentChildWorkAdmission('ambiguous')
  }
  if (!agentChildWorkFencesEqual(child.invocation, expectedFence)) {
    return rejectAgentChildWorkAdmission('stale-invocation')
  }
  return null
}
