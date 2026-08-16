/** 用于验证父端持续消费 bridge stderr 的最小 RpcClient。 */
export class RpcClient {
  #timer;

  constructor() {
    this.#timer = undefined;
  }

  onEvent() {
    return () => {};
  }

  async start() {
    this.#timer = setInterval(() => {
      process.stderr.write("x".repeat(16 * 1024));
    }, 2);
  }

  async stop() {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async send(command) {
    if (command?.type !== "prompt" || typeof command.message !== "string") {
      throw new Error("无效的原子 prompt 命令");
    }
  }

  async prompt() {}
  async steer() {}
  async abort() {}
  async getState() {
    return {};
  }
}
