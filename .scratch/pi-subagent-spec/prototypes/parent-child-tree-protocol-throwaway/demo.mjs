const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const copy = value => JSON.parse(JSON.stringify(value));

const CHILD_AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRANDCHILD_AGENT_ID = "550e8400-e29b-41d4-a716-446655440001";

class ChildStream {
  constructor(agentId) {
    this.agentId = agentId;
    this.streamId = "stream-1";
    this.seq = 0;
    this.subtreeRevision = 0;
    this.latestNodes = [];
  }

  frame(kind, payload = {}, requestId) {
    this.seq += 1;
    return {
      protocol: "pi-subagent/1",
      kind,
      stream_id: this.streamId,
      sender_agent_id: this.agentId,
      target_agent_id: null,
      seq: this.seq,
      ...(requestId ? { request_id: requestId } : {}),
      payload,
    };
  }

  hello() {
    return this.frame("hello", {
      parent_agent_id: null,
      subtree_revision: this.subtreeRevision,
    });
  }

  snapshot(nodes, { reset = false, requestId } = {}) {
    this.subtreeRevision += 1;
    this.latestNodes = copy(nodes);
    return this.frame("snapshot", {
      reset,
      scope_agent_id: this.agentId,
      subtree_revision: this.subtreeRevision,
      nodes: copy(this.latestNodes),
    }, requestId);
  }

  latestSnapshot(requestId) {
    return this.frame("snapshot", {
      reset: true,
      scope_agent_id: this.agentId,
      subtree_revision: this.subtreeRevision,
      nodes: copy(this.latestNodes),
    }, requestId);
  }
}

class RootController {
  constructor(expectedAgentId) {
    this.expectedAgentId = expectedAgentId;
    this.streamId = null;
    this.lastSeq = 0;
    this.lastSubtreeRevision = 0;
    this.treeRevision = 0;
    this.nodes = [];
    this.duplicateCount = 0;
    this.gapCount = 0;
    this.pendingSnapshotRequest = null;
  }

  accept(frame) {
    assert(frame.protocol === "pi-subagent/1", "协议版本错误");
    assert(frame.sender_agent_id === this.expectedAgentId, "发送者身份错误");

    if (this.streamId === null) this.streamId = frame.stream_id;
    assert(frame.stream_id === this.streamId, "旧 stream_id 未被拒绝");

    if (frame.seq <= this.lastSeq) {
      this.duplicateCount += 1;
      return { kind: "duplicate", ack: this.lastSeq };
    }

    if (frame.seq > this.lastSeq + 1) {
      this.gapCount += 1;
      this.pendingSnapshotRequest = "req-resync-1";
      return { kind: "gap", requestId: this.pendingSnapshotRequest };
    }

    this.lastSeq = frame.seq;
    return this.applyInOrder(frame);
  }

  acceptResync(frame, requestId) {
    assert(frame.kind === "snapshot", "重同步必须返回快照");
    assert(frame.request_id === requestId, "重同步请求号不匹配");
    assert(frame.payload.reset === true, "重同步快照没有 reset 标志");
    assert(frame.stream_id === this.streamId, "重同步不能切换到未知流");
    assert(frame.seq > this.lastSeq, "重同步序号没有前进");
    this.lastSeq = frame.seq;
    this.pendingSnapshotRequest = null;
    return this.applySnapshot(frame);
  }

  applyInOrder(frame) {
    if (frame.kind === "hello") return { kind: "hello", ack: this.lastSeq };
    if (frame.kind === "snapshot") return this.applySnapshot(frame);
    throw new Error(`未处理的帧类型: ${frame.kind}`);
  }

  applySnapshot(frame) {
    const snapshot = frame.payload;
    assert(snapshot.scope_agent_id === this.expectedAgentId, "快照作用域错误");
    if (snapshot.subtree_revision <= this.lastSubtreeRevision) {
      return { kind: "stale", ack: this.lastSeq };
    }
    this.lastSubtreeRevision = snapshot.subtree_revision;
    this.nodes = copy(snapshot.nodes);
    this.treeRevision += 1;
    return {
      kind: "applied",
      ack: this.lastSeq,
      treeRevision: this.treeRevision,
      nodeCount: this.nodes.length,
    };
  }
}

const child = new ChildStream(CHILD_AGENT_ID);
const root = new RootController(CHILD_AGENT_ID);

const hello = child.hello();
assert(root.accept(hello).kind === "hello", "握手失败");

const first = child.snapshot([
  { agent_id: CHILD_AGENT_ID, state: "idle" },
]);
assert(root.accept(first).kind === "applied", "首次快照未应用");
assert(root.treeRevision === 1, "根修订号错误");

assert(root.accept(first).kind === "duplicate", "重复帧没有被去重");
assert(root.duplicateCount === 1, "重复计数错误");

const second = child.snapshot([
  { agent_id: CHILD_AGENT_ID, state: "working" },
  { agent_id: GRANDCHILD_AGENT_ID, state: "idle" },
]);
const third = child.snapshot([
  { agent_id: CHILD_AGENT_ID, state: "working" },
  { agent_id: GRANDCHILD_AGENT_ID, state: "working" },
]);
const fourth = child.snapshot([
  { agent_id: CHILD_AGENT_ID, state: "idle" },
  { agent_id: GRANDCHILD_AGENT_ID, state: "idle" },
]);

assert(root.accept(second).kind === "applied", "第二个快照未应用");
const gap = root.accept(fourth);
assert(gap.kind === "gap", "断序帧没有触发重同步");
assert(root.nodes[0].state === "working", "断序帧被错误应用");

const resync = child.latestSnapshot(gap.requestId);
assert(root.acceptResync(resync, gap.requestId).kind === "applied", "重同步快照未应用");
assert(root.nodes[0].state === "idle", "重同步后的最新状态错误");
assert(root.nodes.length === 2, "重同步没有保留完整子树");
assert(root.treeRevision === 3, "根修订号没有按完整替换递增");

const old = {
  ...second,
  seq: root.lastSeq + 1,
  payload: { ...second.payload, subtree_revision: 2 },
};
assert(root.accept(old).kind === "stale", "旧快照没有被丢弃");
assert(root.nodes[0].state === "idle", "旧子树覆盖了新子树");
assert(root.lastSubtreeRevision === 4, "旧修订被错误保存");

console.log(JSON.stringify({
  passed: true,
  stream_id: root.streamId,
  last_seq: root.lastSeq,
  last_subtree_revision: root.lastSubtreeRevision,
  tree_revision: root.treeRevision,
  duplicate_frames: root.duplicateCount,
  gaps: root.gapCount,
  retained_nodes: root.nodes.length,
}, null, 2));
