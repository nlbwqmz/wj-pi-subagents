/** 只用于 bridge 模块路径回归测试的最小 RpcClient。 */
export class RpcClient {
  #listeners = new Set();

  constructor() {}

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {}

  async stop() {}

  async prompt() {}

  async steer() {}

  async abort() {}

  async getState() {
    return {};
  }
}
