import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ChildReplyCoordinator } from "../src/child-reply-coordinator.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
  type ChildMessageEnvelope,
} from "../src/child-reply-envelope.ts";
import {
  StreamSupervisorChannel,
  type SupervisorByteTransport,
} from "../src/stream-supervisor-channel.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorRequestIdRegistry,
  type SupervisorCapabilityManifest,
  type SupervisorReply,
} from "../src/supervisor-channel.ts";
import type { AgentSnapshot } from "../src/tree-controller.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const TURN_ID = "550e8400-e29b-41d4-a716-446655440001";
const TASK_ID = "450e8400-e29b-41d4-a716-446655440001";
const COMMIT_ID = "750e8400-e29b-41d4-a716-446655440001";
const ROOT_ID = "root-test";
const CREDENTIAL = "stream-test-credential";

function workingReply(text: string): ChildMessageEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: CHILD_ID,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    text,
  };
}

function finalReply(text: string): ChildFinalEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: CHILD_ID,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    commit_id: COMMIT_ID,
    run_state: "settled",
    output_state: "present",
    text,
  };
}

function capabilityManifest(): SupervisorCapabilityManifest {
  return {
    protocol_version: SUPERVISOR_PROTOCOL_VERSION,
    business_active_tools: ["bash", "read"],
    system_active_tools: ["reply_to_parent"],
    system_tool_sources: { reply_to_parent: "extension:wj-pi-subagents" },
    provider: "openai",
    model: "gpt-5.2-codex",
    thinking: "high",
    self_extension_path: "C:\\pi\\index.ts",
  };
}

function snapshot(): AgentSnapshot {
  return Object.freeze({
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "流式子代理",
    depth: 1,
    state: "idle",
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    revision: 1,
  });
}

function channelPair(onReply?: (reply: SupervisorReply) => boolean): {
  readonly parent: StreamSupervisorChannel;
  readonly child: StreamSupervisorChannel;
  readonly parentToChild: PassThrough;
  readonly childToParent: PassThrough;
} {
  // 两条 PassThrough 分别代表双向 pipe；每个端点只持有自己的 stdin/stdout。
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parentTransport: SupervisorByteTransport = {
    stdin: parentToChild,
    stdout: childToParent,
  } as SupervisorByteTransport;
  const childTransport: SupervisorByteTransport = {
    stdin: childToParent,
    stdout: parentToChild,
  } as SupervisorByteTransport;
  const parent = new StreamSupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: parentTransport,
    ...(onReply === undefined ? {} : { onReply }),
  });
  const child = new StreamSupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: childTransport,
    initialSnapshot: [snapshot()],
    initialSubtreeRevision: 1,
  });
  return { parent, child, parentToChild, childToParent };
}

async function settleIo(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("真实字节流完成 child hello、首快照、ACK 和 ready 双握手", async () => {
  const pair = channelPair();
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);
  assert.equal(pair.parent.isReady(), true);
  assert.equal(pair.child.isReady(), true);
  assert.equal(pair.parent.getPublicState().snapshot_node_count, 1);
  assert.equal(pair.parent.getPublicState().subtree_revision, 1);
  await pair.parent.release();
  await pair.child.release();
});

test("stream transport 在 ready 后转发一次 capability 并缓存给迟到观察者", async () => {
  const pair = channelPair();
  const observed: SupervisorCapabilityManifest[] = [];
  pair.parent.onCapability(() => {
    throw new Error("capability observer");
  });
  pair.parent.onCapability((capability) => observed.push(capability));
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);
  assert.equal(pair.parent.getCapability(), undefined);

  await pair.child.publishCapability(capabilityManifest());
  await settleIo();
  assert.deepEqual(observed, [capabilityManifest()]);
  assert.deepEqual(pair.parent.getCapability(), capabilityManifest());
  assert.equal("capability" in pair.parent.getPublicState(), false);

  const replayed: SupervisorCapabilityManifest[] = [];
  pair.parent.onCapability((capability) => replayed.push(capability));
  assert.deepEqual(replayed, [capabilityManifest()]);
  await assert.rejects(pair.child.publishCapability(capabilityManifest()));
  await pair.parent.release();
  await pair.child.release();
});

test("task assignment 等待 transport ACK，task_started 在同一有序流传递", async () => {
  const pair = channelPair();
  const assignments: unknown[] = [];
  const starts: unknown[] = [];
  pair.child.onTaskAssignment((assignment) => assignments.push(assignment));
  pair.parent.onTaskStarted((started) => starts.push(started));
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);

  await pair.parent.publishTaskAssignmentAndWaitForAck({
    message_id: "msg_650e8400-e29b-41d4-a716-446655440006",
    task_id: TASK_ID,
    mode: "prompt",
  });
  assert.deepEqual(assignments, [{
    message_id: "msg_650e8400-e29b-41d4-a716-446655440006",
    task_id: TASK_ID,
    mode: "prompt",
  }]);

  await pair.child.publishTaskStarted({ task_id: TASK_ID, turn_id: TURN_ID });
  assert.deepEqual(starts, [{ task_id: TASK_ID, turn_id: TURN_ID }]);
  await pair.parent.release();
  await pair.child.release();
});

test("task_started 写入后 ACK 迟到不阻塞同一监督流上的 final", async () => {
  const observed: string[] = [];
  const pair = channelPair((reply) => {
    observed.push(reply.envelope.kind);
    return true;
  });
  pair.parent.onTaskStarted(() => observed.push("task_started"));
  const signal = new AbortController().signal;
  await pair.parent.bind(signal);
  await pair.child.bind(signal);
  await Promise.all([pair.parent.waitForReady(signal), pair.child.waitForReady(signal)]);

  const coordinator = new ChildReplyCoordinator({
    agentId: CHILD_ID,
    port: pair.child,
    taskIdFactory: () => TASK_ID,
    turnIdFactory: () => TURN_ID,
    commitIdFactory: () => COMMIT_ID,
  });
  coordinator.observeTaskAssignment({
    message_id: "msg_650e8400-e29b-41d4-a716-446655440006",
    task_id: TASK_ID,
    mode: "prompt",
  });

  // 父端仍可读取 child 帧，只暂停返回 child 的 transport/reply ACK。
  pair.parentToChild.pause();
  try {
    coordinator.observeAgentStart();
    coordinator.observeAssistantMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "ACK 迟到仍应发布" }],
      },
    });
    coordinator.observeAgentEnd();
    coordinator.settle();
    await settleIo();
    await settleIo();

    assert.deepEqual([...observed], ["task_started", "final"]);
  } finally {
    pair.parentToChild.resume();
    await settleIo();
    await pair.parent.release();
    await pair.child.release();
  }
});

test("协调压缩请求只允许 child 发起，并等待 parent 业务响应", async () => {
  const pair = channelPair();
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);

  const parentPrepareRequests: unknown[] = [];
  pair.parent.onCompactionPrepare((request) => parentPrepareRequests.push(request));
  const childPrepare = pair.child.requestCompactionPrepare("compact-child-request");
  await settleIo();
  assert.deepEqual(parentPrepareRequests, [{ transaction_id: "compact-child-request" }]);
  let childPrepareSettled = false;
  void childPrepare.then(() => { childPrepareSettled = true; });
  await settleIo();
  assert.equal(childPrepareSettled, false);
  await pair.parent.respondCompactionPrepared({ transaction_id: "compact-child-request", accepted: true });
  assert.equal(await childPrepare, true);

  const parentCompleteRequests: unknown[] = [];
  pair.parent.onCompactionComplete((request) => parentCompleteRequests.push(request));
  const childComplete = pair.child.requestCompactionComplete("compact-child-request", "failed");
  await settleIo();
  assert.deepEqual(parentCompleteRequests, [{
    transaction_id: "compact-child-request",
    outcome: "failed",
    continuation_expected: false,
  }]);
  await pair.parent.respondCompactionCompleted({ transaction_id: "compact-child-request", accepted: false });
  assert.equal(await childComplete, false);

  await assert.rejects(pair.parent.requestCompactionPrepare("invalid-parent-request"));
  await assert.rejects(pair.parent.requestCompactionComplete("invalid-parent-request", "failed"));
  await assert.rejects(pair.child.respondCompactionPrepared({
    transaction_id: "invalid-child-response",
    accepted: true,
  }));
  await assert.rejects(pair.child.respondCompactionCompleted({
    transaction_id: "invalid-child-response",
    accepted: true,
  }));

  await pair.parent.release();
  await pair.child.release();
});

test("complete 等待取消后允许同一事务发送 not_started 补偿", async () => {
  const pair = channelPair();
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);

  const requests: unknown[] = [];
  pair.parent.onCompactionComplete((request) => requests.push(request));
  const firstController = new AbortController();
  const firstResult = pair.child
    .requestCompactionComplete("compact-retry-after-abort", "succeeded", firstController.signal, true)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await settleIo();
  firstController.abort();
  const firstError = await firstResult;
  assert.equal(firstError instanceof Error ? firstError.name : undefined, "AbortError");

  const cleanup = pair.child.requestCompactionComplete("compact-retry-after-abort", "not_started");
  await settleIo();
  assert.deepEqual(requests, [
    {
      transaction_id: "compact-retry-after-abort",
      outcome: "succeeded",
      continuation_expected: true,
    },
    {
      transaction_id: "compact-retry-after-abort",
      outcome: "not_started",
      continuation_expected: false,
    },
  ]);
  await pair.parent.respondCompactionCompleted({
    transaction_id: "compact-retry-after-abort",
    accepted: false,
  });
  assert.equal(await cleanup, false);

  await pair.parent.release();
  await pair.child.release();
});

test("同 turn 的后续 final 只推进 ACK，不覆盖首个已接纳 final", async () => {
  const received: string[] = [];
  const pair = channelPair((reply) => {
    if (reply.envelope.kind === "final") received.push(reply.envelope.text ?? "");
    return true;
  });
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);

  await pair.child.publishReplyAndWaitForAck(finalReply("首个 final"));
  await pair.child.publishReplyAndWaitForAck({
    ...finalReply("不得覆盖"),
    commit_id: "850e8400-e29b-41d4-a716-446655440001",
  });
  assert.deepEqual(received, ["首个 final"]);
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
  await pair.parent.release();
  await pair.child.release();
});

test("task_started 与 final ACK 后仍可在同一流完成控制请求响应", async () => {
  const pair = channelPair(() => true);
  const response = new Promise<unknown>((resolve) => {
    pair.child.onControlResponse(resolve);
  });
  pair.parent.onControlRequest((request) => {
    void pair.parent.publishControlResponse({
      operation_id: request.operation_id,
      ok: true,
      data: [],
    });
  });
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);

  await pair.child.publishTaskStarted({ task_id: TASK_ID, turn_id: TURN_ID });
  await pair.child.publishReplyAndWaitForAck(finalReply("完成"));
  await pair.child.publishControlRequest({
    operation_id: "650e8400-e29b-41d4-a716-446655440008",
    operation: "list_templates",
    route: [CHILD_ID],
    body: {},
  });
  assert.deepEqual(await response, {
    operation_id: "650e8400-e29b-41d4-a716-446655440008",
    ok: true,
    data: [],
  });
  await pair.parent.release();
  await pair.child.release();
});

test("父端在原子接受完整快照后向订阅者发布安全副本", async () => {
  const pair = channelPair();
  const snapshots: unknown[] = [];
  pair.parent.onSnapshot((value) => snapshots.push(value));
  await pair.parent.bind(new AbortController().signal);
  await pair.child.bind(new AbortController().signal);
  await Promise.all([
    pair.parent.waitForReady(new AbortController().signal),
    pair.child.waitForReady(new AbortController().signal),
  ]);
  assert.deepEqual(snapshots, [{
    scope_agent_id: CHILD_ID,
    subtree_revision: 1,
    nodes: [snapshot()],
  }]);
  await pair.parent.release();
  await pair.child.release();
});

test("回复与生命周期事件通过安全回调传递，观察者异常不破坏传输", async () => {
  const replies: string[] = [];
  const events: unknown[] = [];
  const pair = channelPair((reply) => {
    replies.push(reply.envelope.text ?? "");
    return true;
  });
  pair.parent.onEvent((event) => {
    throw new Error(`observer-${event.type}`);
  });
  pair.parent.onEvent((event) => events.push(event));
  await pair.child.bind(new AbortController().signal);
  await pair.parent.waitForReady(new AbortController().signal);
  await pair.child.waitForReady(new AbortController().signal);

  await pair.child.publishEvent({ type: "startup_ready", expected_generation: 2 });
  await pair.child.publishReply(finalReply("安全回复"));
  await settleIo();
  assert.deepEqual(replies, ["安全回复"]);
  assert.deepEqual(events, [{
    root_id: ROOT_ID,
    agent_id: CHILD_ID,
    type: "startup_ready",
    expected_generation: 2,
  }]);
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
  await pair.parent.release();
  await pair.child.release();
});

test("child reply 发布等待父端累计 ACK，message 与非空 final 共用序号域", async () => {
  const received: Array<{ kind: string; text: string }> = [];
  const pair = channelPair((reply) => {
    received.push({ kind: reply.envelope.kind, text: reply.envelope.text ?? "" });
    return true;
  });
  await pair.child.bind(new AbortController().signal);
  await pair.parent.waitForReady(new AbortController().signal);
  await pair.child.waitForReady(new AbortController().signal);

  const message = pair.child.publishReplyAndWaitForAck(workingReply("进度"));
  await settleIo();
  await message;
  const final = pair.child.publishReplyAndWaitForAck(finalReply("完成"));
  await settleIo();
  await final;
  assert.deepEqual(received, [
    { kind: "message", text: "进度" },
    { kind: "final", text: "完成" },
  ]);
  await pair.parent.release();
  await pair.child.release();
});

test("final 接纳回调重入发布下一任务时保持帧序和 reply ACK", async () => {
  let pair!: ReturnType<typeof channelPair>;
  let assignment: Promise<void> | undefined;
  const assignments: Array<{ readonly task_id: string; readonly mode: string }> = [];
  pair = channelPair(() => {
    assignment = pair.parent.publishTaskAssignmentAndWaitForAck({
      message_id: "msg_650e8400-e29b-41d4-a716-446655440008",
      task_id: "650e8400-e29b-41d4-a716-446655440009",
      mode: "prompt",
    });
    return true;
  });
  pair.child.onTaskAssignment((value) => assignments.push({
    task_id: value.task_id,
    mode: value.mode,
  }));
  await pair.child.bind(new AbortController().signal);
  await pair.parent.waitForReady(new AbortController().signal);
  await pair.child.waitForReady(new AbortController().signal);

  const finalAck = pair.child.publishReplyAndWaitForAck(finalReply("完成并继续下一任务"));
  await settleIo();
  assert.ok(assignment);
  await Promise.all([finalAck, assignment]);
  assert.deepEqual(assignments, [{
    task_id: "650e8400-e29b-41d4-a716-446655440009",
    mode: "prompt",
  }]);
  assert.equal(pair.parent.isReady(), true);
  assert.equal(pair.child.isReady(), true);

  await pair.parent.release();
  await pair.child.release();
});

test("reply ACK 等待在协议故障和通道释放时确定失败且不产生未处理拒绝", async () => {
  const faulted = channelPair(() => false);
  await faulted.child.bind(new AbortController().signal);
  await faulted.parent.waitForReady(new AbortController().signal);
  await faulted.child.waitForReady(new AbortController().signal);

  const waitingForFault = faulted.child.publishReplyAndWaitForAck(workingReply("等待确认"));
  await settleIo();
  assert.equal(faulted.child.getPublicState().pending_reply_count, 1);
  faulted.child.failProtocol();
  await assert.rejects(waitingForFault, /监督回复未获确认/);
  assert.equal(faulted.child.getPublicState().state, "faulted");
  await faulted.parent.release();
  await faulted.child.release();

  const released = channelPair(() => false);
  await released.child.bind(new AbortController().signal);
  await released.parent.waitForReady(new AbortController().signal);
  await released.child.waitForReady(new AbortController().signal);

  const waitingForRelease = released.child.publishReplyAndWaitForAck(finalReply("最终结果"));
  await settleIo();
  await released.child.release();
  await assert.rejects(waitingForRelease, /监督回复未获确认/);
  await released.parent.release();
});

test("协议损坏和 EOF 只通知一次稳定故障，并支持可取消 ready 等待", async () => {
  const pair = channelPair();
  const faults: string[] = [];
  pair.parent.onFault((fault) => faults.push(fault));
  const controller = new AbortController();
  const waiting = pair.parent.waitForReady(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });

  // 长度前缀超过边界，父端应进入 protocol_fault；随后 EOF 不得重复通知。
  const corrupt = new Uint8Array(4);
  new DataView(corrupt.buffer).setUint32(0, 65 * 1024, false);
  pair.childToParent.write(corrupt);
  await settleIo();
  pair.childToParent.end();
  await settleIo();
  assert.deepEqual(faults, ["protocol_fault"]);
  assert.equal(pair.parent.getPublicState().state, "faulted");
  assert.equal(await pair.parent.waitForClose(Date.now() + 20), "released");
  await pair.parent.release();
  await pair.child.release();
});

test("流式监督通道在 waitForReady 尚未开始时故障不产生未处理拒绝", async () => {
  const pair = channelPair();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await pair.parent.bind(new AbortController().signal);
    pair.parent.failProtocol();
    await settleIo();
    assert.deepEqual(unhandled, []);
    await assert.rejects(
      pair.parent.waitForReady(new AbortController().signal),
      /监督通道不可用/,
    );
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await pair.parent.release();
    await pair.child.release();
  }
});

test("终止屏障发送 close 后拒绝迟到帧，写入失败不会毒化后续队列", async () => {
  const pair = channelPair();
  await pair.child.bind(new AbortController().signal);
  await pair.parent.waitForReady(new AbortController().signal);
  await pair.child.waitForReady(new AbortController().signal);
  pair.parent.establishTerminationBarrier();
  await pair.parent.requestClose(new AbortController().signal);
  await settleIo();
  assert.equal(pair.child.getPublicState().state, "closing");
  // 关闭端点后重复 close 请求只能被安全吞掉，不能让 Promise 永久悬挂。
  await pair.parent.release();
  await pair.child.release();
});
