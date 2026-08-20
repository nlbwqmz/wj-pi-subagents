import assert from "node:assert/strict";
import test from "node:test";
import { AgentController, type AgentSupervisor } from "../src/agent-controller.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
} from "../src/child-reply-envelope.ts";
import { FakeManagedRpcNode } from "../src/managed-rpc-node.ts";
import {
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
  type RpcSupervisorCommandResult,
  type RpcSupervisorEvent,
  type RpcSupervisorInterruptResult,
  type RpcSupervisorStartupResult,
  type RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import type {
  SupervisorEvent,
  SupervisorTaskStarted,
} from "../src/supervisor-channel.ts";
import { ROOT_TREE_ACTOR, TreeController } from "../src/tree-controller.ts";

const TEST_TURN_ID = "91000000-0000-4000-8000-000000000001";
const TEST_COMMIT_ID = "91000000-0000-4000-8000-000000000002";

function interruptedFinal(agentId: string, taskId: string): ChildFinalEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: agentId,
    task_id: taskId,
    turn_id: TEST_TURN_ID,
    commit_id: TEST_COMMIT_ID,
    run_state: "interrupted",
    output_state: "absent",
  };
}

function replyTooLargeFinal(agentId: string, taskId: string): ChildFinalEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: agentId,
    task_id: taskId,
    turn_id: TEST_TURN_ID,
    commit_id: TEST_COMMIT_ID,
    run_state: "settled",
    output_state: "absent",
    reason_code: "reply_too_large",
  };
}

class ReadyChannel implements RpcSupervisorChannel {
  private ready = true;
  private readonly eventListeners = new Set<(event: SupervisorEvent) => void>();
  private readonly taskStartedListeners = new Set<(event: SupervisorTaskStarted) => void>();
  async bind(): Promise<void> {}
  async waitForReady(): Promise<void> {}
  isReady(): boolean { return this.ready; }
  async publishReply(): Promise<void> {}
  async publishTaskAssignmentAndWaitForAck(): Promise<void> {}
  establishTerminationBarrier(): void {}
  async requestClose(): Promise<void> { this.ready = false; }
  async waitForClose(): Promise<RpcSupervisorChannelCloseState> { return "released"; }
  async release(): Promise<void> {}
  onFault(): () => void { return () => {}; }
  onEvent(listener: (event: SupervisorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  emitEvent(event: SupervisorEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
  onTaskStarted(listener: (event: SupervisorTaskStarted) => void): () => void {
    this.taskStartedListeners.add(listener);
    return () => this.taskStartedListeners.delete(listener);
  }
  emitTaskStarted(event: SupervisorTaskStarted): void {
    for (const listener of this.taskStartedListeners) listener(event);
  }
}

class ControlledSupervisor implements AgentSupervisor {
  terminationCalls = 0;
  orphanCalls = 0;
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly startOperation: () => Promise<RpcSupervisorStartupResult>;
  private readonly terminateOperation: (attempt: number) => Promise<RpcSupervisorTerminationResult>;
  private readonly orphanOperation: (() => Promise<boolean>) | undefined;

  constructor(
    startOperation: () => Promise<RpcSupervisorStartupResult>,
    terminateOperation: (attempt: number) => Promise<RpcSupervisorTerminationResult>,
    orphanOperation?: () => Promise<boolean>,
  ) {
    this.startOperation = startOperation;
    this.terminateOperation = terminateOperation;
    this.orphanOperation = orphanOperation;
  }

  start(): Promise<RpcSupervisorStartupResult> { return this.startOperation(); }
  async submit(_message: string): Promise<RpcSupervisorCommandResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  async prompt(_message: string): Promise<RpcSupervisorCommandResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  async steer(_message: string): Promise<RpcSupervisorCommandResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  async interrupt(): Promise<RpcSupervisorInterruptResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  terminate(): Promise<RpcSupervisorTerminationResult> {
    this.terminationCalls += 1;
    return this.terminateOperation(this.terminationCalls);
  }
  async reapOrphanedDescendants(): Promise<{ readonly confirmed: boolean; readonly forced: boolean }> {
    this.orphanCalls += 1;
    return {
      confirmed: this.orphanOperation === undefined ? false : await this.orphanOperation(),
      forced: false,
    };
  }
  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emitEvent(event: RpcSupervisorEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  wasForcedTerminationUsed(): boolean { return false; }
  listenerCount(): number { return this.listeners.size; }
}

function makeTree(id: string): TreeController {
  return new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => id,
  });
}

test("直接父子旅程闭合 spawn、prompt、steering、wait 和协作式 interrupt", async () => {
  const ids = [
    "44444444-4444-4444-8444-444444444444",
  ];
  let nextId = 0;
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => ids[nextId++] ?? ids[ids.length - 1]!,
  });
  const nodes = new Map<string, FakeManagedRpcNode>();
  let lastNode: FakeManagedRpcNode | undefined;
  let lastChannel: ReadyChannel | undefined;
  let lastSupervisor: RpcSupervisor | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      const node = new FakeManagedRpcNode();
      lastNode = node;
      const channel = new ReadyChannel();
      lastChannel = channel;
      const supervisor = new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel,
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
      lastSupervisor = supervisor;
      return supervisor;
    },
  });

  // 工厂启动 promise 与 controller.spawnAgent 竞争时，使用正式调用结果作为唯一边界。
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "直接子代理" });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const agentId = spawned.data.agent_id;
  const node = lastNode;
  assert.ok(node);

  const first = await controller.sendMessage({ agent_id: agentId, message: "开始" });
  assert.deepEqual(first.ok && first.data.accepted, true);
  assert.deepEqual(node.operations(), ["start", "get_state", "prompt"]);
  assert.ok(lastChannel);
  if (!first.ok) return;
  node.emitEvent({ type: "agent_start" });
  lastChannel.emitTaskStarted({ task_id: first.data.task_id, turn_id: TEST_TURN_ID });

  const second = await controller.sendMessage({ agent_id: agentId, message: "补充" });
  assert.deepEqual(second.ok && second.data.accepted, true);
  assert.deepEqual(node.operations(), ["start", "get_state", "prompt", "steer"]);

  const invalidImages = await controller.sendMessage({
    agent_id: agentId,
    message: "拒绝图片字段",
    images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
  });
  assert.equal(invalidImages.ok, false);
  if (!invalidImages.ok) assert.equal(invalidImages.error.code, "invalid_argument");

  const waitingOne = controller.waitAgents({ agent_ids: [agentId] });
  const waitingTwo = controller.waitAgents({ agent_ids: [agentId] });
  const interrupted = await controller.interruptAgent(agentId);
  assert.equal(interrupted.ok, true);
  if (interrupted.ok) {
    assert.equal(interrupted.data.changed, true);
    assert.equal(interrupted.data.state, "interrupting");
  }
  assert.ok(node.operations().includes("abort"));

  node.emitEvent({ type: "agent_settled" });
  assert.ok(lastSupervisor);
  if (!first.ok) return;
  assert.equal(lastSupervisor.acceptChildReply(
    interruptedFinal(agentId, first.data.task_id),
    () => true,
  ), true);
  const [one, two] = await Promise.all([waitingOne, waitingTwo]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (one.ok && two.ok) {
    assert.equal(one.data.outcome, "task_interrupted");
    assert.equal(two.data.outcome, "task_interrupted");
    assert.equal(one.data.state, "idle");
    assert.equal("observed_at" in one.data, false);
  }
});

test("reply_too_large final 正常完成任务且不把代理标记为故障", async () => {
  const id = "41414141-4141-4414-8414-414141414141";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  let channel: ReadyChannel | undefined;
  let supervisor: RpcSupervisor | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      channel = new ReadyChannel();
      supervisor = new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel,
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
      return supervisor;
    },
  });

  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "超限结果代理" });
  assert.equal(spawned.ok, true);
  if (!spawned.ok || node === undefined || channel === undefined || supervisor === undefined) return;
  const submitted = await controller.sendMessage({ agent_id: id, message: "生成详细报告" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  node.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submitted.data.task_id, turn_id: TEST_TURN_ID });
  const waiting = controller.waitAgents({ agent_ids: [id] });
  node.emitEvent({ type: "agent_settled" });
  assert.equal(supervisor.acceptChildReply(
    replyTooLargeFinal(id, submitted.data.task_id),
    () => true,
  ), true);

  const result = await waiting;
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.outcome, "task_completed");
    assert.equal(result.data.state, "idle");
    assert.equal(result.data.last_task?.outcome, "completed");
    assert.equal(result.data.last_task?.output_state, "absent");
    assert.equal(result.data.error, undefined);
  }
  const status = controller.getAgentStatus(id);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.error, undefined);
  }
  await controller.shutdown();
});

test("自主 agent_start 后控制器保持 working，并按 steering、wait 和 interrupt 路由", async () => {
  const id = "45454545-4545-4454-8454-454545454545";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  let rpcSupervisor: RpcSupervisor | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      rpcSupervisor = new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
      return rpcSupervisor;
    },
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "自主中间代理" });
  assert.equal(spawned.ok, true);
  if (!spawned.ok || node === undefined) return;

  node.emitEvent({ type: "agent_start" });
  const activeStatus = controller.getAgentStatus(id);
  assert.equal(activeStatus.ok, true);
  if (activeStatus.ok) assert.equal(activeStatus.data.state, "working");
  const waiting = controller.waitAgents({ agent_ids: [id] });
  const steered = await controller.sendMessage({ agent_id: id, message: "继续整理孙代理结果" });
  assert.equal(steered.ok, true);
  assert.equal(node.operations().at(-1), "steer");

  const interrupted = await controller.interruptAgent(id);
  assert.equal(interrupted.ok, true);
  if (interrupted.ok) assert.equal(interrupted.data.changed, true);
  node.emitEvent({ type: "agent_settled" });
  assert.ok(rpcSupervisor);
  if (!steered.ok) return;
  assert.equal(rpcSupervisor.acceptChildReply(
    interruptedFinal(id, steered.data.task_id),
    () => true,
  ), true);
  const result = await waiting;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.outcome, "task_interrupted");
  await controller.shutdown();
});

test("工作中 reply 通知立即唤醒 wait_agent 且不改变子代理生命周期", async () => {
  const id = "43434343-4343-4434-8434-434343434343";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      return new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
    },
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "回复代理" });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  assert.equal((await controller.sendMessage({ agent_id: id, message: "开始" })).ok, true);
  const waiting = controller.waitAgents({ agent_ids: [id] });
  assert.equal(controller.notifyAgentReply(id, "reply-notification-1"), true);
  const result = await waiting;
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.outcome, "reply");
    assert.equal(result.data.state, "working");
  }
  const status = controller.getAgentStatus(id);
  assert.equal(status.ok && status.data.state, "working");

  assert.equal(controller.acknowledgeAgentReply(id, "reply-notification-1"), true);
  assert.equal(controller.notifyAgentReply(id, "reply-notification-2"), true);
  const queued = await controller.waitAgents({ agent_ids: [id] });
  assert.equal(queued.ok, true);
  if (queued.ok) {
    assert.equal(queued.data.outcome, "reply");
    assert.equal(queued.data.state, "working");
  }
  assert.equal(controller.acknowledgeAgentReply(id, "reply-notification-2"), true);
  node?.emitEvent({ type: "agent_settled" });
  await controller.shutdown();
});

test("已进入父模型上下文的 reply 不会再次唤醒后续 wait", async () => {
  const id = "48484848-4848-4484-8484-484848484848";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      return new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
    },
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "已观察回复代理" });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  assert.equal((await controller.sendMessage({ agent_id: id, message: "开始" })).ok, true);

  assert.equal(controller.notifyAgentReply(id, "observed-reply"), true);
  assert.equal(controller.acknowledgeAgentReply(id, "observed-reply"), true);
  const abort = new AbortController();
  const waiting = controller.waitAgents({ agent_ids: [id] }, abort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  const aborted = await waiting;
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.error.code, "agent_unavailable");

  assert.equal(controller.notifyAgentReply(id, "new-reply"), true);
  const next = await controller.waitAgents({ agent_ids: [id] });
  assert.equal(next.ok, true);
  if (next.ok) assert.equal(next.data.outcome, "reply");
  assert.equal(controller.acknowledgeAgentReply(id, "new-reply"), true);
  node?.emitEvent({ type: "agent_settled" });
  await controller.shutdown();
});

test("任务 final 到达后不会被尚未观察的旧 reply 遮挡", async () => {
  const id = "49494949-4949-4494-8494-494949494949";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  let supervisor: RpcSupervisor | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      supervisor = new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
      return supervisor;
    },
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "final 优先代理" });
  assert.equal(spawned.ok, true);
  if (!spawned.ok || node === undefined || supervisor === undefined) return;
  const submitted = await controller.sendMessage({ agent_id: id, message: "开始" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  node.emitEvent({ type: "agent_start" });
  const taskStarted = TEST_TURN_ID;
  const oldReply = controller.notifyAgentReply(id, "old-reply", submitted.data.task_id, taskStarted);
  assert.equal(oldReply, true);
  node.emitEvent({ type: "agent_settled" });
  assert.equal(supervisor.acceptChildReply(
    interruptedFinal(id, submitted.data.task_id),
    () => true,
  ), true);

  const result = await controller.waitAgents({ agent_ids: [id] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.outcome, "task_interrupted");
  assert.equal(controller.acknowledgeAgentReply(id, "old-reply"), false);
  await controller.shutdown();
});

test("多目标 wait 由首个 reply 原子结算并从其余目标索引移除", async () => {
  const ids = [
    "46464646-4646-4464-8464-464646464646",
    "47474747-4747-4474-8474-474747474747",
  ];
  let nextId = 0;
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => ids[nextId++] ?? ids[ids.length - 1]!,
  });
  const nodes = new Map<string, FakeManagedRpcNode>();
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      const node = new FakeManagedRpcNode();
      const id = ids[nodes.size]!;
      nodes.set(id, node);
      return new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
    },
  });
  for (const [index, id] of ids.entries()) {
    const spawned = await controller.spawnAgent({ template_id: "researcher", name: `等待代理 ${index + 1}` });
    assert.equal(spawned.ok, true);
    assert.equal((await controller.sendMessage({ agent_id: id, message: "开始" })).ok, true);
  }

  const waiting = controller.waitAgents({ agent_ids: [ids[0]!, ids[0]!, ids[1]!] });
  assert.equal(controller.notifyAgentReply(ids[1]), true);
  const result = await waiting;
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.outcome, "reply");
    assert.equal("agent_id" in result.data && result.data.agent_id, ids[1]);
  }

  assert.equal(controller.notifyAgentReply(ids[0]), true);
  const next = await controller.waitAgents({ agent_ids: [ids[0]!] });
  assert.equal(next.ok, true);
  if (next.ok) {
    assert.equal(next.data.outcome, "reply");
    assert.equal("agent_id" in next.data && next.data.agent_id, ids[0]);
  }
  for (const node of nodes.values()) node.emitEvent({ type: "agent_settled" });
  await controller.shutdown();
});

test("运行时故障先注入 terminal 通知再解除 wait_agent", async () => {
  const id = "42424242-4242-4424-8424-424242424242";
  const tree = makeTree(id);
  const order: string[] = [];
  let node: FakeManagedRpcNode | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    onTerminal: (agentId) => {
      assert.equal(agentId, id);
      order.push("terminal");
    },
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      return new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
    },
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "故障代理" });
  assert.equal(spawned.ok, true);
  assert.equal((await controller.sendMessage({ agent_id: id, message: "开始" })).ok, true);
  assert.equal(controller.notifyAgentReply(id, "stale-terminal-reply"), true);
  const waiting = controller.waitAgents({ agent_ids: [id] });
  node?.emitTransportFault("eof");
  const result = await waiting;
  order.push("wait");
  assert.deepEqual(order, ["terminal", "wait"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.outcome, "terminal");
    assert.equal(result.data.state, "failed");
    assert.equal("text" in result.data, false);
    assert.equal("final" in result.data, false);
  }
  const repeated = await controller.waitAgents({ agent_ids: [id] });
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.data.outcome, "terminal");
  await controller.shutdown();
});

test("迟到的 runtime_failed 事实不能伪造 TerminalNotice", async () => {
  const id = "41414141-4141-4414-8414-414141414141";
  const tree = makeTree(id);
  const channel = new ReadyChannel();
  let terminalNotices = 0;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    onTerminal: () => { terminalNotices += 1; },
    createSupervisor: ({ actor, reservation }) => new RpcSupervisor({
      controller: tree,
      actor,
      reservation,
      managedNode: new FakeManagedRpcNode(),
      channel,
      startupTimeoutMs: 100,
      gracefulShutdownMs: 10,
    }),
  });
  assert.equal((await controller.spawnAgent({ template_id: "researcher", name: "迟到事实代理" })).ok, true);

  channel.emitEvent({
    root_id: "root-stale-terminal",
    agent_id: id,
    type: "runtime_failed",
    expected_generation: 0,
    error_code: "internal_error",
  });

  assert.equal(terminalNotices, 0);
  const status = controller.getAgentStatus(id);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "idle");
  await controller.shutdown();
});

test("terminal 通知注入失败时阻止 wait_agent 提前返回并在 API 恢复后重试", async () => {
  const id = "43434343-4343-4434-8434-434343434343";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  let parentAvailable = false;
  let attempts = 0;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    onTerminal: () => {
      attempts += 1;
      return parentAvailable;
    },
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      return new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
    },
  });
  assert.equal((await controller.spawnAgent({ template_id: "researcher", name: "故障重试代理" })).ok, true);
  assert.equal((await controller.sendMessage({ agent_id: id, message: "开始" })).ok, true);

  let resolved = false;
  const waiting = controller.waitAgents({ agent_ids: [id] }).then((result) => {
    resolved = true;
    return result;
  });
  node?.emitTransportFault("eof");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(resolved, false);

  parentAvailable = true;
  await controller.retryPendingReplies();
  const result = await waiting;
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.outcome, "terminal");
  await controller.shutdown();
});

test("已确认工具活动只以固定类别和计数进入控制器安全树快照", async () => {
  const id = "45454545-4545-4545-8545-454545454545";
  const tree = makeTree(id);
  let node: FakeManagedRpcNode | undefined;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      node = new FakeManagedRpcNode();
      return new RpcSupervisor({
        controller: tree,
        actor,
        reservation,
        managedNode: node,
        channel: new ReadyChannel(),
        startupTimeoutMs: 100,
        gracefulShutdownMs: 10,
      });
    },
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "活动代理" });
  assert.equal(spawned.ok, true);
  assert.ok(node);
  node.emitEvent({ type: "agent_start" });

  node.emitEvent({
    type: "tool_execution_start",
    toolCallId: "secret-call-id",
    toolName: "apply_patch",
    args: { path: "D:\\private\\secret-canary.txt", patch: "TOP_SECRET" },
  });
  const active = controller.getAgentTree();
  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.equal(active.data.nodes[0]?.activity?.phase, "executing_tools");
  assert.equal(active.data.nodes[0]?.activity?.category, "editing");
  assert.equal(active.data.nodes[0]?.activity?.active_count, 1);
  assert.doesNotMatch(JSON.stringify(active.data), /secret-call-id|secret-canary|TOP_SECRET|apply_patch/i);

  node.emitEvent({
    type: "tool_execution_end",
    toolCallId: "secret-call-id",
    toolName: "apply_patch",
    result: { output: "TOP_SECRET_RESULT" },
    isError: false,
  });
  const settled = controller.getAgentTree();
  assert.equal(settled.ok, true);
  if (settled.ok) assert.equal(settled.data.nodes[0]?.activity?.phase, "processing");
});

test("等待参数越界和非直接子代理调用在启动 RPC 前稳定失败", async () => {
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => "55555555-5555-4555-8555-555555555555",
  });
  let created = 0;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    actor: ROOT_TREE_ACTOR,
    createSupervisor: () => {
      created += 1;
      throw new Error("不应启动");
    },
  });
  const invalidWait = await controller.waitAgents({
    agent_ids: ["55555555-5555-4555-8555-555555555555"],
    timeout_ms: 9_999,
  });
  assert.equal(invalidWait.ok, false);
  assert.equal(created, 0);
});

test("生产控制器没有模板快照时拒绝创建，不绕过模板发现", async () => {
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => "66666666-6666-4666-8666-666666666666",
  });
  let created = 0;
  const controller = new AgentController({
    tree,
    createSupervisor: () => {
      created += 1;
      throw new Error("不应启动");
    },
  });
  const result = await controller.spawnAgent({ template_id: "researcher", name: "未校验" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "template_not_found");
  assert.equal(created, 0);
});

test("shutdown 等待正在启动的创建事务并回收随后登记的监督器", async () => {
  const id = "67676767-6767-4767-8767-676767676767";
  const tree = makeTree(id);
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let reportStarted!: () => void;
  const startEntered = new Promise<void>((resolve) => { reportStarted = resolve; });
  const supervisor = new ControlledSupervisor(
    async () => {
      const reserved = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
        templateId: "researcher",
        name: "并发关闭",
      });
      assert.equal(reserved.ok, true);
      if (!reserved.ok) throw new Error("测试预留失败");
      const ready = tree.applyLifecycleEvent(id, {
        type: "startup_ready",
        expected_generation: reserved.data.lifecycle_generation,
      });
      assert.equal(ready.ok, true);
      reportStarted();
      await startGate;
      return { ok: true, agent_id: id, state: "idle" };
    },
    async () => ({
      ok: true,
      agent_id: id,
      state: "terminated",
      cleanup: "confirmed",
    }),
  );
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => supervisor,
  });

  const spawning = controller.spawnAgent({ template_id: "researcher", name: "并发关闭" });
  await startEntered;
  const shuttingDown = controller.shutdown();
  const lateSpawn = await controller.spawnAgent({ template_id: "researcher", name: "关闭后创建" });
  assert.equal(lateSpawn.ok, false);
  if (!lateSpawn.ok) assert.equal(lateSpawn.error.code, "agent_unavailable");
  let shutdownSettled = false;
  void shuttingDown.then(() => { shutdownSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);

  releaseStart();
  const spawned = await spawning;
  assert.equal(spawned.ok, true);
  assert.equal(await shuttingDown, true);
  assert.equal(supervisor.terminationCalls, 1);
  const status = tree.getStatus(id);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminated");
});

test("监督器 start 抛错后尝试回收，并按回收结果区分内部错误与清理不完整", async () => {
  const confirmedId = "77777777-7777-4777-8777-777777777777";
  const confirmed = new ControlledSupervisor(
    async () => { throw new Error("启动边界异常"); },
    async () => ({
      ok: true,
      agent_id: confirmedId,
      state: "terminated",
      cleanup: "confirmed",
    }),
  );
  const confirmedController = new AgentController({
    tree: makeTree(confirmedId),
    allowUnvalidatedTemplates: true,
    createSupervisor: () => confirmed,
  });

  const confirmedResult = await confirmedController.spawnAgent({
    template_id: "researcher",
    name: "抛错后已回收",
  });
  assert.equal(confirmedResult.ok, false);
  if (!confirmedResult.ok) assert.equal(confirmedResult.error.code, "internal_error");
  assert.equal(confirmed.terminationCalls, 1);
  assert.equal(confirmed.listenerCount(), 0);

  const incompleteId = "88888888-8888-4888-8888-888888888888";
  const incomplete = new ControlledSupervisor(
    async () => { throw new Error("启动边界异常"); },
    async (attempt) => attempt === 1
      ? {
          ok: false,
          code: "termination_incomplete",
          state: "terminating",
          cleanup: "incomplete",
        }
      : {
          ok: true,
          agent_id: incompleteId,
          state: "terminated",
          cleanup: "confirmed",
        },
  );
  const incompleteController = new AgentController({
    tree: makeTree(incompleteId),
    allowUnvalidatedTemplates: true,
    createSupervisor: () => incomplete,
  });

  const incompleteResult = await incompleteController.spawnAgent({
    template_id: "researcher",
    name: "抛错后未确认回收",
  });
  assert.equal(incompleteResult.ok, false);
  if (!incompleteResult.ok) assert.equal(incompleteResult.error.code, "termination_incomplete");
  assert.equal(incomplete.terminationCalls, 1);
  assert.equal(incomplete.listenerCount(), 1);
  const shutdownComplete = await incompleteController.shutdown();
  assert.equal(shutdownComplete, true);
  assert.equal(incomplete.terminationCalls, 2);
  assert.equal(incomplete.listenerCount(), 0);

  const unknown = new ControlledSupervisor(
    async () => { throw new Error("身份返回前异常"); },
    async (attempt) => attempt === 1
      ? { ok: false, code: "agent_unavailable" }
      : {
          ok: true,
          agent_id: incompleteId,
          state: "terminated",
          cleanup: "confirmed",
        },
  );
  const unknownController = new AgentController({
    tree: makeTree(incompleteId),
    allowUnvalidatedTemplates: true,
    createSupervisor: () => unknown,
  });
  const unknownResult = await unknownController.spawnAgent({
    template_id: "researcher",
    name: "清理状态未知",
  });
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.equal(unknownResult.error.code, "termination_incomplete");
  assert.equal(unknown.listenerCount(), 1);
  await unknownController.shutdown();
  assert.equal(unknown.terminationCalls, 2);
  assert.equal(unknown.listenerCount(), 0);
});

test("运行期监督故障自动清理后代但保留 failed 父节点，显式终止再清理父资源", async () => {
  const parentId = "a1111111-1111-4111-8111-111111111111";
  const childId = "a2222222-2222-4222-8222-222222222222";
  const ids = [parentId, childId];
  let nextId = 0;
  const tree = new TreeController({
    config: { maxDepth: 3, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => ids[nextId++]!,
  });
  const reserveReady = (actor: typeof ROOT_TREE_ACTOR | { kind: "agent"; agent_id: string }, input: { templateId: string; name: string }): string => {
    const reserved = tree.reserveStartingChild(actor, input);
    assert.equal(reserved.ok, true);
    if (!reserved.ok) throw new Error("预留失败");
    const ready = tree.applyLifecycleEvent(reserved.data.node.agent_id, {
      type: "startup_ready",
      expected_generation: reserved.data.lifecycle_generation,
    });
    assert.equal(ready.ok, true);
    return reserved.data.node.agent_id;
  };
  let parentSupervisor: ControlledSupervisor;
  const root = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => {
      parentSupervisor = new ControlledSupervisor(
        async () => ({ ok: true, agent_id: parentId, state: "idle" }),
        async () => ({ ok: true, agent_id: parentId, state: "terminated", cleanup: "confirmed" }),
        async () => true,
      );
      reserveReady(ROOT_TREE_ACTOR, { templateId: "parent", name: "父" });
      return parentSupervisor;
    },
  });
  let childSupervisor: ControlledSupervisor;
  const child = new AgentController({
    tree,
    actor: { kind: "agent", agent_id: parentId },
    allowUnvalidatedTemplates: true,
    createSupervisor: () => {
      childSupervisor = new ControlledSupervisor(
        async () => ({ ok: true, agent_id: childId, state: "idle" }),
        async () => ({ ok: true, agent_id: childId, state: "terminated", cleanup: "confirmed" }),
      );
      reserveReady({ kind: "agent", agent_id: parentId }, { templateId: "child", name: "子" });
      return childSupervisor;
    },
  });
  const parent = await root.spawnAgent({ template_id: "parent", name: "父" });
  assert.equal(parent.ok, true);
  const childResult = await child.spawnAgent({ template_id: "child", name: "子" });
  assert.equal(childResult.ok, true);
  assert.ok(parentSupervisor!);
  assert.ok(childSupervisor!);

  const generation = tree.getLifecycleGeneration(parentId);
  assert.equal(generation.ok, true);
  if (!generation.ok) return;
  const failure = tree.applyLifecycleEvent(parentId, {
    type: "runtime_failed",
    expected_generation: generation.data,
    error_code: "internal_error",
  });
  assert.equal(failure.ok, true);
  parentSupervisor!.emitEvent({ kind: "fault", code: "rpc_process_exit" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const parentStatus = tree.getStatus(parentId);
  const childStatus = tree.getStatus(childId);
  assert.equal(parentStatus.ok ? parentStatus.data.state : "missing", "failed");
  assert.equal(childStatus.ok ? childStatus.data.state : "missing", "terminated");
  assert.equal(parentSupervisor!.terminationCalls, 0);
  assert.equal(parentSupervisor!.orphanCalls, 1);
  assert.equal(childSupervisor!.terminationCalls, 0);

  const explicit = await root.terminateAgent(parentId);
  assert.equal(explicit.ok, true);
  assert.equal(parentSupervisor!.terminationCalls, 1);
});

test("同批防孤儿清理失败只发布一个树修订并聚合全部后代", async () => {
  const parentId = "a3111111-1111-4111-8111-111111111111";
  const childIds = [
    "a3222222-2222-4222-8222-222222222221",
    "a3222222-2222-4222-8222-222222222222",
  ];
  const ids = [parentId, ...childIds];
  let nextId = 0;
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => ids[nextId++]!,
  });
  const reserveReady = (
    actor: typeof ROOT_TREE_ACTOR | { kind: "agent"; agent_id: string },
    input: { templateId: string; name: string },
  ): string => {
    const reserved = tree.reserveStartingChild(actor, input);
    assert.equal(reserved.ok, true);
    if (!reserved.ok) throw new Error("预留失败");
    const ready = tree.applyLifecycleEvent(reserved.data.node.agent_id, {
      type: "startup_ready",
      expected_generation: reserved.data.lifecycle_generation,
    });
    assert.equal(ready.ok, true);
    return reserved.data.node.agent_id;
  };
  let parentSupervisor: ControlledSupervisor;
  const root = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => {
      parentSupervisor = new ControlledSupervisor(
        async () => ({ ok: true, agent_id: parentId, state: "idle" }),
        async () => ({ ok: true, agent_id: parentId, state: "terminated", cleanup: "confirmed" }),
        async () => false,
      );
      reserveReady(ROOT_TREE_ACTOR, { templateId: "parent", name: "父" });
      return parentSupervisor;
    },
  });
  let childIndex = 0;
  const child = new AgentController({
    tree,
    actor: { kind: "agent", agent_id: parentId },
    allowUnvalidatedTemplates: true,
    createSupervisor: () => {
      const childId = childIds[childIndex++]!;
      const supervisor = new ControlledSupervisor(
        async () => ({ ok: true, agent_id: childId, state: "idle" }),
        async () => ({ ok: true, agent_id: childId, state: "terminated", cleanup: "confirmed" }),
      );
      reserveReady({ kind: "agent", agent_id: parentId }, { templateId: "child", name: `子${childIndex}` });
      return supervisor;
    },
  });
  assert.equal((await root.spawnAgent({ template_id: "parent", name: "父" })).ok, true);
  assert.equal((await child.spawnAgent({ template_id: "child", name: "子一" })).ok, true);
  assert.equal((await child.spawnAgent({ template_id: "child", name: "子二" })).ok, true);

  const generation = tree.getLifecycleGeneration(parentId);
  assert.equal(generation.ok, true);
  if (!generation.ok) return;
  assert.equal(tree.applyLifecycleEvent(parentId, {
    type: "runtime_failed",
    expected_generation: generation.data,
    error_code: "internal_error",
  }).ok, true);
  const before = tree.getTreeSnapshot();
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const visibleRevisions: number[] = [];
  const unsubscribe = tree.onChange(() => {
    const snapshot = tree.getTreeSnapshot();
    if (snapshot.ok) visibleRevisions.push(snapshot.data.tree_revision);
  });
  parentSupervisor!.emitEvent({ kind: "fault", code: "rpc_process_exit" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  unsubscribe();

  assert.deepEqual(visibleRevisions, [before.data.tree_revision + 1]);
  assert.deepEqual(childIds.map((agentId) => {
    const status = tree.getStatus(agentId);
    return status.ok ? [status.data.state, status.data.error?.code] : ["missing", undefined];
  }), [
    ["terminating", "termination_incomplete"],
    ["terminating", "termination_incomplete"],
  ]);
  child.dispose();
  root.dispose();
});

test("启动失败只在清理不完整时保留监督器供 terminate_agent 重试", async () => {
  const confirmedId = "99999999-9999-4999-8999-999999999999";
  const confirmedTree = makeTree(confirmedId);
  const confirmedReservation = confirmedTree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "researcher",
    name: "已确认清理",
  });
  assert.equal(confirmedReservation.ok, true);
  const confirmed = new ControlledSupervisor(
    async () => ({
      ok: false,
      agent_id: confirmedId,
      code: "spawn_failed",
      cleanup: "confirmed",
    }),
    async () => ({
      ok: true,
      agent_id: confirmedId,
      state: "terminated",
      cleanup: "confirmed",
    }),
  );
  const confirmedController = new AgentController({
    tree: confirmedTree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => confirmed,
  });

  const confirmedResult = await confirmedController.spawnAgent({
    template_id: "researcher",
    name: "已确认清理",
  });
  assert.equal(confirmedResult.ok, false);
  if (!confirmedResult.ok) assert.equal(confirmedResult.error.code, "spawn_failed");
  const confirmedRetry = await confirmedController.terminateAgent(confirmedId);
  assert.equal(confirmedRetry.ok, false);
  if (!confirmedRetry.ok) assert.equal(confirmedRetry.error.code, "agent_unavailable");
  assert.equal(confirmed.terminationCalls, 0);
  assert.equal(confirmed.listenerCount(), 0);

  const incompleteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const incompleteTree = makeTree(incompleteId);
  const incompleteReservation = incompleteTree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "researcher",
    name: "清理待重试",
  });
  assert.equal(incompleteReservation.ok, true);
  const incomplete = new ControlledSupervisor(
    async () => ({
      ok: false,
      agent_id: incompleteId,
      code: "termination_incomplete",
      cleanup: "incomplete",
    }),
    async () => ({
      ok: true,
      agent_id: incompleteId,
      state: "terminated",
      cleanup: "confirmed",
    }),
  );
  const incompleteController = new AgentController({
    tree: incompleteTree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => incomplete,
  });

  const incompleteResult = await incompleteController.spawnAgent({
    template_id: "researcher",
    name: "清理待重试",
  });
  assert.equal(incompleteResult.ok, false);
  if (!incompleteResult.ok) assert.equal(incompleteResult.error.code, "termination_incomplete");
  const retry = await incompleteController.terminateAgent(incompleteId);
  assert.equal(retry.ok, true);
  assert.equal(incomplete.terminationCalls, 1);
  assert.equal(incomplete.listenerCount(), 0);
});

test("启动成功后的树状态异常会回滚，清理未确认时仍允许显式重试", async () => {
  const missingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const missing = new ControlledSupervisor(
    async () => ({ ok: true, agent_id: missingId, state: "idle" }),
    async () => ({
      ok: true,
      agent_id: missingId,
      state: "terminated",
      cleanup: "confirmed",
    }),
  );
  const missingController = new AgentController({
    tree: makeTree("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    allowUnvalidatedTemplates: true,
    createSupervisor: () => missing,
  });
  const missingResult = await missingController.spawnAgent({
    template_id: "researcher",
    name: "树记录缺失",
  });
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.error.code, "internal_error");
  assert.equal(missing.terminationCalls, 1);
  assert.equal(missing.listenerCount(), 0);

  const startingId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const startingTree = makeTree(startingId);
  const reservation = startingTree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "researcher",
    name: "状态未就绪",
  });
  assert.equal(reservation.ok, true);
  const starting = new ControlledSupervisor(
    async () => ({ ok: true, agent_id: startingId, state: "idle" }),
    async (attempt) => attempt <= 2
      ? {
          ok: false,
          agent_id: startingId,
          code: "termination_incomplete",
          state: "terminating",
          cleanup: "incomplete",
        }
      : {
          ok: true,
          agent_id: startingId,
          state: "terminated",
          cleanup: "confirmed",
        },
  );
  const startingController = new AgentController({
    tree: startingTree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => starting,
  });

  const startingResult = await startingController.spawnAgent({
    template_id: "researcher",
    name: "状态未就绪",
  });
  assert.equal(startingResult.ok, false);
  if (!startingResult.ok) assert.equal(startingResult.error.code, "termination_incomplete");
  assert.equal(starting.terminationCalls, 1);
  assert.equal(starting.listenerCount(), 1);
  await startingController.shutdown();
  assert.equal(starting.terminationCalls, 2);
  assert.equal(starting.listenerCount(), 1);
  const retried = await startingController.terminateAgent(startingId);
  assert.equal(retried.ok, true);
  assert.equal(starting.terminationCalls, 3);
  assert.equal(starting.listenerCount(), 0);
});

test("后台资源确认后立即释放活动监督器引用，shutdown 不重复终止", async () => {
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const tree = makeTree(id);
  const reservation = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "researcher",
    name: "后台回收",
  });
  assert.equal(reservation.ok, true);
  if (!reservation.ok) return;
  const supervisor = new ControlledSupervisor(
    async () => ({
      ok: false,
      agent_id: id,
      code: "termination_incomplete",
      cleanup: "incomplete",
    }),
    async () => ({
      ok: true,
      agent_id: id,
      state: "terminated",
      cleanup: "confirmed",
    }),
  );
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => supervisor,
  });
  const spawned = await controller.spawnAgent({ template_id: "researcher", name: "后台回收" });
  assert.equal(spawned.ok, false);
  assert.equal(supervisor.listenerCount(), 1);

  const failed = tree.applyLifecycleEvent(id, {
    type: "startup_failed",
    error_code: "spawn_timeout",
    expected_generation: reservation.data.lifecycle_generation,
  });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  const terminating = tree.applyLifecycleEvent(id, {
    type: "termination_requested",
    expected_generation: failed.data.lifecycle_generation,
  });
  assert.equal(terminating.ok, true);
  if (!terminating.ok) return;
  const resourcesEvent = {
    type: "resources_confirmed" as const,
    expected_generation: terminating.data.lifecycle_generation,
  };
  const terminated = tree.applyLifecycleEvent(id, resourcesEvent);
  assert.equal(terminated.ok, true);
  supervisor.emitEvent({ kind: "lifecycle", event: resourcesEvent });

  assert.equal(supervisor.listenerCount(), 0);
  await controller.shutdown();
  assert.equal(supervisor.terminationCalls, 0);
});

test("terminate_agent 以同一树屏障后代优先级联，并在部分确认后只重试残留节点", async () => {
  const parentId = "f1111111-1111-4111-8111-111111111111";
  const childId = "f2222222-2222-4222-8222-222222222222";
  const ids = [parentId, childId];
  let nextId = 0;
  const tree = new TreeController({
    config: { maxDepth: 3, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => ids[nextId++]!,
  });
  const parentReservation = tree.reserveStartingChild(ROOT_TREE_ACTOR, { templateId: "parent", name: "父" });
  assert.equal(parentReservation.ok, true);
  if (!parentReservation.ok) return;
  const parentReady = tree.applyLifecycleEvent(parentId, {
    type: "startup_ready",
    expected_generation: parentReservation.data.lifecycle_generation,
  });
  assert.equal(parentReady.ok, true);
  if (!parentReady.ok) return;
  const childReservation = tree.reserveStartingChild({ kind: "agent", agent_id: parentId }, {
    templateId: "child",
    name: "子",
  });
  assert.equal(childReservation.ok, true);
  if (!childReservation.ok) return;
  const childReady = tree.applyLifecycleEvent(childId, {
    type: "startup_ready",
    expected_generation: childReservation.data.lifecycle_generation,
  });
  assert.equal(childReady.ok, true);

  const trace: string[] = [];
  let childController: AgentController;
  const parentSupervisor = new ControlledSupervisor(
    async () => ({ ok: true, agent_id: parentId, state: "idle" }),
    async () => {
      const descendantsConfirmed = await childController.shutdown();
      if (!descendantsConfirmed) {
        return {
          ok: false,
          agent_id: parentId,
          code: "termination_incomplete",
          state: "terminating",
          cleanup: "incomplete",
        };
      }
      trace.push("parent");
      return { ok: true, agent_id: parentId, state: "terminated", cleanup: "confirmed" };
    },
  );
  const childSupervisor = new ControlledSupervisor(
    async () => ({ ok: true, agent_id: childId, state: "idle" }),
    async (attempt) => {
      trace.push(`child-${attempt}`);
      return attempt === 1
        ? { ok: false, agent_id: childId, code: "termination_incomplete", state: "terminating", cleanup: "incomplete" }
        : { ok: true, agent_id: childId, state: "terminated", cleanup: "confirmed" };
    },
  );
  const root = new AgentController({
    tree,
    actor: ROOT_TREE_ACTOR,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => parentSupervisor,
  });
  const child = new AgentController({
    tree,
    actor: { kind: "agent", agent_id: parentId },
    allowUnvalidatedTemplates: true,
    createSupervisor: () => childSupervisor,
  });
  childController = child;
  assert.equal((await root.spawnAgent({ template_id: "parent", name: "父" })).ok, true);
  assert.equal((await child.spawnAgent({ template_id: "child", name: "子" })).ok, true);

  const [first, concurrent] = await Promise.all([root.terminateAgent(parentId), root.terminateAgent(parentId)]);
  assert.equal(first.ok, false);
  assert.equal(concurrent.ok, false);
  assert.deepEqual(trace, ["child-1"]);
  assert.equal(childSupervisor.terminationCalls, 1);
  assert.equal(parentSupervisor.terminationCalls, 1);
  const firstChildStatus = tree.getStatus(childId);
  const firstParentStatus = tree.getStatus(parentId);
  assert.equal(firstChildStatus.ok, true);
  assert.equal(firstParentStatus.ok, true);
  if (firstChildStatus.ok) assert.equal(firstChildStatus.data.state, "terminating");
  if (firstParentStatus.ok) assert.equal(firstParentStatus.data.state, "terminating");

  const retry = await root.terminateAgent(parentId);
  assert.equal(retry.ok, true);
  if (retry.ok) assert.deepEqual(retry.data, {
    agent_id: parentId,
    state: "terminated",
    changed: true,
    forced: false,
    terminated_count: 2,
  });
  assert.deepEqual(trace, ["child-1", "child-2", "parent"]);
  assert.equal(parentSupervisor.terminationCalls, 2);
  assert.equal(childSupervisor.terminationCalls, 2);
  const finalChildStatus = tree.getStatus(childId);
  const finalParentStatus = tree.getStatus(parentId);
  assert.equal(finalChildStatus.ok, true);
  assert.equal(finalParentStatus.ok, true);
  if (finalChildStatus.ok) assert.equal(finalChildStatus.data.state, "terminated");
  if (finalParentStatus.ok) assert.equal(finalParentStatus.data.state, "terminated");
});
