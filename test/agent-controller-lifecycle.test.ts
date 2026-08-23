import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentController,
  type AgentSupervisor,
} from "../src/agent-controller.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildReplyEnvelope,
} from "../src/child-reply-envelope.ts";
import type {
  RpcSupervisorCommandResult,
  RpcSupervisorEvent,
  RpcSupervisorInterruptResult,
  RpcSupervisorStartupResult,
  RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import {
  TreeController,
  ROOT_TREE_ACTOR,
  type ReserveStartingChildInput,
  type AgentLifecycleEvent,
} from "../src/tree-controller.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

class FakeSupervisor implements AgentSupervisor {
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  tree: TreeController | undefined;
  reservation: ReserveStartingChildInput | undefined;
  sendResult: RpcSupervisorCommandResult = { ok: true, accepted: true };
  interruptResult: RpcSupervisorInterruptResult = {
    ok: true,
    accepted: true,
    changed: true,
  };
  terminateResult: RpcSupervisorTerminationResult = {
    ok: true,
    agent_id: AGENT_ID,
    state: "terminated",
    cleanup: "confirmed",
  };

  start(): Promise<RpcSupervisorStartupResult> {
    // 监督器在返回启动成功前先完成 starting 预留并提交真实 startup_ready；
    // 事件观察器只负责后续 wait_agent 投影，不能代替启动事实本身。
    if (this.tree !== undefined && this.reservation !== undefined) {
      const reserved = this.tree.reserveStartingChild(ROOT_TREE_ACTOR, this.reservation);
      assert.equal(reserved.ok, true);
      this.tree.applyLifecycleEvent(AGENT_ID, {
        type: "startup_ready",
        expected_generation: 0,
      });
    }
    return Promise.resolve({ ok: true, agent_id: AGENT_ID, state: "idle" });
  }

  sendMessage(_message: string): Promise<RpcSupervisorCommandResult> {
    return Promise.resolve(this.sendResult);
  }

  interrupt(): Promise<RpcSupervisorInterruptResult> {
    return Promise.resolve(this.interruptResult);
  }

  terminate(): Promise<RpcSupervisorTerminationResult> {
    return Promise.resolve(this.terminateResult);
  }

  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wasForcedTerminationUsed(): boolean {
    return false;
  }

  emitLifecycle(event: AgentLifecycleEvent): void {
    this.tree?.applyLifecycleEvent(AGENT_ID, event);
    for (const listener of this.listeners) listener({ kind: "lifecycle", event });
  }

  emitReply(kind: ChildReplyEnvelope["kind"], text = "父端消息"): void {
    const reply = {
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind,
      agent_id: AGENT_ID,
      text,
    } as ChildReplyEnvelope;
    for (const listener of this.listeners) listener({ kind: "reply", reply });
  }
}

function makeController(fake: FakeSupervisor): {
  readonly controller: AgentController;
  readonly tree: TreeController;
} {
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  fake.tree = tree;
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => {
      fake.reservation = input.reservation;
      return fake;
    },
    replyNotificationsHandledByInbox: false,
  });
  return { controller, tree };
}

function generation(tree: TreeController): number {
  const result = tree.getLifecycleGeneration(AGENT_ID);
  assert.equal(result.ok, true);
  return result.data;
}

async function waitForEvent(controller: AgentController): Promise<Awaited<ReturnType<AgentController["waitAgents"]>>> {
  return controller.waitAgents({ agent_ids: [AGENT_ID], timeout_ms: 10_000 });
}

test("send_message 失败只结算本次调用，wait_agent 返回独立消息事件和生命周期快照", async () => {
  const fake = new FakeSupervisor();
  const { controller, tree } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  if (!spawned.ok) return;

  fake.emitLifecycle({ type: "agent_start", expected_generation: generation(tree) });
  fake.sendResult = { ok: false, code: "message_delivery_failed" };
  const failed = await controller.sendMessage({ agent_id: AGENT_ID, message: "投递失败" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "message_delivery_failed");
  const working = tree.getStatus(AGENT_ID);
  assert.equal(working.ok, true);
  if (working.ok) assert.equal(working.data.state, "working");

  fake.sendResult = { ok: false, code: "compaction_active" };
  const compacting = await controller.sendMessage({ agent_id: AGENT_ID, message: "压缩期间发送" });
  assert.deepEqual(compacting, {
    ok: false,
    error: {
      code: "compaction_active",
      message: "Message delivery blocked while compaction is active; retry after compaction finishes",
      retryable: true,
      details: {},
    },
  });
  const stillWorking = tree.getStatus(AGENT_ID);
  assert.equal(stillWorking.ok, true);
  if (stillWorking.ok) assert.equal(stillWorking.data.state, "working");

  fake.sendResult = { ok: true, accepted: true };
  assert.deepEqual(await controller.sendMessage({ agent_id: AGENT_ID, message: "继续会话" }), {
    ok: true,
    data: { accepted: true },
  });

  const replyWait = waitForEvent(controller);
  fake.emitReply("message", "进度");
  const reply = await replyWait;
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.data.outcome, "reply");
    assert.equal(reply.data.state, "working");
    assert.equal("task_id" in reply.data, false);
    assert.equal("last_task" in reply.data, false);
    assert.equal("suspended" in reply.data, false);
  }

  const reportWait = waitForEvent(controller);
  fake.emitReply("final_report", "显式报告");
  const report = await reportWait;
  assert.equal(report.ok, true);
  if (report.ok) assert.equal(report.data.outcome, "final_report");
});

test("interrupting 必须等待真实 agent_settled，idle 不会误报 starting 就绪", async () => {
  const fake = new FakeSupervisor();
  const { controller, tree } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "中断测试" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  const abort = new AbortController();
  const initialWaitPromise = controller.waitAgents(
    { agent_ids: [AGENT_ID], timeout_ms: 10_000 },
    abort.signal,
  );
  abort.abort();
  const initialWait = await initialWaitPromise;
  if (!initialWait.ok) {
    assert.equal(initialWait.error.code, "agent_unavailable");
  } else {
    assert.fail("starting -> idle 不应创建隐式 idle 事件");
  }

  fake.emitLifecycle({ type: "agent_start", expected_generation: generation(tree) });
  const interrupted = await controller.interruptAgent(AGENT_ID);
  assert.equal(interrupted.ok, true);
  if (interrupted.ok) assert.equal(interrupted.data.state, "interrupting");

  const blockedMessage = await controller.sendMessage({ agent_id: AGENT_ID, message: "中断屏障内" });
  assert.equal(blockedMessage.ok, false);
  if (!blockedMessage.ok) assert.equal(blockedMessage.error.code, "message_delivery_failed");

  const settledWait = waitForEvent(controller);
  fake.emitLifecycle({ type: "agent_settled", expected_generation: generation(tree) });
  const settled = await settledWait;
  assert.equal(settled.ok, true);
  if (settled.ok) {
    assert.equal(settled.data.outcome, "idle");
    assert.equal(settled.data.state, "idle");
  }
});

test("父端接纳事件可以在 settled 后登记，terminate 建立不可逆屏障并产生 terminal", async () => {
  const fake = new FakeSupervisor();
  const { controller, tree } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "终止测试" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  fake.emitLifecycle({ type: "agent_start", expected_generation: generation(tree) });
  const idleWait = waitForEvent(controller);
  fake.emitLifecycle({ type: "agent_settled", expected_generation: generation(tree) });
  const idle = await idleWait;
  assert.equal(idle.ok, true);
  if (idle.ok) assert.equal(idle.data.outcome, "idle");
  assert.equal(controller.notifySessionEvent(AGENT_ID, "reply"), false);
  assert.equal(controller.recordAcceptedSessionEvent(AGENT_ID, "reply"), true);
  const acceptedAfterSettled = await waitForEvent(controller);
  assert.equal(acceptedAfterSettled.ok, true);
  if (acceptedAfterSettled.ok) {
    assert.equal(acceptedAfterSettled.data.outcome, "reply");
    assert.equal(acceptedAfterSettled.data.state, "idle");
  }

  fake.emitLifecycle({ type: "agent_start", expected_generation: generation(tree) });
  const terminalWait = waitForEvent(controller);
  const terminated = await controller.terminateAgent(AGENT_ID);
  assert.equal(terminated.ok, true);
  if (terminated.ok) {
    assert.equal(terminated.data.state, "terminated");
    assert.equal(terminated.data.changed, true);
  }
  const terminal = await terminalWait;
  assert.equal(terminal.ok, true);
  if (terminal.ok) {
    assert.equal(terminal.data.outcome, "terminal");
    assert.equal(terminal.data.state, "terminated");
  }
  const after = await controller.sendMessage({ agent_id: AGENT_ID, message: "终止后" });
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, "agent_unavailable");
});
