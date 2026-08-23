import assert from "node:assert/strict";
import test from "node:test";
import {
  LifecycleAuthority,
  type LifecycleFact,
  type LifecycleSnapshot,
} from "../src/conversation-lifecycle.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function startingSnapshot(): LifecycleSnapshot {
  return {
    agent_id: AGENT_ID,
    state: "starting",
    revision: 0,
    lifecycle_generation: 0,
  };
}

function fact(
  authority: LifecycleAuthority,
  type: LifecycleFact["type"],
  error_code?: string,
): LifecycleFact {
  const snapshot = authority.get(AGENT_ID);
  assert.ok(snapshot);
  return {
    agent_id: AGENT_ID,
    expected_generation: snapshot.lifecycle_generation,
    type,
    ...(error_code === undefined ? {} : { error_code }),
  };
}

test("生命周期归约覆盖七状态、独立 idle 事件和终止吸收态", () => {
  const authority = new LifecycleAuthority();
  authority.register(startingSnapshot());

  let result = authority.apply(fact(authority, "startup_ready"));
  assert.equal(result.snapshot.state, "idle");
  assert.equal(result.event, undefined);

  result = authority.apply(fact(authority, "agent_start"));
  assert.equal(result.snapshot.state, "working");

  assert.deepEqual(authority.recordSessionEvent(AGENT_ID, "reply"), {
    agent_id: AGENT_ID,
    type: "reply",
    revision: result.snapshot.revision,
  });
  assert.deepEqual(authority.recordSessionEvent(AGENT_ID, "final_report"), {
    agent_id: AGENT_ID,
    type: "final_report",
    revision: result.snapshot.revision,
  });

  result = authority.apply(fact(authority, "agent_settled"));
  assert.equal(result.snapshot.state, "idle");
  assert.equal(result.event, "idle");
  assert.deepEqual(
    authority.takeEvents(AGENT_ID).map((event) => event.type),
    ["reply", "final_report", "idle"],
  );

  result = authority.apply(fact(authority, "terminate_accepted"));
  assert.equal(result.snapshot.state, "terminating");
  result = authority.apply(fact(authority, "resources_confirmed"));
  assert.equal(result.snapshot.state, "terminated");
  assert.equal(result.event, "terminal");

  const beforeRepeat = authority.get(AGENT_ID);
  assert.ok(beforeRepeat);
  const repeated = authority.apply({
    agent_id: AGENT_ID,
    expected_generation: beforeRepeat.lifecycle_generation,
    type: "resources_confirmed",
  });
  assert.equal(repeated.applied, false);
  assert.equal(repeated.diagnostic, "invalid_transition");
  assert.deepEqual(repeated.snapshot, beforeRepeat);
});

test("迟到代际和非法事实不改变 generation、revision 或事件队列", () => {
  const authority = new LifecycleAuthority();
  authority.register(startingSnapshot());
  const ready = authority.apply(fact(authority, "startup_ready"));
  assert.equal(ready.applied, true);

  const before = authority.get(AGENT_ID);
  assert.ok(before);
  const stale = authority.apply({
    agent_id: AGENT_ID,
    expected_generation: 0,
    type: "agent_settled",
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.diagnostic, "stale_generation");
  assert.deepEqual(stale.snapshot, before);
  assert.deepEqual(authority.peekEvents(AGENT_ID), []);

  const invalid = authority.apply({
    agent_id: AGENT_ID,
    expected_generation: before.lifecycle_generation,
    type: "agent_settled",
  });
  assert.equal(invalid.applied, false);
  assert.equal(invalid.diagnostic, "invalid_transition");
  assert.deepEqual(invalid.snapshot, before);

  assert.throws(() => authority.recordSessionEvent(AGENT_ID, "reply"), /invalid_transition/);
  assert.throws(() => authority.apply({
    ...fact(authority, "agent_start"),
    unexpected: true,
  } as unknown as LifecycleFact), /invalid_lifecycle_fact/);
});

test("真实运行故障进入 failed，消息事件不会替代故障事实", () => {
  const authority = new LifecycleAuthority();
  authority.register(startingSnapshot());
  authority.apply(fact(authority, "startup_ready"));
  authority.apply(fact(authority, "agent_start"));
  const failed = authority.apply(fact(authority, "runtime_failed", "protocol_mismatch"));

  assert.equal(failed.snapshot.state, "failed");
  assert.equal(failed.snapshot.error_code, "protocol_mismatch");
  assert.equal(failed.event, "terminal");
  assert.throws(() => authority.recordSessionEvent(AGENT_ID, "final_report"), /invalid_transition/);
  assert.deepEqual(authority.takeEvents(AGENT_ID).map((event) => event.type), ["terminal"]);
});

