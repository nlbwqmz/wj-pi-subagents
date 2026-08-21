/** 用于验证 bridge 不会把 Pi 的 success:false 响应误报为命令成功。 */
export class RpcClient {
  #listeners = new Set();

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {}

  async stop() {}

  async send(command) {
    return {
      type: "response",
      command: command?.type,
      success: false,
      error: command?.type === "prompt" && command?.message === "压缩期间 prompt"
        ? "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."
        : command?.type === "prompt" && command?.message === "宿主忙碌 prompt"
          ? "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
          : "explicit rejection",
    };
  }

  // 旧 RpcClient 包装方法会吞掉 success:false；bridge 不得依赖它们。
  async prompt() {}

  async steer() {}

  async abort() {}

  async getState() {
    return { isStreaming: false, pendingMessageCount: 0 };
  }
}
