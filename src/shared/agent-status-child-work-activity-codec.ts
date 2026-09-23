import {
  AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH,
  AGENT_CHILD_WORK_OPERATION_BASES,
  AGENT_CHILD_WORK_RESIDENCIES,
  type AgentChildWorkInput,
  type AgentChildWorkOperation,
  type AgentChildWorkOperationBasis,
  type AgentChildWorkResidency
} from './agent-status-child-work'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
  isTimestamp
} from './agent-status-child-work-value-guards'

const RESIDENCY_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_RESIDENCIES)
const OPERATION_BASIS_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_OPERATION_BASES)

export type AgentChildWorkActivityFields = Pick<
  AgentChildWorkInput,
  'parentChildWorkId' | 'residency' | 'operation' | 'lastMessage'
>

type AgentChildWorkActivityClock = Pick<
  AgentChildWorkInput,
  'childWorkId' | 'firstObservedAt' | 'observedAt'
>

function isResidency(value: unknown): value is AgentChildWorkResidency {
  return typeof value === 'string' && RESIDENCY_SET.has(value)
}

function isOperationBasis(value: unknown): value is AgentChildWorkOperationBasis {
  return typeof value === 'string' && OPERATION_BASIS_SET.has(value)
}

function parseOperation(
  value: unknown,
  clock: AgentChildWorkActivityClock
): AgentChildWorkOperation | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['toolName', 'basis', 'observedAt'], ['input']) ||
    !isBoundedString(value.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH) ||
    (value.input !== undefined &&
      !isBoundedString(value.input, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)) ||
    !isOperationBasis(value.basis) ||
    !isTimestamp(value.observedAt) ||
    // The record's own clock is the newest evidence for this child, so it bounds the operation's.
    value.observedAt < clock.firstObservedAt ||
    value.observedAt > clock.observedAt
  ) {
    return undefined
  }
  return {
    toolName: value.toolName,
    ...(isBoundedString(value.input, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
      ? { input: value.input }
      : {}),
    basis: value.basis,
    observedAt: value.observedAt
  }
}

/** Descriptive fields drop when malformed and keep the record, which stays true without them.
 *  A dropped owner (including a self-reference) reads as the session's main agent. */
export function parseAgentChildWorkActivityFields(
  value: Record<string, unknown>,
  clock: AgentChildWorkActivityClock
): AgentChildWorkActivityFields {
  const operation = parseOperation(value.operation, clock)
  return {
    ...(isBoundedString(value.parentChildWorkId) && value.parentChildWorkId !== clock.childWorkId
      ? { parentChildWorkId: value.parentChildWorkId }
      : {}),
    ...(isResidency(value.residency) ? { residency: value.residency } : {}),
    ...(operation ? { operation } : {}),
    ...(isBoundedString(value.lastMessage, AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH)
      ? { lastMessage: value.lastMessage }
      : {})
  }
}
