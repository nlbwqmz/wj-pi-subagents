export class RpcClient {
  #ready = false;
  #listeners = new Set();

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.#ready = true;
  }

  async stop() {}

  async send(command) {
    if (!["prompt", "steer"].includes(command?.type) || typeof command.message !== "string") {
      throw new Error("无效的原子消息命令");
    }
    await this[command.type](command.message);
    return { type: "response", command: command.type, success: true };
  }

  async prompt() {
    if (!this.#ready) throw new Error("RPC 尚未启动");
  }

  async steer() {
    if (!this.#ready) throw new Error("RPC 尚未启动");
  }

  async abort() {
    if (!this.#ready) throw new Error("RPC 尚未启动");
  }

  async getState() {
    if (!this.#ready) throw new Error("RPC 尚未启动");
    return { isStreaming: false, pendingMessageCount: 0 };
  }
}
