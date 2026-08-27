/** 只用于 bridge 启动诊断回归测试的最小 RpcClient。 */
export class RpcClient {
  #options;

  constructor(options = {}) {
    this.#options = options;
  }

  onEvent() {
    return () => {};
  }

  async start() {}

  async stop() {}

  async send() {
    throw new Error("测试客户端不接受任务命令");
  }

  async prompt() {}

  async steer() {}

  async abort() {}

  async getState() {
    const scenario = this.#options.model;
    if (scenario === "provider-failure") {
      throw new Error(
        'Agent process exited (code=1 signal=null). Stderr: Error: Unknown provider "wj-provider". Use --list-models to see available providers/models.',
      );
    }
    if (scenario === "model-failure") {
      throw new Error(
        'Agent process exited (code=1 signal=null). Stderr: Model "wj-provider/missing-model" not found. Use --list-models to see available models.',
      );
    }
    if (scenario === "extension-failure") {
      throw new Error(
        'Agent process exited (code=1 signal=null). Stderr: Failed to load extension "C:\\Users\\robot\\private\\bad-extension.ts": TOP_SECRET_EXTENSION_DETAIL',
      );
    }
    return {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    };
  }
}
