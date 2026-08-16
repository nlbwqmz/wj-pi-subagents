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
    if (command?.type !== "prompt" || typeof command.message !== "string") {
      throw new Error("无效的原子 prompt 命令");
    }
    await this.prompt(command.message);
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
