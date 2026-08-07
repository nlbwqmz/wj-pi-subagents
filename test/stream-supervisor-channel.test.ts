import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  StreamSupervisorChannel,
  type SupervisorByteTransport,
} from "../src/stream-supervisor-channel.ts";
import { SupervisorRequestIdRegistry } from "../src/supervisor-channel.ts";
import type { AgentSnapshot } from "../src/tree-controller.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "root-test";
const CREDENTIAL = "stream-test-credential";

function snapshot(): AgentSnapshot {
  return Object.freeze({
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "流式子代理",
    depth: 1,
    state: "idle",
    pending_message_count: 0,
    revision: 1,
    observed_at: "2026-08-06T00:00:00.000Z",
  });
}

function channelPair(onReply?: (reply: { readonly text: string }) => boolean): {
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
    replies.push(reply.text);
    return true;
  });
  pair.parent.onEvent((event) => {
    throw new Error(`observer-${event.type}`);
  });
  pair.parent.onEvent((event) => events.push(event));
  await pair.child.bind(new AbortController().signal);
  await pair.parent.waitForReady(new AbortController().signal);
  await pair.child.waitForReady(new AbortController().signal);

  await pair.child.publishEvent({ type: "agent_settled", expected_generation: 2 });
  await pair.child.publishReply({ text: "安全回复" });
  await settleIo();
  assert.deepEqual(replies, ["安全回复"]);
  assert.deepEqual(events, [{
    root_id: ROOT_ID,
    agent_id: CHILD_ID,
    type: "agent_settled",
    expected_generation: 2,
  }]);
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
  await pair.parent.release();
  await pair.child.release();
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
