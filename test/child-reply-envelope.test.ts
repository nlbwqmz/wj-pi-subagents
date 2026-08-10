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
const UUID_V1 = "550e8400-e29b-11d4-a716-446655440001";
const IMAGE = {
  type: "image" as const,
  data: "aGVsbG8=",
  mimeType: "image/png",
};

function message(overrides: Partial<ChildMessageEnvelope> = {}): ChildMessageEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: AGENT_ID,
    turn_id: TURN_ID,
    requires_response: false,
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
    turn_id: TURN_ID,
    run_state: "settled" as const,
    output_state: "present" as const,
    text: "已完成",
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as ChildFinalEnvelope;
}

test("reply envelope validates required fields and ignores unknown fields", () => {
  const parsed = parseChildReplyEnvelope({
    ...message(),
    future_field: { accepted: true },
  });
  assert.deepEqual(parsed, message());

  assert.equal(parseChildReplyEnvelope({ ...message(), requires_response: undefined }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), run_state: "settled" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), output_state: "present" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), reason_code: "no_output" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), text: "" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), agent_id: "agent" }), undefined);
});

test("reply envelope enforces identifiers, enums, text bytes, and natural-language payloads", () => {
  assert.equal(parseChildReplyEnvelope({ ...message(), turn_id: "turn-1" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), turn_id: UUID_V1 }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), version: 2 }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), kind: "progress" }), undefined);
  assert.equal(parseChildReplyEnvelope({ ...message(), text: { arbitrary: "json" } }), undefined);

  const exact = "x".repeat(CHILD_REPLY_ENVELOPE_LIMITS.maxStringBytes);
  assert.equal(parseChildReplyEnvelope(message({ text: exact }))?.text, exact);
  assert.equal(
    parseChildReplyEnvelope(message({ text: `${exact}x` })),
    undefined,
  );
});

test("final envelope validates the complete lifecycle/output state matrix", () => {
  const valid = [
    final(),
    final({ run_state: "settled", output_state: "absent", text: undefined, reason_code: "no_output" }),
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
  assert.equal(parseChildReplyEnvelope(final({ run_state: "interrupted", reason_code: "runtime_fault" })), undefined);
  assert.equal(parseChildReplyEnvelope({ ...final(), requires_response: false }), undefined);
});

test("image-only final is present and empty final has no business text", () => {
  const imageOnly = final({ output_state: "present", text: undefined, images: [IMAGE] });
  assert.deepEqual(parseChildReplyEnvelope(imageOnly), imageOnly);
  const empty = final({ output_state: "absent", text: undefined, reason_code: "no_output" });
  assert.deepEqual(parseChildReplyEnvelope(empty), empty);
});

test("reply image limits use decoded bytes and reject malformed image payloads", () => {
  const exactData = Buffer.alloc(CHILD_REPLY_ENVELOPE_LIMITS.maxImageBytes).toString("base64");
  const exactImage = { ...IMAGE, data: exactData };
  const maxImages = Array.from(
    { length: CHILD_REPLY_ENVELOPE_LIMITS.maxImagesPerReply },
    () => exactImage,
  );
  assert.equal(parseChildReplyEnvelope(final({ text: undefined, images: maxImages }))?.kind, "final");
  assert.equal(parseChildReplyEnvelope(final({
    text: undefined,
    images: [{ ...IMAGE, data: Buffer.alloc(CHILD_REPLY_ENVELOPE_LIMITS.maxImageBytes + 1).toString("base64") }],
  })), undefined);
  assert.equal(parseChildReplyEnvelope(final({
    text: undefined,
    images: [...maxImages, IMAGE],
  })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ text: undefined, images: [{ ...IMAGE, data: "***" }] })), undefined);
  assert.equal(parseChildReplyEnvelope(final({
    text: undefined,
    images: [{ ...IMAGE, mimeType: `image/${"x".repeat(122)}` }],
  }))?.kind, "final");
  assert.equal(parseChildReplyEnvelope(final({
    text: undefined,
    images: [{ ...IMAGE, mimeType: `image/${"x".repeat(123)}` }],
  })), undefined);
  assert.equal(parseChildReplyEnvelope(final({ text: undefined, images: [{ ...IMAGE, mimeType: "text/plain" }] })), undefined);
  assert.equal(parseChildReplyEnvelope({
    ...final({ text: undefined, images: [IMAGE] }),
    images: [{ ...IMAGE, unexpected: "must-not-be-ignored" }],
  }), undefined);
});

test("terminal notice validates its fixed failure fact and ignores extensions", () => {
  const notice: TerminalNotice = {
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: AGENT_ID,
    turn_id: TURN_ID,
    node_state: "failed",
    reason_code: "runtime_fault",
  };
  assert.deepEqual(parseTerminalNotice({ ...notice, future_field: "ignored" }), notice);
  assert.equal(parseTerminalNotice({ ...notice, node_state: "terminated" }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, turn_id: "turn-1" }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, turn_id: UUID_V1 }), undefined);
  assert.equal(parseTerminalNotice({ ...notice, agent_id: "agent" }), undefined);
});

test("reply and terminal envelopes use ordinary JSON independent of field order and whitespace", () => {
  const value = final({ output_state: "present", images: [IMAGE] });
  const encoded = encodeChildReplyEnvelope(value);
  assert.deepEqual(parseChildReplyEnvelope(JSON.parse(encoded)), value);
  assert.match(encoded, /\"schema\":\"pi-subagent.reply\"/);

  const reordered = JSON.stringify({
    text: value.text,
    output_state: value.output_state,
    turn_id: value.turn_id,
    kind: value.kind,
    run_state: value.run_state,
    agent_id: value.agent_id,
    version: value.version,
    schema: value.schema,
    images: value.images,
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
