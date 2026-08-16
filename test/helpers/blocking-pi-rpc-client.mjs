/**
 * 用于验证 bridge 控制命令不受阻塞 prompt 影响的最小 RpcClient 替身。
 */
export class RpcClient {
  #listeners = new Set();

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {}

  async stop() {}

  async prompt() {
    throw new Error("bridge 必须通过 RpcClient.send 投递 prompt");
  }

  async send(command) {
    if (command?.type !== "prompt" || typeof command.message !== "string") {
      throw new Error("无效的原子 prompt 命令");
    }
    this.#emit({ type: "agent_start" });
    await new Promise(() => {});
  }

  async steer() {}

  async abort() {
    this.#emit({ type: "agent_settled" });
  }

  async getState() {
    return { isStreaming: true, pendingMessageCount: 0 };
  }

  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
}
