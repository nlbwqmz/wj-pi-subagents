import type {
  AgentController,
  WaitAgentData,
  WaitAgentEventOutcome,
  WaitAgentResult,
  WaitAgentTimeoutData,
} from "./agent-controller.ts";
import {
  WAIT_AGENT_MAX_TARGETS,
  parseWaitAgentInput,
  parseWaitAgentToolInput,
  type WaitAgentInput,
} from "./wait-agent-arguments.ts";
import { controlFailure, type ControlResult } from "./tree-controller.ts";

export interface WaitAgentBatchReleasedData {
  readonly agent_ids: readonly string[];
  readonly outcome: "batch_released";
  readonly released_by_agent_id: string;
  readonly released_by_outcome: WaitAgentEventOutcome;
}

export type WaitAgentToolData = WaitAgentData | WaitAgentTimeoutData | WaitAgentBatchReleasedData;
export type WaitAgentToolResult = ControlResult<WaitAgentToolData>;

interface WaitBatchToolContext {
  readonly sessionManager?: {
    getBranch(): readonly unknown[];
  };
}

interface WaitCallSource {
  readonly id: string;
  readonly arguments: unknown;
}

interface WaitBatchSource {
  readonly batchId: string;
  readonly calls: readonly WaitCallSource[];
}

interface PreparedWaitCall {
  readonly input: WaitAgentInput;
  readonly failure?: WaitAgentToolResult;
}

interface WaitBatchAbortState {
  readonly controller: AbortController;
  readonly listeners: Map<AbortSignal, () => void>;
  settled: boolean;
}

interface WaitBatch {
  readonly batchId: string;
  readonly controller: AgentController;
  readonly calls: ReadonlyMap<string, PreparedWaitCall>;
  readonly expectedCallIds: ReadonlySet<string>;
  readonly enteredCallIds: Set<string>;
  readonly result: Promise<WaitAgentResult>;
  readonly abortState: WaitBatchAbortState;
}

/**
 * 同一 assistant message 内重复 wait_agent 的容错协调器。批次身份来自 Pi
 * SessionManager 中最终持久化的 assistant entry，而不是供应商事件或时间窗口。
 */
export class ParentWaitBatchCoordinator {
  private readonly batches = new Map<string, WaitBatch>();

  async wait(
    controller: AgentController,
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    context: unknown,
  ): Promise<WaitAgentToolResult> {
    const current = parseWaitAgentInput(params);
    if (!current.ok) return controlFailure("invalid_argument", current.issue);
    const currentInput = current.value;
    const source = findWaitBatchSource(context, toolCallId);
    if (source === undefined || source.calls.length < 2) {
      return controller.waitAgents(currentInput, signal);
    }
    if (!canBatchWithinTargetLimit(source)) {
      return controller.waitAgents(currentInput, signal);
    }

    const persistedCall = source.calls.find((call) => call.id === toolCallId);
    const persisted = parseWaitAgentToolInput(persistedCall?.arguments);
    if (!persisted.ok || !sameWaitInput(persisted.value, currentInput)) {
      return controller.waitAgents(currentInput, signal);
    }

    let batch = this.batches.get(source.batchId);
    if (batch === undefined) {
      batch = this.createBatch(controller, source);
      this.batches.set(source.batchId, batch);
    }
    const prepared = batch.calls.get(toolCallId);
    if (
      batch.controller !== controller
      || prepared === undefined
      || !sameWaitInput(prepared.input, currentInput)
    ) {
      return controller.waitAgents(currentInput, signal);
    }

    this.bindAbortSignal(batch, signal);
    batch.enteredCallIds.add(toolCallId);
    try {
      if (prepared.failure !== undefined) return prepared.failure;
      const shared = await batch.result;
      if (!shared.ok) return shared;
      if (shared.data.outcome === "timeout") {
        return Object.freeze({
          ok: true,
          data: Object.freeze({
            agent_ids: prepared.input.agent_ids,
            outcome: "timeout" as const,
          }),
        });
      }
      if (prepared.input.agent_ids.includes(shared.data.agent_id)) return shared;
      return Object.freeze({
        ok: true,
        data: Object.freeze({
          agent_ids: prepared.input.agent_ids,
          outcome: "batch_released",
          released_by_agent_id: shared.data.agent_id,
          released_by_outcome: shared.data.outcome,
        }),
      });
    } finally {
      if (batch.enteredCallIds.size === batch.expectedCallIds.size) {
        this.batches.delete(batch.batchId);
      }
    }
  }

  clear(): void {
    for (const batch of this.batches.values()) this.abortBatch(batch);
    this.batches.clear();
  }

  private createBatch(
    controller: AgentController,
    source: WaitBatchSource,
  ): WaitBatch {
    const calls = new Map<string, PreparedWaitCall>();
    const validInputs: WaitAgentInput[] = [];
    for (const call of source.calls) {
      const parsed = parseWaitAgentToolInput(call.arguments);
      if (!parsed.ok) continue;
      const input = parsed.value;
      let failure: WaitAgentToolResult | undefined;
      for (const agentId of input.agent_ids) {
        try {
          const status = controller.getAgentStatus(agentId);
          if (!status.ok) {
            failure = status;
            break;
          }
        } catch {
          failure = controlFailure("internal_error");
          break;
        }
      }
      calls.set(call.id, Object.freeze({
        input,
        ...(failure === undefined ? {} : { failure }),
      }));
      if (failure === undefined) validInputs.push(input);
    }

    const agentIds = Object.freeze([...new Set(validInputs.flatMap((input) => input.agent_ids))]);
    const timeoutMs = validInputs.length === 0
      ? controller.getWaitTimeoutMs()
      : Math.min(...validInputs.map((input) => input.timeout_ms ?? controller.getWaitTimeoutMs()));
    const abortState: WaitBatchAbortState = {
      controller: new AbortController(),
      listeners: new Map<AbortSignal, () => void>(),
      settled: false,
    };
    const result = agentIds.length === 0
      ? Promise.resolve<WaitAgentResult>(controlFailure("invalid_argument"))
      : controller.waitAgents(
        Object.freeze({ agent_ids: agentIds, timeout_ms: timeoutMs }),
        abortState.controller.signal,
      );
    const batch = Object.freeze({
      batchId: source.batchId,
      controller,
      calls,
      expectedCallIds: new Set(calls.keys()),
      enteredCallIds: new Set<string>(),
      result,
      abortState,
    });
    void result.then(
      () => this.releaseAbortSignals(batch),
      () => this.releaseAbortSignals(batch),
    );
    return batch;
  }

  private bindAbortSignal(batch: WaitBatch, signal: AbortSignal | undefined): void {
    if (signal === undefined || batch.abortState.settled) return;
    if (signal.aborted) {
      batch.abortState.controller.abort();
      return;
    }
    if (batch.abortState.listeners.has(signal)) return;
    const listener = () => batch.abortState.controller.abort();
    batch.abortState.listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  private abortBatch(batch: WaitBatch): void {
    batch.abortState.controller.abort();
    this.releaseAbortSignals(batch);
  }

  private releaseAbortSignals(batch: WaitBatch): void {
    if (batch.abortState.settled) return;
    batch.abortState.settled = true;
    for (const [signal, listener] of batch.abortState.listeners) {
      signal.removeEventListener("abort", listener);
    }
    batch.abortState.listeners.clear();
  }
}

function findWaitBatchSource(context: unknown, currentToolCallId: string): WaitBatchSource | undefined {
  const candidate = readRecord(context) as WaitBatchToolContext | undefined;
  const sessionManager = candidate?.sessionManager;
  if (sessionManager === undefined || typeof sessionManager.getBranch !== "function") return undefined;
  let branch: readonly unknown[];
  try {
    branch = sessionManager.getBranch();
  } catch {
    return undefined;
  }
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = readRecord(branch[index]);
    const message = readRecord(entry?.message);
    if (entry?.type !== "message" || typeof entry.id !== "string" || message?.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    const toolCalls = message.content
      .map(readRecord)
      .filter((block): block is Record<string, unknown> => block?.type === "toolCall");
    if (!toolCalls.some((block) => block.id === currentToolCallId && block.name === "wait_agent")) continue;
    const ids = toolCalls.map((block) => block.id);
    if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) return undefined;
    const calls = toolCalls
      .filter((block) => block.name === "wait_agent")
      .map((block) => Object.freeze({ id: block.id as string, arguments: block.arguments }));
    return Object.freeze({ batchId: entry.id, calls: Object.freeze(calls) });
  }
  return undefined;
}

function canBatchWithinTargetLimit(source: WaitBatchSource): boolean {
  const agentIds = new Set<string>();
  for (const call of source.calls) {
    const parsed = parseWaitAgentToolInput(call.arguments);
    if (!parsed.ok) continue;
    for (const agentId of parsed.value.agent_ids) {
      agentIds.add(agentId);
      if (agentIds.size > WAIT_AGENT_MAX_TARGETS) return false;
    }
  }
  return true;
}

function sameWaitInput(left: WaitAgentInput, right: WaitAgentInput): boolean {
  return left.timeout_ms === right.timeout_ms
    && left.agent_ids.length === right.agent_ids.length
    && left.agent_ids.every((agentId, index) => agentId === right.agent_ids[index]);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
