import assert from "node:assert/strict";
import test from "node:test";
import {
  SubtreePublisher,
  type SubtreeSnapshotSink,
  type SubtreeSnapshotSource,
} from "../src/subtree-publisher.ts";

interface TestNode {
  readonly id: string;
  readonly metadata: {
    readonly label: string;
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function node(id: string, label: string): TestNode {
  return { id, metadata: { label } };
}

class FakeSource implements SubtreeSnapshotSource<TestNode> {
  private listeners = new Set<() => void>();
  private currentNodes: readonly TestNode[];
  private currentRevision: number;
  unsubscribeCount = 0;

  constructor(nodes: readonly TestNode[], subtreeRevision: number) {
    this.currentNodes = nodes;
    this.currentRevision = subtreeRevision;
  }

  read(): { readonly nodes: readonly TestNode[]; readonly subtreeRevision: number } {
    return {
      nodes: this.currentNodes,
      subtreeRevision: this.currentRevision,
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      if (!this.listeners.delete(listener)) return;
      this.unsubscribeCount += 1;
    };
  }

  change(nodes: readonly TestNode[], subtreeRevision: number): void {
    this.currentNodes = nodes;
    this.currentRevision = subtreeRevision;
    for (const listener of [...this.listeners]) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("start 首次发布完整快照，并向 sink 交付深复制的冻结节点", async () => {
  const mutableNode = { id: "a", metadata: { label: "初始" } };
  const source = new FakeSource([mutableNode], 1);
  let received: readonly TestNode[] | undefined;
  const sink: SubtreeSnapshotSink<TestNode> = {
    async publishSnapshot(nodes, revision) {
      assert.equal(revision, 1);
      received = nodes;
    },
  };
  const publisher = new SubtreePublisher(source, sink);

  await publisher.start();

  assert.ok(received !== undefined);
  assert.deepEqual(received, [node("a", "初始")]);
  assert.notStrictEqual(received, source.read().nodes);
  assert.notStrictEqual(received[0], mutableNode);
  assert.notStrictEqual(received[0]?.metadata, mutableNode.metadata);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received[0]), true);
  assert.equal(Object.isFrozen(received[0]?.metadata), true);

  mutableNode.metadata.label = "源对象后续突变";
  assert.equal(received[0]?.metadata.label, "初始");
  await publisher.close();
});

test("写入期间的多次变化合并为一个最新快照，且发布永不并发", async () => {
  const source = new FakeSource([node("a", "一")], 1);
  const gates: Deferred<void>[] = [];
  const revisions: number[] = [];
  const labels: string[] = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const sink: SubtreeSnapshotSink<TestNode> = {
    async publishSnapshot(nodes, revision) {
      revisions.push(revision);
      labels.push(nodes[0]?.metadata.label ?? "");
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      const gate = deferred<void>();
      gates.push(gate);
      try {
        await gate.promise;
      } finally {
        activeWrites -= 1;
      }
    },
  };
  const publisher = new SubtreePublisher(source, sink);

  const starting = publisher.start();
  await settle();
  assert.deepEqual(revisions, [1]);

  source.change([node("a", "二")], 2);
  source.change([node("a", "三")], 3);
  source.change([node("a", "四")], 4);
  await settle();
  assert.deepEqual(revisions, [1]);

  gates[0]?.resolve();
  await settle();
  assert.deepEqual(revisions, [1, 4]);
  assert.deepEqual(labels, ["一", "四"]);
  assert.equal(maximumActiveWrites, 1);

  gates[1]?.resolve();
  await starting;
  await publisher.close();
});

test("发布失败由 flush 返回并保留 dirty，下一次 flush 重试同一最新快照", async () => {
  const source = new FakeSource([node("a", "一")], 1);
  const revisions: number[] = [];
  let shouldFail = true;
  const sink: SubtreeSnapshotSink<TestNode> = {
    async publishSnapshot(_nodes, revision) {
      revisions.push(revision);
      if (revision === 2 && shouldFail) {
        shouldFail = false;
        throw new Error("模拟写入失败");
      }
    },
  };
  const publisher = new SubtreePublisher(source, sink);
  await publisher.start();

  source.change([node("a", "二")], 2);
  await settle();
  await assert.rejects(publisher.flush(), /模拟写入失败/);
  assert.deepEqual(revisions, [1, 2]);

  await publisher.flush();
  assert.deepEqual(revisions, [1, 2, 2]);
  await publisher.close();
});

test("close 立即退订并等待在途写入，随后不再启动 dirty 发布", async () => {
  const source = new FakeSource([node("a", "一")], 1);
  const secondWrite = deferred<void>();
  const revisions: number[] = [];
  const sink: SubtreeSnapshotSink<TestNode> = {
    async publishSnapshot(_nodes, revision) {
      revisions.push(revision);
      if (revision === 2) await secondWrite.promise;
    },
  };
  const publisher = new SubtreePublisher(source, sink);
  await publisher.start();

  source.change([node("a", "二")], 2);
  const writing = publisher.flush();
  await settle();
  assert.deepEqual(revisions, [1, 2]);

  source.change([node("a", "三")], 3);
  let closeFinished = false;
  const closing = publisher.close().then(() => {
    closeFinished = true;
  });
  assert.equal(source.listenerCount, 0);
  assert.equal(source.unsubscribeCount, 1);
  await settle();
  assert.equal(closeFinished, false);

  secondWrite.resolve();
  await Promise.all([writing, closing]);
  assert.deepEqual(revisions, [1, 2]);

  source.change([node("a", "四")], 4);
  await publisher.flush();
  await publisher.close();
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(source.unsubscribeCount, 1);
});

test("内容相同的前进修订与未前进修订不重复发布，内容变化后才发布", async () => {
  const source = new FakeSource([node("a", "相同")], 1);
  const revisions: number[] = [];
  const sink: SubtreeSnapshotSink<TestNode> = {
    async publishSnapshot(_nodes, revision) {
      revisions.push(revision);
    },
  };
  const publisher = new SubtreePublisher(source, sink);
  await publisher.start();

  source.change([node("a", "相同")], 2);
  await publisher.flush();
  assert.deepEqual(revisions, [1]);

  source.change([node("a", "同修订但变化")], 2);
  await publisher.flush();
  assert.deepEqual(revisions, [1]);

  source.change([node("a", "同修订但变化")], 3);
  await publisher.flush();
  assert.deepEqual(revisions, [1, 3]);
  await publisher.close();
});

test("修订非法倒退时 flush 拒绝且不发布，修订恢复前进后可以继续", async () => {
  const source = new FakeSource([node("a", "五")], 5);
  const revisions: number[] = [];
  const sink: SubtreeSnapshotSink<TestNode> = {
    async publishSnapshot(_nodes, revision) {
      revisions.push(revision);
    },
  };
  const publisher = new SubtreePublisher(source, sink);
  await publisher.start();

  source.change([node("a", "倒退")], 4);
  await assert.rejects(
    publisher.flush(),
    (error: unknown) => error instanceof RangeError && /不能倒退/.test(error.message),
  );
  assert.deepEqual(revisions, [5]);

  source.change([node("a", "恢复")], 6);
  await publisher.flush();
  assert.deepEqual(revisions, [5, 6]);
  await publisher.close();
});
