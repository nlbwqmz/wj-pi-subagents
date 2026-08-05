const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

class FakeRpcClient {
  constructor() {
    this.commands = [];
    this.settled = false;
  }

  prompt(text) {
    this.commands.push(`prompt:${text}`);
    return { accepted: true };
  }

  abort() {
    this.commands.push("abort");
    return { accepted: true };
  }

  emitSettled() {
    this.settled = true;
  }
}

class FakeProcessTreeAdapter {
  constructor() {
    this.gracefulRequested = false;
    this.forceRequested = false;
    this.resources = "running";
  }

  requestGracefulClose() {
    this.gracefulRequested = true;
  }

  forceTerminate() {
    this.forceRequested = true;
    if (this.resources !== "stuck") this.resources = "exited";
  }

  inspect() {
    return this.resources;
  }
}

class Supervisor {
  constructor() {
    this.rpc = new FakeRpcClient();
    this.processTree = new FakeProcessTreeAdapter();
    this.state = "idle";
    this.commandQueue = [];
    this.terminationPromise = null;
  }

  sendMessage(text) {
    assert(this.state !== "terminating" && this.state !== "terminated", "终止屏障拒绝消息");
    this.commandQueue.push({ kind: "prompt", text });
    return { accepted: true, pending: this.commandQueue.length };
  }

  flushNext() {
    const command = this.commandQueue.shift();
    if (!command) return;
    this.rpc.prompt(command.text);
    this.state = "working";
  }

  interrupt() {
    if (this.state === "working") {
      this.state = "interrupting";
      this.rpc.abort();
      return { changed: true };
    }
    return { changed: false };
  }

  settle() {
    this.rpc.emitSettled();
    if (this.state === "working" || this.state === "interrupting") this.state = "idle";
  }

  terminate() {
    if (this.terminationPromise) return this.terminationPromise;
    this.state = "terminating";
    this.commandQueue = [];
    this.processTree.requestGracefulClose();
    this.terminationPromise = {
      force: () => this.processTree.forceTerminate(),
      confirm: () => {
        const resources = this.processTree.inspect();
        if (resources === "exited") {
          this.state = "terminated";
          return { ok: true, state: this.state };
        }
        return { ok: false, code: "termination_incomplete", state: this.state };
      },
    };
    return this.terminationPromise;
  }
}

const supervisor = new Supervisor();
assert(supervisor.sendMessage("first").accepted, "首条消息未接受");
assert(supervisor.sendMessage("steer").pending === 2, "pending 计数错误");
supervisor.flushNext();
assert(supervisor.state === "working", "prompt 未进入 working");
supervisor.interrupt();
assert(supervisor.state === "interrupting", "interrupt 未建立状态");
supervisor.settle();
assert(supervisor.state === "idle", "只有 settle 才能恢复 idle");

supervisor.sendMessage("second");
supervisor.flushNext();
const firstTermination = supervisor.terminate();
const secondTermination = supervisor.terminate();
assert(firstTermination === secondTermination, "重复终止没有合并");
assert(supervisor.state === "terminating", "终止屏障未建立");
assert(supervisor.commandQueue.length === 0, "未写入命令没有取消");
firstTermination.force();
assert(firstTermination.confirm().ok === true, "整树回收未确认");
assert(supervisor.state === "terminated", "资源确认后未进入 terminated");

const stuck = new Supervisor();
stuck.sendMessage("work");
stuck.flushNext();
stuck.processTree.resources = "stuck";
const incomplete = stuck.terminate();
incomplete.force();
const incompleteResult = incomplete.confirm();
assert(incompleteResult.code === "termination_incomplete", "残留资源未报告 termination_incomplete");
assert(stuck.state === "terminating", "清理不完整却离开 terminating");

console.log(JSON.stringify({
  passed: true,
  normal_path: {
    state: supervisor.state,
    rpc_commands: supervisor.rpc.commands,
    forced: supervisor.processTree.forceRequested,
  },
  incomplete_path: incompleteResult,
}, null, 2));
