import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
  type ChildMessageEnvelope,
} from "../src/child-reply-envelope.ts";
import {
  createFakeSupervisorChannelPair,
  type FakeSupervisorChannelPair,
  type FakeSupervisorChannelPairOptions,
  type SupervisorFrame,
  type SupervisorReceiveResult,
} from "../src/supervisor-channel.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const TURN_ID = "550e8400-e29b-41d4-a716-446655440001";
const TASK_ID = "450e8400-e29b-41d4-a716-446655440001";
const COMMIT_ID = "750e8400-e29b-41d4-a716-446655440001";

function envelope(text = "进度"): ChildMessageEnvelope {
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

function readyPair(options: Pick<FakeSupervisorChannelPairOptions, "limits" | "onReply"> = {}) {
  const pair = createFakeSupervisorChannelPair({
    rootId: "root-test",
    childAgentId: CHILD_ID,
    credential: "test-one-time-credential",
    ...options,
  });
  pair.child.sendHello();
  pair.flush();
  pair.child.sendSnapshot([{
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "资料代理",
    depth: 1,
    state: "idle" as const,
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    revision: 1,
  }], 1);
  pair.flush();
  return pair;
}

function receiveAndAck(
  pair: FakeSupervisorChannelPair,
  frame: SupervisorFrame,
): SupervisorReceiveResult {
  const result = pair.parent.receive(frame);
  if (result.kind === "accepted") {
    for (const outbound of result.outbound) pair.child.receive(outbound);
  }
  return result;
}

test("v10 reply wire payload contains only reply_seq and envelope", () => {
  const pair = readyPair();
  const value = envelope();
  const frame = pair.child.publishReply(value);
  assert.equal(frame.protocol, "pi-subagent/10");
  assert.deepEqual(frame.payload, { reply_seq: 1, envelope: value });
});

test("v10 rejects v8/v9 frames and reply envelopes with a forged agent identity", () => {
  const legacyPair = readyPair();
  const valid = legacyPair.child.publishReply(envelope());
  const v8 = { ...valid, protocol: "pi-subagent/8" } as unknown as SupervisorFrame;
  assert.deepEqual(legacyPair.parent.receive(v8), {
    kind: "protocol_fault",
    error: "protocol_mismatch",
  });

  const v9Pair = readyPair();
  const v9 = { ...v9Pair.child.publishReply(envelope()), protocol: "pi-subagent/9" } as unknown as SupervisorFrame;
  assert.deepEqual(v9Pair.parent.receive(v9), {
    kind: "protocol_fault",
    error: "protocol_mismatch",
  });

  const identityPair = readyPair();
  const identityFrame = identityPair.child.publishReply(envelope());
  const forged = {
    ...identityFrame,
    payload: {
      ...identityFrame.payload,
      envelope: {
        ...envelope(),
        agent_id: "550e8400-e29b-41d4-a716-446655440002",
      },
    },
  } as SupervisorFrame;
  assert.deepEqual(identityPair.parent.receive(forged), {
    kind: "protocol_fault",
    error: "identity_mismatch",
  });
});

test("same reply_seq replay is idempotent but a different envelope is a protocol fault", () => {
  const replayed: string[] = [];
  const replayPair = createFakeSupervisorChannelPair({
    rootId: "root-test",
    childAgentId: CHILD_ID,
    credential: "test-one-time-credential",
    onReply: (reply) => {
      replayed.push(reply.envelope.text ?? "");
      return true;
    },
  });
  replayPair.child.sendHello();
  replayPair.flush();
  replayPair.child.sendSnapshot([{
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "资料代理",
    depth: 1,
    state: "idle" as const,
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    revision: 1,
  }], 1);
  replayPair.flush();
  const first = replayPair.child.publishReply(envelope("第一条"));
  assert.equal(replayPair.parent.receive(first).kind, "accepted");
  const next = replayPair.child.publishReply(envelope("第二条"));
  const exactReplay = { ...next, payload: first.payload } as SupervisorFrame;
  assert.equal(replayPair.parent.receive(exactReplay).kind, "accepted");
  assert.deepEqual(replayed, ["第一条"]);

  const conflictPair = readyPair();
  const accepted = conflictPair.child.publishReply(envelope("原始"));
  assert.equal(conflictPair.parent.receive(accepted).kind, "accepted");
  const later = conflictPair.child.publishReply(envelope("冲突"));
  const conflict = {
    ...later,
    payload: { ...later.payload, reply_seq: 1 },
  } as SupervisorFrame;
  assert.deepEqual(conflictPair.parent.receive(conflict), {
    kind: "protocol_fault",
    error: "reply_invalid",
  });
});

test("reply conflict detection remains exact beyond the pending reply window", () => {
  const pair = readyPair({ limits: { maxReplyWindow: 2 } });
  for (const text of ["第一条", "第二条", "第三条"]) {
    assert.equal(receiveAndAck(pair, pair.child.publishReply(envelope(text))).kind, "accepted");
  }
  const next = pair.child.publishReply(envelope("第四条"));
  const staleConflict = {
    ...next,
    payload: {
      reply_seq: 1,
      envelope: envelope("篡改后的第一条"),
    },
  } as SupervisorFrame;
  assert.deepEqual(pair.parent.receive(staleConflict), {
    kind: "protocol_fault",
    error: "reply_invalid",
  });
});

test("only the first final for a turn is injected while later finals are acknowledged", () => {
  const received: string[] = [];
  const pair = createFakeSupervisorChannelPair({
    rootId: "root-test",
    childAgentId: CHILD_ID,
    credential: "test-one-time-credential",
    onReply: (reply) => {
      received.push(reply.envelope.text ?? "");
      return true;
    },
  });
  pair.child.sendHello();
  pair.flush();
  pair.child.sendSnapshot([{
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "资料代理",
    depth: 1,
    state: "idle" as const,
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    revision: 1,
  }], 1);
  pair.flush();
  const firstFinal: ChildFinalEnvelope = {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: CHILD_ID,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    commit_id: COMMIT_ID,
    run_state: "settled",
    output_state: "present",
    text: "第一份最终答复",
  };
  const laterFinal: ChildFinalEnvelope = {
    ...firstFinal,
    commit_id: "850e8400-e29b-41d4-a716-446655440001",
    text: "不得覆盖的迟到 final",
  };
  const firstResult = pair.parent.receive(pair.child.publishReply(firstFinal));
  const secondResult = pair.parent.receive(pair.child.publishReply(laterFinal));
  assert.equal(firstResult.kind, "accepted");
  assert.equal(secondResult.kind, "accepted");
  assert.deepEqual(received, ["第一份最终答复"]);
  if (secondResult.kind === "accepted") {
    assert.equal(secondResult.replies.length, 0);
    assert.ok(secondResult.outbound.some((frame) =>
      frame.payload.kind === "reply" && frame.payload.reply_seq === 2));
  }
});

test("final turn dedupe remains exact beyond the pending reply window", () => {
  const received: string[] = [];
  const pair = readyPair({
    limits: { maxReplyWindow: 2 },
    onReply: (reply) => {
      received.push(reply.envelope.text ?? "");
      return true;
    },
  });
  const makeFinal = (turnId: string, text: string, commitId: string): ChildFinalEnvelope => ({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: CHILD_ID,
    task_id: TASK_ID,
    turn_id: turnId,
    commit_id: commitId,
    run_state: "settled",
    output_state: "present",
    text,
  });
  const turns = [
    TURN_ID,
    "550e8400-e29b-41d4-a716-446655440002",
    "550e8400-e29b-41d4-a716-446655440003",
  ];
  for (const [index, turnId] of turns.entries()) {
    const commitId = `750e8400-e29b-41d4-a716-44665544000${index + 1}`;
    assert.equal(
      receiveAndAck(pair, pair.child.publishReply(makeFinal(turnId, `final-${index + 1}`, commitId))).kind,
      "accepted",
    );
  }
  const duplicate = receiveAndAck(
    pair,
    pair.child.publishReply(makeFinal(
      TURN_ID,
      "不得注入的旧 turn final",
      "750e8400-e29b-41d4-a716-446655440004",
    )),
  );
  assert.equal(duplicate.kind, "accepted");
  if (duplicate.kind === "accepted") assert.equal(duplicate.replies.length, 0);
  assert.deepEqual(received, ["final-1", "final-2", "final-3"]);
});
