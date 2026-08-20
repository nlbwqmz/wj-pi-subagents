import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_REPLY_ENVELOPE_LIMITS,
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  CHILD_TERMINAL_SCHEMA,
  encodeChildReplyEnvelope,
  encodeTerminalNotice,
  parseChildReplyEnvelope,
  parseTerminalNotice,
  type ChildFinalEnvelope,
  type ChildMessageEnvelope,
  type TerminalNotice,
} from "../src/child-reply-envelope.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const TURN_ID = "550e8400-e29b-41d4-a716-446655440001";
const TASK_ID = "450e8400-e29b-41d4-a716-446655440001";
const COMMIT_ID = "750e8400-e29b-41d4-a716-446655440001";
const UUID_V1 = "550e8400-e29b-11d4-a716-446655440001";
const IMAGE = {
  type: "image" as const,
  data: "iVBORw0KGgo=",
  mimeType: "image/png",
};

function message(overrides: Partial<ChildMessageEnvelope> = {}): ChildMessageEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: AGENT_ID,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    text: "正在处理",
    ...overrides,
  };
}

function final(
  overrides: Partial<Omit<ChildFinalEnvelope, "text">> & { readonly text?: string | undefined } = {},
): ChildFinalEnvelope {
  const value = {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final" as const,
    agent_id: AGENT_ID,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    commit_id: COMMIT_ID,
    run_state: "settled" as const,
    output_state: "present" as const,
    text: "已完成",
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as ChildFinalEnvelope;
}

test("reply envelope validates required fields and rejects unknown fields", () => {
  assert.equal(parseChildReplyEnvelope({
    ...message(),
    future_field: { accepted: true },
  }), undefined);

  assert.equal(parseChildReplyEnvelope({ ...message(), requires_response: false }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), run_state: "settled" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), output_state: "present" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), reason_code: "no_output" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), text: "" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), agent_id: "agent" }), undefined);
});

test("reply envelope enforces identifiers, version, enums, and 32 KiB UTF-8 text bytes", () => {
  assert.equal(parseChildReplyEnvelope({ ...message(), turn_id: "turn-1" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), turn_id: UUID_V1 }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), version: 1 }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), version: CHILD_REPLY_VERSION - 1 }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), version: CHILD_REPLY_VERSION + 1 }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), kind: "progress" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), text: { arbitrary: "json" } }), undefined);

  assert.equal(CHILD_REPLY_ENVELOPE_LIMITS.maxStringBytes, 32 * 1024);
  const exact = "x".repeat(CHILD_REPLY_ENVELOPE_LIMITS.maxStringBytes);
  assert.equal(parseChildReplyEnvelope(message({ text: exact }))?.text, exact);
  assert.equal(parseChildReplyEnvelope(final({ text: exact }))?.text, exact);
  assert.equal(parseChildReplyEnvelope(message({ text: `${exact}x` })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ text: `${exact}x` })), undefined);
  assert.equal(parseChildReplyEnvelope(
    message({ text: `${exact}x` }),
    { maxStringBytes: 64 * 1024 },
  ), undefined);
  assert.equal(parseChildReplyEnvelope(
    message({ text: exact }),
    { maxStringBytes: 16 * 1024 },
  ), undefined);

  const exactUtf8 = `${"测".repeat(10_922)}ab`;
  assert.equal(new TextEncoder().encode(exactUtf8).byteLength, 32 * 1024);
  assert.equal(parseChildReplyEnvelope(message({ text: exactUtf8 }))?.text, exactUtf8);
  assert.equal(parseChildReplyEnvelope(message({ text: `${exactUtf8}测` })), undefined);

  const exactEmoji = "😀".repeat(8_192);
  assert.equal(new TextEncoder().encode(exactEmoji).byteLength, 32 * 1024);
  assert.equal(parseChildReplyEnvelope(final({ text: exactEmoji }))?.text, exactEmoji);
  assert.equal(parseChildReplyEnvelope(final({ text: `${exactEmoji}😀` })), undefined);
});

test("final envelope validates the complete lifecycle/output state matrix", () => {
  const valid = [
    final(),
    final({ run_state: "settled", output_state: "absent", text: undefined, reason_code: "no_output" }),
    final({ run_state: "settled", output_state: "absent", text: undefined, reason_code: "reply_too_large" }),
    final({ run_state: "failed", output_state: "present", reason_code: "provider_error" }),
    final({ run_state: "failed", output_state: "absent", text: undefined, reason_code: "provider_error" }),
    final({ run_state: "failed", output_state: "present", reason_code: "runtime_fault" }),
    final({ run_state: "failed", output_state: "absent", text: undefined, reason_code: "runtime_fault" }),
    final({ run_state: "interrupted", output_state: "present" }),
    final({ run_state: "interrupted", output_state: "absent", text: undefined }),
  ];
  for (const value of valid) assert.deepEqual(parseChildReplyEnvelope(value), value);

  assert.equal(parseChildReplyEnvelope(final({ output_state: "absent" })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ output_state: "present", text: undefined })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ run_state: "settled", reason_code: "provider_error" })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ run_state: "failed", reason_code: "no_output" })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ run_state: "failed", reason_code: "reply_too_large" })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ run_state: "interrupted", reason_code: "runtime_fault" })), undefined);
  assert.equal(parseChildReplyEnvelope({ ...final(), requires_response: false }), undefined);
});

test("message 和 final 都拒绝 images，空 final 只保留状态", () => {
  assert.equal(parseChildReplyEnvelope({ ...message(), images: [IMAGE] }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...final(), images: [IMAGE] }), undefined);
  assert.equal(parseChildReplyEnvelope({
    ...final({ output_state: "present", text: undefined }),
    images: [IMAGE],
  }), undefined);

  const empty = final({ output_state: "absent", text: undefined, reason_code: "no_output" });
  assert.deepEqual(parseChildReplyEnvelope(empty), empty);
});

test("terminal notice validates its fixed failure fact and rejects extensions", () => {
  const notice: TerminalNotice = {
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: AGENT_ID,
    turn_id: TURN_ID,
    node_state: "failed",
    reason_code: "runtime_fault",
  };
  assert.equal(parseTerminalNotice({ ...notice, future_field: "ignored" }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, node_state: "terminated" }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, turn_id: "turn-1" }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, turn_id: UUID_V1 }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, agent_id: "agent" }), undefined);
});

test("reply and terminal envelopes use ordinary JSON independent of field order and whitespace", () => {
  const value = final();
  const encoded = encodeChildReplyEnvelope(value);
  assert.deepEqual(parseChildReplyEnvelope(JSON.parse(encoded)), value);
  assert.match(encoded, /\"schema\":\"wj-pi-subagents.reply\"/);

  const reordered = JSON.stringify({
    text: value.text,
    output_state: value.output_state,
    commit_id: value.commit_id,
    task_id: value.task_id,
    turn_id: value.turn_id,
    kind: value.kind,
    run_state: value.run_state,
    agent_id: value.agent_id,
    version: value.version,
    schema: value.schema,
  }, null, 2);
  assert.deepEqual(parseChildReplyEnvelope(JSON.parse(`  \n${reordered}\n  `)), value);

  const notice: TerminalNotice = {
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: AGENT_ID,
    node_state: "failed",
    reason_code: "runtime_fault",
  };
  assert.deepEqual(parseTerminalNotice(JSON.parse(encodeTerminalNotice(notice))), notice);
});
