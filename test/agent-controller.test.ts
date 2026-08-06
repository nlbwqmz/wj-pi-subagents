import assert from "node:assert/strict";
import test from "node:test";
import { AgentController, type AgentSupervisor } from "../src/agent-controller.ts";
import { FakeManagedRpcNode } from "../src/managed-rpc-node.ts";
import {
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
  type RpcSupervisorCommandResult,
  type RpcSupervisorEvent,
  type RpcSupervisorImage,
  type RpcSupervisorInterruptResult,
  type RpcSupervisorStartupResult,
  type RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import { ROOT_TREE_ACTOR, TreeController } from "../src/tree-controller.ts";

class ReadyChannel implements RpcSupervisorChannel {
  private ready = true;
  async bind(): Promise<void> {}
  async waitForReady(): Promise<void> {}
  isReady(): boolean { return this.ready; }
  async publishReply(): Promise<void> {}
  establishTerminationBarrier(): void {}
  async requestClose(): Promise<void> { this.ready = false; }
  async waitForClose(): Promise<RpcSupervisorChannelCloseState> { return "released"; }
  async release(): Promise<void> {}
  onFault(): () => void { return () => {}; }
}

class ControlledSupervisor implements AgentSupervisor {
  terminationCalls = 0;
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly startOperation: () => Promise<RpcSupervisorStartupResult>;
  private readonly terminateOperation: (attempt: number) => Promise<RpcSupervisorTerminationResult>;

  constructor(
    startOperation: () => Promise<RpcSupervisorStartupResult>,
    terminateOperation: (attempt: number) => Promise<RpcSupervisorTerminationResult>,
  ) {
    this.startOperation = startOperation;
    this.terminateOperation = terminateOperation;
  }

  start(): Promise<RpcSupervisorStartupResult> { return this.startOperation(); }
  async prompt(_message: string, _images?: readonly RpcSupervisorImage[]): Promise<RpcSupervisorCommandResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  async steer(_message: string, _images?: readonly RpcSupervisorImage[]): Promise<RpcSupervisorCommandResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  async interrupt(): Promise<RpcSupervisorInterruptResult> {
    return { ok: false, code: "agent_unavailable" };
  }
  terminate(): Promise<RpcSupervisorTerminationResult> {
    this.terminationCalls += 1;
    return this.terminateOperation(this.terminationCalls);
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
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: ({ actor, reservation }) => {
      const node = new FakeManagedRpcNode();
      lastNode = node;
      const supervisor = new RpcSupervisor({
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

  const second = await controller.sendMessage({ agent_id: agentId, message: "补充" });
  assert.deepEqual(second.ok && second.data.accepted, true);
  assert.deepEqual(node.operations(), ["start", "get_state", "prompt", "steer"]);

  const waitingOne = controller.waitAgent({ agent_id: agentId });
  const waitingTwo = controller.waitAgent({ agent_id: agentId });
  const interrupted = await controller.interruptAgent(agentId);
  assert.equal(interrupted.ok, true);
  if (interrupted.ok) {
    assert.equal(interrupted.data.changed, true);
    assert.equal(interrupted.data.state, "interrupting");
  }
  assert.ok(node.operations().includes("abort"));

  node.emitEvent({ type: "agent_settled" });
  const [one, two] = await Promise.all([waitingOne, waitingTwo]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (one.ok && two.ok) {
    assert.equal(one.data.outcome, "settled");
    assert.equal(two.data.outcome, "settled");
    assert.equal(one.data.state, "idle");
  }
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
  const invalidWait = await controller.waitAgent({
    agent_id: "55555555-5555-4555-8555-555555555555",
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
  await incompleteController.shutdown();
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
