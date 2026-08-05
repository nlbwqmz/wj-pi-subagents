import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPERVISOR_CHANNEL_LIMITS,
  SupervisorFrameDecoder,
  SupervisorProtocolError,
  SupervisorRequestIdRegistry,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  createFakeSupervisorChannelPair,
  type SupervisorFrame,
} from "../src/supervisor-channel.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRANDCHILD_ID = "550e8400-e29b-41d4-a716-446655440001";
const SIBLING_ID = "550e8400-e29b-41d4-a716-446655440002";
const ROOT_ID = "root-test";
const CREDENTIAL = "test-one-time-credential";

function node(
  agentId: string,
  parentAgentId: string | null,
  depth: number,
  state: "idle" | "working" = "idle",
) {
  return {
    agent_id: agentId,
    parent_agent_id: parentAgentId,
    template_id: "researcher",
    name: "安全资料代理",
    depth,
    state,
    pending_message_count: 0,
    revision: 1,
    observed_at: "2026-08-05T12:00:00.000Z",
  } as const;
}

function handshake(
  pair: ReturnType<typeof createFakeSupervisorChannelPair>,
  childAgentId = CHILD_ID,
): void {
  pair.child.sendHello();
  pair.flush();
  pair.child.sendSnapshot([node(childAgentId, null, 1)], 1);
  pair.flush();
  assert.equal(pair.parent.getPublicState().state, "ready");
  assert.equal(pair.child.getPublicState().state, "ready");
}

test("长度边界 UTF-8 JSON 可处理分块与拼接帧，拒绝截断/损坏载荷", () => {
  const frame: SupervisorFrame = {
    protocol: "pi-subagent/1",
    kind: "event",
    stream_id: "stream_test",
    sender_agent_id: CHILD_ID,
    target_agent_id: null,
    seq: 1,
    payload: { root_id: ROOT_ID, type: "idle" },
  };
  const bytes = encodeSupervisorFrame(frame);
  const decoder = new SupervisorFrameDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(bytes.subarray(3)), [frame]);
  decoder.finish();
  const joined = new Uint8Array(bytes.byteLength * 2);
  joined.set(bytes);
  joined.set(bytes, bytes.byteLength);
  assert.equal(new SupervisorFrameDecoder().push(joined).length, 2);

  // 单条帧的上限不能错误限制一次 transport read 中包含的多条合法帧。
  const largeLimits = { maxFrameBytes: 1024, maxStringBytes: 900 };
  const largeFrame = {
    ...frame,
    payload: { root_id: ROOT_ID, type: "idle", padding: "x".repeat(700) },
  } as SupervisorFrame;
  const largeBytes = encodeSupervisorFrame(largeFrame, largeLimits);
  assert.ok(largeBytes.byteLength * 2 > largeLimits.maxFrameBytes + 4);
  const largeJoined = new Uint8Array(largeBytes.byteLength * 2);
  largeJoined.set(largeBytes);
  largeJoined.set(largeBytes, largeBytes.byteLength);
  assert.deepEqual(new SupervisorFrameDecoder(largeLimits).push(largeJoined), [largeFrame, largeFrame]);

  assert.throws(() => decodeSupervisorFrame(bytes.subarray(0, bytes.byteLength - 1)), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "invalid_frame";
  });
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] = 0xff;
  assert.throws(() => decodeSupervisorFrame(corrupt), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "invalid_utf8";
  });
});

test("握手校验根关联、直接父子身份、深度和一次性凭据", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  const hello = pair.child.startHandshake();
  const tampered = {
    ...hello,
    payload: { ...hello.payload, root_id: "other-root" },
  } as SupervisorFrame;
  assert.equal(pair.parent.receive(tampered).kind, "protocol_fault");
  assert.equal(pair.parent.getPublicState().state, "faulted");

  const validPair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  const validHello = validPair.child.startHandshake();
  const wrongCredential = {
    ...validHello,
    payload: { ...validHello.payload, credential: "d3Jvbmc" },
  } as SupervisorFrame;
  const wrongResult = validPair.parent.receive(wrongCredential);
  assert.deepEqual(wrongResult, { kind: "protocol_fault", error: "credential_mismatch" });
  assert.doesNotMatch(JSON.stringify(validPair.parent.getPublicState()), /credential|root-test|stream/i);
});

test("child 仅在首个完整快照被父端确认后进入 ready", () => {
  const pair = createFakeSupervisorChannelPair({ rootId: ROOT_ID, childAgentId: CHILD_ID, credential: CREDENTIAL });
  pair.child.sendHello();
  pair.flush();
  assert.equal(pair.parent.getPublicState().state, "awaiting_snapshot");
  assert.equal(pair.child.getPublicState().state, "awaiting_snapshot");
  assert.throws(() => pair.child.publishReply({ text: "过早回复" }), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "closed";
  });

  pair.child.sendSnapshot([node(CHILD_ID, null, 1)], 1);
  const acceptedSnapshot = pair.child.deliverNext();
  assert.equal(acceptedSnapshot?.kind, "accepted");
  assert.equal(pair.parent.getPublicState().state, "ready");
  assert.equal(pair.child.getPublicState().state, "awaiting_snapshot");

  pair.parent.deliverNext();
  assert.equal(pair.child.getPublicState().state, "ready");
});

test("完整握手后快照按 subtree_revision 原子替换并分配 tree_revision", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  assert.deepEqual(pair.parent.getTreeSnapshot().nodes.map((item) => item.agent_id), [CHILD_ID]);
  assert.equal(pair.parent.getTreeSnapshot().tree_revision, 1);

  pair.child.sendSnapshot([
    node(CHILD_ID, null, 1, "working"),
    node(GRANDCHILD_ID, CHILD_ID, 2, "idle"),
  ], 2);
  pair.flush();
  assert.equal(pair.parent.getTreeSnapshot().tree_revision, 2);
  assert.deepEqual(pair.parent.getTreeSnapshot().nodes.map((item) => item.agent_id), [CHILD_ID, GRANDCHILD_ID]);

  // 新 seq 但旧 subtree_revision 是迟到快照：只 ACK，不改变缓存或根修订。
  const newer = pair.child.publishSnapshot([node(CHILD_ID, null, 1, "working")], 3);
  const stale = { ...newer, payload: { ...newer.payload, subtree_revision: 1 } } as SupervisorFrame;
  const staleResult = pair.parent.receive(stale);
  assert.equal(staleResult.kind, "accepted");
  if (staleResult.kind === "accepted") assert.equal(staleResult.applied, false);
  assert.equal(pair.parent.getTreeSnapshot().tree_revision, 2);
  assert.equal(pair.parent.getTreeSnapshot().nodes.length, 2);
});

test("重复帧只回 ACK，断序仅请求一次 reset 快照且不应用缺口帧", () => {
  const pair = createFakeSupervisorChannelPair({ rootId: ROOT_ID, childAgentId: CHILD_ID, credential: CREDENTIAL });
  handshake(pair);
  pair.child.sendSnapshot([node(CHILD_ID, null, 1, "working")], 2);
  pair.child.sendSnapshot([node(CHILD_ID, null, 1, "working")], 3);
  pair.child.sendSnapshot([node(CHILD_ID, null, 1)], 4);
  const secondFrame = pair.child.takeNextFrame();
  assert.ok(secondFrame);
  const secondResult = pair.parent.receive(secondFrame);
  assert.equal(secondResult.kind, "accepted");
  const missingFrame = pair.child.takeNextFrame();
  assert.ok(missingFrame); // 丢弃 seq=3，制造可控断序
  const fourthFrame = pair.child.takeNextFrame();
  assert.ok(fourthFrame);
  const duplicate = pair.parent.receive(secondFrame);
  assert.equal(duplicate.kind, "duplicate");
  const gap = pair.parent.receive(fourthFrame);
  assert.equal(gap.kind, "gap");
  if (gap.kind !== "gap") return;
  assert.equal(pair.parent.getTreeSnapshot().nodes[0]?.state, "working");
  const repeatedGap = pair.parent.receive(fourthFrame);
  assert.equal(repeatedGap.kind, "gap");
  if (repeatedGap.kind === "gap") assert.equal(repeatedGap.request_id, gap.request_id);

  // 模拟 child 对 snapshot_request 的 reset 响应，必须使用最新完整快照。
  // 先按父方向的 seq 顺序交付 ACK，再交付 snapshot_request，避免把传输层
  // 的 ACK 缺口误当成重同步响应。
  if (secondResult.kind === "accepted") {
    for (const frame of secondResult.outbound) pair.parent.send(frame);
  }
  if (duplicate.kind === "duplicate") {
    for (const frame of duplicate.outbound) pair.parent.send(frame);
  }
  for (const frame of gap.outbound) pair.parent.send(frame);
  pair.parent.deliverNext();
  pair.parent.deliverNext();
  pair.parent.deliverNext();
  pair.child.deliverNext();
  const resetFrame = pair.child.takeNextFrame();
  assert.ok(resetFrame);
  const reset = pair.parent.receive(resetFrame);
  assert.equal(reset.kind, "accepted");
  assert.equal(pair.parent.getTreeSnapshot().nodes[0]?.state, "idle");
});

test("普通回复按 reply_seq 有序注入并以累计 ACK 去重，窗口有界", () => {
  const replies: string[] = [];
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    onReply: (reply) => {
      replies.push(reply.text);
      return true;
    },
  });
  handshake(pair);
  const first = pair.child.publishReply({ text: "第一条" });
  const second = pair.child.publishReply({ text: "第二条" });
  const firstOutOfOrder = {
    ...first,
    payload: second.payload,
  } as SupervisorFrame;
  const secondOutOfOrder = {
    ...second,
    payload: first.payload,
  } as SupervisorFrame;
  const secondResult = pair.parent.receive(firstOutOfOrder);
  assert.equal(secondResult.kind, "accepted");
  assert.deepEqual(replies, []);
  const firstResult = pair.parent.receive(secondOutOfOrder);
  assert.equal(firstResult.kind, "accepted");
  assert.deepEqual(replies, ["第一条", "第二条"]);
  assert.equal(pair.parent.getPublicState().pending_reply_count, 0);
  assert.equal(pair.child.getPublicState().pending_reply_count, 2);

  // 父侧按自己的传输序号依次回传 ACK，child 收到累计 reply ACK 后释放发送窗口；
  // 重复 reply 不再次注入。
  if (secondResult.kind === "accepted") {
    for (const frame of secondResult.outbound) pair.parent.send(frame);
  }
  if (firstResult.kind === "accepted") {
    for (const frame of firstResult.outbound) pair.parent.send(frame);
  }
  pair.parent.deliverNext();
  pair.parent.deliverNext();
  pair.parent.deliverNext();
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
  const duplicate = pair.parent.receive(firstOutOfOrder);
  assert.equal(duplicate.kind, "duplicate");
  assert.deepEqual(replies, ["第一条", "第二条"]);

  const limited = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    limits: { maxReplyWindow: 1 },
  });
  handshake(limited);
  limited.child.publishReply({ text: "占用窗口" });
  assert.throws(() => limited.child.publishReply({ text: "超限" }), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "reply_window_full";
  });
});

test("回复注入未成功时不发送 reply ACK，也不把通道裁决为协议故障", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    onReply: () => false,
  });
  handshake(pair);
  const reply = pair.child.publishReply({ text: "等待父会话可用" });
  const result = pair.parent.receive(reply);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.replies, []);
  assert.equal(result.outbound.some((frame) => frame.payload.kind === "reply"), false);
  assert.equal(pair.parent.getPublicState().state, "ready");
  assert.equal(pair.child.getPublicState().pending_reply_count, 1);
});

test("有限重连使用新流，首快照确认后重放未确认回复且丢弃旧流", () => {
  const replies: string[] = [];
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    onReply: (reply) => {
      replies.push(reply.text);
      return true;
    },
  });
  handshake(pair);
  const oldReply = pair.child.publishReply({ text: "断线前已到达" });
  assert.equal(pair.parent.receive(oldReply).kind, "accepted");
  assert.deepEqual(replies, ["断线前已到达"]);
  assert.equal(pair.child.getPublicState().pending_reply_count, 1);

  assert.equal(pair.parent.injectEof().kind, "eof");
  assert.equal(pair.child.injectEof().kind, "eof");
  assert.equal(pair.parent.getPublicState().state, "resyncing");
  assert.equal(pair.child.getPublicState().state, "resyncing");
  assert.deepEqual(pair.parent.receive(oldReply), { kind: "discarded", reason: "old_stream" });

  const newHello = pair.child.sendHello();
  assert.notEqual(newHello.stream_id, oldReply.stream_id);
  assert.equal(newHello.seq, 1);
  pair.flush();
  assert.equal(pair.parent.getPublicState().state, "awaiting_snapshot");
  assert.equal(pair.child.getPublicState().state, "awaiting_snapshot");

  pair.child.sendSnapshot([node(CHILD_ID, null, 1)], 1);
  pair.flush();
  assert.equal(pair.parent.getPublicState().state, "ready");
  assert.equal(pair.child.getPublicState().state, "ready");
  assert.deepEqual(replies, ["断线前已到达"]);
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
});

test("根会话共享请求号分配器，不因旧窗口淘汰而复用 request_id", () => {
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const first = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const second = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: SIBLING_ID,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  handshake(first);
  handshake(second, SIBLING_ID);
  const requestIds = new Set<string>();
  for (let index = 0; index < 130; index += 1) {
    const request = first.parent.requestSnapshot();
    assert.ok(request.request_id);
    requestIds.add(request.request_id);
    first.parent.send(request);
    first.flush();
    assert.equal(first.parent.getPublicState().state, "ready");
  }
  const siblingRequest = second.parent.requestSnapshot();
  assert.ok(siblingRequest.request_id);
  requestIds.add(siblingRequest.request_id);
  assert.equal(requestIds.size, 131);
});

test("生命周期 event 只携带安全事实，并可由父监督器递交给树控制器", () => {
  const pair = createFakeSupervisorChannelPair({ rootId: ROOT_ID, childAgentId: CHILD_ID, credential: CREDENTIAL });
  handshake(pair);
  const event = pair.child.publishEvent({
    type: "agent_settled",
    expected_generation: 4,
  });
  const result = pair.parent.receive(event);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.deepEqual(result.event, {
      root_id: ROOT_ID,
      agent_id: CHILD_ID,
      type: "agent_settled",
      expected_generation: 4,
    });
  }
  assert.throws(() => pair.child.publishEvent({ type: "unknown_event" as never }), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "invalid_frame";
  });
  const unsafe = pair.child.publishEvent({ type: "agent_settled" });
  const injected = {
    ...unsafe,
    payload: { ...unsafe.payload, prompt: "secret-canary" },
  } as SupervisorFrame;
  assert.deepEqual(pair.parent.receive(injected), { kind: "protocol_fault", error: "invalid_frame" });
});

test("EOF、损坏载荷、终止屏障和旧流不会伪造健康状态；公开状态无秘密字段", () => {
  const pair = createFakeSupervisorChannelPair({ rootId: ROOT_ID, childAgentId: CHILD_ID, credential: CREDENTIAL });
  handshake(pair);
  pair.parent.establishTerminationBarrier();
  const late = pair.child.publishSnapshot([node(CHILD_ID, null, 1, "working")], 2);
  assert.deepEqual(pair.parent.receive(late), { kind: "discarded", reason: "termination_barrier" });
  assert.equal(pair.parent.receiveEof().kind, "eof");
  assert.equal(pair.parent.getPublicState().state, "closed");
  assert.doesNotMatch(JSON.stringify(pair.parent.getPublicState()), /test-one-time|credential|endpoint|stream|seq|path|stack/i);

  const corruptPair = createFakeSupervisorChannelPair({ rootId: ROOT_ID, childAgentId: CHILD_ID, credential: CREDENTIAL });
  const corrupt = new Uint8Array([0, 0, 0, SUPERVISOR_CHANNEL_LIMITS.maxFrameBytes + 1]);
  assert.equal(corruptPair.parent.inject(corrupt).kind, "protocol_fault");
  assert.equal(corruptPair.parent.getPublicState().state, "faulted");
});
