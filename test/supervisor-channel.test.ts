import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
  type ChildMessageEnvelope,
} from "../src/child-reply-envelope.ts";
import {
  SUPERVISOR_CHANNEL_LIMITS,
  SupervisorFrameDecoder,
  FakeSupervisorChannel,
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
const TURN_ID = "550e8400-e29b-41d4-a716-446655440003";
const TASK_ID = "450e8400-e29b-41d4-a716-446655440003";
const COMMIT_ID = "750e8400-e29b-41d4-a716-446655440003";
const ROOT_ID = "root-test";
const CREDENTIAL = "test-one-time-credential";

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
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    ...(state === "working" ? { activity: { phase: "processing" as const } } : {}),
    revision: 1,
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

function assertProtocolError(action: () => unknown, code: SupervisorProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === code;
  });
}

test("task assignment 与 task_started 在同一累计 ACK 顺序域传递 UUIDv4 身份", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);

  pair.parent.send(pair.parent.publishTaskAssignment({
    message_id: "msg_650e8400-e29b-41d4-a716-446655440005",
    task_id: TASK_ID,
    mode: "prompt",
  }));
  const assignment = pair.parent.deliverNext();
  assert.equal(assignment?.kind, "accepted");
  if (assignment?.kind === "accepted") {
    assert.deepEqual(assignment.task_assignment, {
      message_id: "msg_650e8400-e29b-41d4-a716-446655440005",
      task_id: TASK_ID,
      mode: "prompt",
    });
  }
  pair.flush();

  pair.child.send(pair.child.publishTaskStarted({ task_id: TASK_ID, turn_id: TURN_ID }));
  const started = pair.child.deliverNext();
  assert.equal(started?.kind, "accepted");
  if (started?.kind === "accepted") {
    assert.deepEqual(started.task_started, { task_id: TASK_ID, turn_id: TURN_ID });
    assert.equal(started.outbound.some((frame) => frame.kind === "ack"), true);
  }
  pair.flush();

  assertProtocolError(() => pair.child.publishTaskStarted({
    task_id: TASK_ID,
    turn_id: "550e8400-e29b-11d4-a716-446655440003",
  }), "invalid_frame");
});

test("长度边界 UTF-8 JSON 可处理分块与拼接帧，拒绝截断/损坏载荷", () => {
  const frame: SupervisorFrame = {
    protocol: "pi-subagent/6",
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
  assert.throws(() => encodeSupervisorFrame({ ...frame, unexpected: "不得透传" }), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "invalid_frame";
  });
  assert.throws(() => encodeSupervisorFrame({ ...frame, protocol: "pi-subagent/1" }), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "protocol_mismatch";
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
  assert.throws(() => pair.child.publishReply(finalReply("过早回复")), (error: unknown) => {
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

test("递归快照只往返固定活动阶段、工具类别和计数", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  pair.child.sendSnapshot([Object.freeze({
    ...node(CHILD_ID, null, 1, "working"),
    activity: Object.freeze({
      phase: "executing_tools" as const,
      category: "editing" as const,
      active_count: 2,
    }),
  })], 2);
  pair.flush();
  assert.deepEqual(pair.parent.getTreeSnapshot().nodes[0]?.activity, {
    phase: "executing_tools",
    category: "editing",
    active_count: 2,
  });

  assertProtocolError(() => pair.child.publishSnapshot([Object.freeze({
    ...node(CHILD_ID, null, 1, "working"),
    observed_at: "2026-08-05T12:00:01.000Z",
  })], 3), "snapshot_invalid");
  assertProtocolError(() => pair.child.publishSnapshot([Object.freeze({
    ...node(CHILD_ID, null, 1, "working"),
    activity: {
      phase: "executing_tools",
      category: "editing",
      active_count: 1,
      path: "D:\\private\\secret-canary.txt",
    },
  })], 3), "snapshot_invalid");
  assertProtocolError(() => pair.child.publishSnapshot([Object.freeze({
    ...node(CHILD_ID, null, 1, "working"),
    state: "failed" as const,
    error: Object.freeze({
      code: "internal_error" as const,
      message: "D:\\private\\secret-canary.txt",
      retryable: false,
    }),
  })], 3), "snapshot_invalid");
  assertProtocolError(() => pair.child.publishSnapshot([Object.freeze({
    ...node(CHILD_ID, null, 1),
    state: "starting" as const,
    activity: Object.freeze({
      phase: "executing_tools" as const,
      category: "running" as const,
      active_count: 1,
    }),
  })], 3), "snapshot_invalid");
  assert.doesNotMatch(JSON.stringify(pair.parent.getTreeSnapshot()), /secret-canary|private/i);
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
      replies.push(reply.envelope.text ?? "");
      return true;
    },
  });
  handshake(pair);
  const first = pair.child.publishReply(workingReply("第一条"));
  const second = pair.child.publishReply(workingReply("第二条"));
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
  limited.child.publishReply(finalReply("占用窗口"));
  assert.throws(() => limited.child.publishReply(finalReply("超限")), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "reply_window_full";
  });
});

test("工作中 message 为 final 预留窗口槽位，二者按同一 reply_seq 顺序提交", () => {
  const replies: Array<{ kind: string; text: string }> = [];
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    limits: { maxReplyWindow: 3 },
    onReply: (reply) => {
      replies.push({ kind: reply.envelope.kind, text: reply.envelope.text ?? "" });
      return true;
    },
  });
  handshake(pair);

  const first = pair.child.publishReply(workingReply("阶段一"));
  const second = pair.child.publishReply(workingReply("阶段二"));
  assert.throws(
    () => pair.child.publishReply(workingReply("不得占用 final 槽位")),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "reply_window_full",
  );
  const final = pair.child.publishReply(finalReply("最终结果"));
  assert.throws(
    () => pair.child.publishReply(finalReply("窗口已满")),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "reply_window_full",
  );

  const results = [
    pair.parent.receive(first),
    pair.parent.receive(second),
    pair.parent.receive(final),
  ];
  assert.deepEqual(replies, [
    { kind: "message", text: "阶段一" },
    { kind: "message", text: "阶段二" },
    { kind: "final", text: "最终结果" },
  ]);

  const outbound = results.flatMap((result) => result.kind === "accepted" ? [...result.outbound] : []);
  const replyAckResults = outbound.map((frame) => pair.child.receive(frame));
  assert.deepEqual(
    replyAckResults.flatMap((result) =>
      result.kind === "accepted" && result.reply_ack !== undefined ? [result.reply_ack] : []),
    [1, 2, 3],
  );
  const finalReplyAck = [...outbound].reverse().find((frame) => frame.payload.kind === "reply");
  assert.ok(finalReplyAck);
  assert.equal(pair.child.receive(finalReplyAck).kind, "duplicate");
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
});

test("原始 v6 reply 必须携带合法 envelope，且 message/final 都拒绝图片字段", () => {
  const missingEnvelope = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(missingEnvelope);
  const valid = missingEnvelope.child.publishReply(finalReply("最终结果"));
  const invalid = {
    ...valid,
    payload: { reply_seq: valid.payload.reply_seq },
  } as SupervisorFrame;
  assert.deepEqual(missingEnvelope.parent.receive(invalid), {
    kind: "protocol_fault",
    error: "reply_invalid",
  });

  const emptyIncomingFinal = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(emptyIncomingFinal);
  const validIncomingFinal = emptyIncomingFinal.child.publishReply(finalReply("最终结果"));
  const {
    text: _discardedText,
    ...envelopeWithoutText
  } = validIncomingFinal.payload.envelope as Record<string, unknown>;
  const forgedEmptyFinal = {
    ...validIncomingFinal,
    payload: {
      ...validIncomingFinal.payload,
      envelope: envelopeWithoutText,
    },
  } as SupervisorFrame;
  assert.deepEqual(emptyIncomingFinal.parent.receive(forgedEmptyFinal), {
    kind: "protocol_fault",
    error: "reply_invalid",
  });

  const emptyMessage = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(emptyMessage);
  assert.throws(
    () => emptyMessage.child.publishReply(workingReply("   ")),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "reply_invalid",
  );
  assert.throws(
    () => emptyMessage.child.publishReply(finalReply("")),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "reply_invalid",
  );
  assert.throws(
    () => emptyMessage.child.publishReply({
      ...finalReply("不得携带图片"),
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    } as never),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "reply_invalid",
  );
  assert.throws(
    () => emptyMessage.child.publishReply({
      ...workingReply("不得携带图片"),
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    } as never),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "reply_invalid",
  );
});

test("回复注入未成功时保留正文，父会话恢复后重试并发送 reply ACK", () => {
  let parentAvailable = false;
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    onReply: () => parentAvailable,
  });
  handshake(pair);
  const reply = pair.child.publishReply(finalReply("等待父会话可用"));
  const result = pair.parent.receive(reply);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.replies, []);
  assert.equal(result.outbound.some((frame) => frame.payload.kind === "reply"), false);
  assert.equal(pair.parent.getPublicState().state, "ready");
  assert.equal(pair.parent.getPublicState().pending_reply_count, 1);
  assert.equal(pair.child.getPublicState().pending_reply_count, 1);
  for (const transportAck of result.outbound) {
    assert.equal(pair.child.receive(transportAck).kind, "accepted");
  }

  parentAvailable = true;
  const replyAck = pair.parent.retryPendingReplies();
  assert.ok(replyAck);
  assert.equal(replyAck.payload.kind, "reply");
  assert.equal(replyAck.payload.reply_seq, 1);
  assert.equal(pair.parent.getPublicState().pending_reply_count, 0);
  const acceptedAck = pair.child.receive(replyAck);
  assert.equal(acceptedAck.kind, "accepted");
  assert.equal(pair.child.getPublicState().pending_reply_count, 0);
  assert.equal(pair.parent.retryPendingReplies(), undefined);
});

test("内部控制请求与响应沿现有序号和 ACK 合法往返", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  pair.child.sendSnapshot([
    node(CHILD_ID, null, 1),
    node(GRANDCHILD_ID, CHILD_ID, 2),
  ], 2);
  pair.flush();

  const mutableBody = { template_id: "researcher", options: { subagents: "inherit" } };
  const mutableRoute = [CHILD_ID, GRANDCHILD_ID];
  const request = pair.child.publishControlRequest({
    operation_id: "operation_roundtrip_1",
    operation: "reserve_child",
    route: mutableRoute,
    body: mutableBody,
  });
  mutableBody.template_id = "不得改写已发布帧";
  mutableRoute[1] = SIBLING_ID;
  assert.equal(request.kind, "control_request");
  assert.equal("request_id" in request, false);
  assert.deepEqual(Object.keys(request.payload).sort(), ["body", "operation", "operation_id", "route"]);
  assert.equal((request.payload.body as { template_id: string }).template_id, "researcher");
  assert.deepEqual(request.payload.route, [CHILD_ID, GRANDCHILD_ID]);

  pair.child.send(request);
  const acceptedRequest = pair.child.deliverNext();
  assert.equal(acceptedRequest?.kind, "accepted");
  if (acceptedRequest?.kind !== "accepted") return;
  assert.deepEqual(acceptedRequest.control_request, {
    operation_id: "operation_roundtrip_1",
    operation: "reserve_child",
    route: [CHILD_ID, GRANDCHILD_ID],
    body: { template_id: "researcher", options: { subagents: "inherit" } },
  });
  assert.equal(Object.isFrozen(acceptedRequest.control_request), true);
  assert.deepEqual(acceptedRequest.outbound.map((frame) => frame.kind), ["ack"]);
  pair.parent.deliverNext();

  const response = pair.parent.publishControlResponse({
    operation_id: "operation_roundtrip_1",
    ok: true,
    data: { agent_id: GRANDCHILD_ID, reserved: true },
  });
  assert.equal(response.kind, "control_response");
  assert.equal("request_id" in response, false);
  assert.deepEqual(Object.keys(response.payload).sort(), ["data", "ok", "operation_id"]);
  pair.parent.send(response);
  const acceptedResponse = pair.parent.deliverNext();
  assert.equal(acceptedResponse?.kind, "accepted");
  if (acceptedResponse?.kind !== "accepted") return;
  assert.deepEqual(acceptedResponse.control_response, {
    operation_id: "operation_roundtrip_1",
    ok: true,
    data: { agent_id: GRANDCHILD_ID, reserved: true },
  });
  assert.equal(Object.isFrozen(acceptedResponse.control_response), true);
  assert.deepEqual(acceptedResponse.outbound.map((frame) => frame.kind), ["ack"]);
});

test("模板目录查询作为只读控制操作合法往返", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  const request = pair.child.publishControlRequest({
    operation_id: "operation_templates_1",
    operation: "list_templates",
    route: [CHILD_ID],
    body: {},
  });
  pair.child.send(request);
  const accepted = pair.child.deliverNext();
  assert.equal(accepted?.kind, "accepted");
  if (accepted?.kind !== "accepted") return;
  assert.deepEqual(accepted.control_request, {
    operation_id: "operation_templates_1",
    operation: "list_templates",
    route: [CHILD_ID],
    body: {},
  });
});

test("根权威控制响应可传递超过普通回复文本边界的模板正文", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  const body = "x".repeat(SUPERVISOR_CHANNEL_LIMITS.maxStringBytes + 1);
  const response = pair.parent.publishControlResponse({
    operation_id: "resolve_large_template",
    ok: true,
    data: {
      template: {
        template_id: "large",
        body,
      },
      template_revision: 1,
    },
  });
  const result = pair.child.receive(pair.parent.encode(response));
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.equal(
      ((result.control_response?.ok === true
        ? result.control_response.data as { template: { body: string } }
        : undefined)?.template.body),
      body,
    );
  }
});

test("控制请求拒绝空 route、非规范身份和跨分支伪造", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  pair.child.sendSnapshot([
    node(CHILD_ID, null, 1),
    node(GRANDCHILD_ID, CHILD_ID, 2),
    node(SIBLING_ID, CHILD_ID, 2),
  ], 2);
  pair.flush();

  const request = (route: readonly string[]) => ({
    operation_id: "operation_route_1",
    operation: "admit_control" as const,
    route,
    body: {},
  });
  assertProtocolError(() => pair.child.publishControlRequest(request([])), "invalid_frame");
  assertProtocolError(
    () => pair.child.publishControlRequest(request([CHILD_ID, "NOT-A-CANONICAL-UUID"])),
    "invalid_frame",
  );
  assertProtocolError(
    () => pair.child.publishControlRequest(request(Array.from(
      { length: SUPERVISOR_CHANNEL_LIMITS.maxDepth + 1 },
      () => CHILD_ID,
    ))),
    "invalid_frame",
  );
  assertProtocolError(() => pair.child.publishControlRequest(request([SIBLING_ID])), "identity_mismatch");
  assertProtocolError(
    () => pair.child.publishControlRequest(request([CHILD_ID, GRANDCHILD_ID, SIBLING_ID])),
    "identity_mismatch",
  );

  const valid = pair.child.publishControlRequest(request([CHILD_ID, GRANDCHILD_ID]));
  const forged = {
    ...valid,
    payload: { ...valid.payload, route: [SIBLING_ID] },
  } as SupervisorFrame;
  assert.deepEqual(pair.parent.receive(forged), { kind: "protocol_fault", error: "identity_mismatch" });
});

test("两类控制帧拒绝额外字段、敏感字段和监督 request_id", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  const baseRequest = {
    operation_id: "operation_fields_1",
    operation: "resolve_template" as const,
    route: [CHILD_ID],
    body: { template_id: "researcher" },
  };
  assertProtocolError(
    () => pair.child.publishControlRequest({ ...baseRequest, operation: "spawn_agent" } as never),
    "invalid_frame",
  );
  assertProtocolError(
    () => pair.child.publishControlRequest({ ...baseRequest, credential: "secret-canary" } as never),
    "invalid_frame",
  );
  for (const field of ["systemPrompt", "reply", "file_path", "environment", "rpc_endpoint", "credential", "request_id"]) {
    assertProtocolError(
      () => pair.child.publishControlRequest({ ...baseRequest, body: { nested: { [field]: "secret-canary" } } }),
      "invalid_frame",
    );
  }
  assertProtocolError(() => pair.parent.publishControlResponse({
    operation_id: "operation_fields_1",
    ok: true,
    data: {},
    route: [CHILD_ID],
  } as never), "invalid_frame");
  assertProtocolError(() => pair.parent.publishControlResponse({
    operation_id: "operation_fields_1",
    ok: true,
    data: { runtime: { endpoint: "pipe://secret-canary" } },
  }), "invalid_frame");

  const valid = pair.child.publishControlRequest(baseRequest);
  const extraPayload = {
    ...valid,
    payload: { ...valid.payload, prompt: "secret-canary" },
  } as SupervisorFrame;
  assert.deepEqual(pair.parent.receive(extraPayload), { kind: "protocol_fault", error: "invalid_frame" });

  const requestIdPair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(requestIdPair);
  const control = requestIdPair.child.publishControlRequest(baseRequest);
  const withRequestId = { ...control, request_id: "req_must_not_be_reused" } as SupervisorFrame;
  assert.deepEqual(requestIdPair.parent.receive(withRequestId), { kind: "protocol_fault", error: "invalid_frame" });
});

test("控制响应严格校验公开错误码和固定失败外壳", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  const validError = {
    code: "agent_unavailable",
    message: "代理当前不可用",
    retryable: false,
    details: {},
  } as const;
  const invalidResponses: readonly unknown[] = [
    {
      operation_id: "operation_error_1",
      ok: false,
      error: { ...validError, code: "private_exception" },
    },
    {
      operation_id: "operation_error_1",
      ok: false,
      error: { code: "agent_unavailable", message: "代理当前不可用", retryable: false },
    },
    {
      operation_id: "operation_error_1",
      ok: false,
      error: { ...validError, details: { reason: "secret-canary" } },
    },
    {
      operation_id: "operation_error_1",
      ok: false,
      error: { ...validError, stack: "secret-canary" },
    },
    {
      operation_id: "operation_error_1",
      ok: false,
      error: validError,
      data: {},
    },
    {
      operation_id: "operation_error_1",
      ok: true,
      data: {},
      error: validError,
    },
    {
      operation_id: "operation_error_1",
      ok: false,
      error: "agent_unavailable",
    },
  ];
  for (const response of invalidResponses) {
    assertProtocolError(() => pair.parent.publishControlResponse(response as never), "invalid_frame");
  }

  const failure = pair.parent.publishControlResponse({
    operation_id: "operation_error_1",
    ok: false,
    error: validError,
  });
  const accepted = pair.child.receive(failure);
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind === "accepted") {
    assert.deepEqual(accepted.control_response, {
      operation_id: "operation_error_1",
      ok: false,
      error: validError,
    });
  }

  const nextFailure = pair.parent.publishControlResponse({
    operation_id: "operation_error_2",
    ok: false,
    error: validError,
  });
  const forged = {
    ...nextFailure,
    payload: {
      ...nextFailure.payload,
      error: { ...(nextFailure.payload.error as Record<string, unknown>), stack: "secret-canary" },
    },
  } as SupervisorFrame;
  assert.deepEqual(pair.child.receive(forged), { kind: "protocol_fault", error: "invalid_frame" });
});

test("控制正文遵守字符串、条目、深度、帧大小和纯 JSON 边界", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  const request = (body: unknown) => ({
    operation_id: "operation_bounds_1",
    operation: "confirm_resources" as const,
    route: [CHILD_ID],
    body: body as never,
  });

  const boundary = pair.child.publishControlRequest(request(
    "x".repeat(SUPERVISOR_CHANNEL_LIMITS.maxControlStringBytes),
  ));
  assert.equal(boundary.kind, "control_request");
  assertProtocolError(
    () => pair.child.publishControlRequest(request(
      "x".repeat(SUPERVISOR_CHANNEL_LIMITS.maxControlStringBytes + 1),
    )),
    "frame_too_large",
  );
  assertProtocolError(
    () => pair.child.publishControlRequest(request(Array.from(
      { length: SUPERVISOR_CHANNEL_LIMITS.maxJsonEntries + 1 },
      () => null,
    ))),
    "frame_too_large",
  );

  let tooDeep: unknown = null;
  for (let depth = 0; depth <= SUPERVISOR_CHANNEL_LIMITS.maxJsonDepth; depth += 1) tooDeep = [tooDeep];
  assertProtocolError(() => pair.child.publishControlRequest(request(tooDeep)), "invalid_frame");
  assertProtocolError(() => pair.child.publishControlRequest(request(Number.NaN)), "invalid_frame");
  assertProtocolError(() => pair.child.publishControlRequest(request(new Date())), "invalid_frame");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertProtocolError(() => pair.child.publishControlRequest(request(cyclic)), "invalid_frame");
  assertProtocolError(() => pair.child.publishControlRequest(request(new Array(1))), "invalid_frame");

  const padding = "x".repeat(SUPERVISOR_CHANNEL_LIMITS.maxControlStringBytes);
  const oversizedFrame = pair.child.publishControlRequest(request({
    one: padding,
    two: padding,
    three: padding,
    four: padding,
    five: padding,
    six: padding,
    seven: padding,
    eight: padding,
    nine: padding,
  }));
  assertProtocolError(() => pair.child.encode(oversizedFrame), "frame_too_large");
});

test("有限重连使用新流，首快照确认后重放未确认回复且丢弃旧流", () => {
  const replies: string[] = [];
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
    onReply: (reply) => {
      replies.push(reply.envelope.text ?? "");
      return true;
    },
  });
  handshake(pair);
  const oldReply = pair.child.publishReply(finalReply("断线前已到达"));
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
    type: "startup_ready",
    expected_generation: 4,
  });
  const result = pair.parent.receive(event);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.deepEqual(result.event, {
      root_id: ROOT_ID,
      agent_id: CHILD_ID,
      type: "startup_ready",
      expected_generation: 4,
    });
  }
  assert.throws(() => pair.child.publishEvent({ type: "unknown_event" as never }), (error: unknown) => {
    return error instanceof SupervisorProtocolError && error.code === "invalid_frame";
  });
  const unsafe = pair.child.publishEvent({ type: "startup_ready" });
  const injected = {
    ...unsafe,
    payload: { ...unsafe.payload, prompt: "secret-canary" },
  } as SupervisorFrame;
  assert.deepEqual(pair.parent.receive(injected), { kind: "protocol_fault", error: "invalid_frame" });
});

test("直接子通道伪造兄弟生命周期事件时父端进入身份故障且不改快照", () => {
  const pair = createFakeSupervisorChannelPair({
    rootId: ROOT_ID,
    childAgentId: CHILD_ID,
    credential: CREDENTIAL,
  });
  handshake(pair);
  const before = pair.parent.getTreeSnapshot();
  const valid = pair.child.publishEvent({ type: "startup_ready", expected_generation: 0 });
  const forged = {
    ...valid,
    payload: { ...valid.payload, agent_id: SIBLING_ID },
  } as SupervisorFrame;
  assert.deepEqual(pair.parent.receive(forged), { kind: "protocol_fault", error: "identity_mismatch" });
  assert.equal(pair.parent.getPublicState().state, "faulted");
  assert.deepEqual(pair.parent.getTreeSnapshot(), before);
});

test("EOF 后未在重同步期限内完成完整快照会固定为协议故障", async () => {
  const faults: string[] = [];
  const requestIds = new SupervisorRequestIdRegistry();
  const parent = new FakeSupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: requestIds,
    resyncTimeoutMs: 10,
    onProtocolFault: () => faults.push("protocol_fault"),
  });
  const child = new FakeSupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: requestIds,
  });
  parent.connect(child);
  child.connect(parent);
  child.sendHello();
  child.flush();
  child.sendSnapshot([node(CHILD_ID, null, 1)], 1);
  child.flush();
  assert.equal(parent.getPublicState().state, "ready");

  assert.equal(parent.injectEof().kind, "eof");
  assert.equal(parent.getPublicState().state, "resyncing");
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(parent.getPublicState().state, "faulted");
  assert.deepEqual(faults, ["protocol_fault"]);
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
  const corrupt = new Uint8Array(4);
  new DataView(corrupt.buffer).setUint32(0, SUPERVISOR_CHANNEL_LIMITS.maxFrameBytes + 1, false);
  assert.equal(corruptPair.parent.inject(corrupt).kind, "protocol_fault");
  assert.equal(corruptPair.parent.getPublicState().state, "faulted");
});
