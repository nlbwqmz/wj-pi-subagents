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
      error: "explicit rejection",
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
