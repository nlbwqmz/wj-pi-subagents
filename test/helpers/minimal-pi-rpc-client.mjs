import { existsSync, readFileSync } from "node:fs";

/** 只用于 bridge 模块路径和临时系统提示文件回归测试的最小 RpcClient。 */
export class RpcClient {
  #listeners = new Set();
  #options;
  #state = {};

  constructor(options = {}) {
    this.#options = options;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {
    const args = Array.isArray(this.#options.args) ? [...this.#options.args] : [];
    const appendIndex = args.indexOf("--append-system-prompt");
    const replaceIndex = args.indexOf("--system-prompt");
    const promptIndex = appendIndex >= 0 ? appendIndex : replaceIndex;
    const promptPath = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
    this.#state = {
      args,
      ...(promptPath === undefined ? {} : {
        promptBytes: Buffer.byteLength(readFileSync(promptPath, "utf8")),
        promptPrefix: readFileSync(promptPath, "utf8").slice(0, 64),
        promptPath,
        promptPathExistedAtStart: existsSync(promptPath),
      }),
    };
  }

  async stop() {}

  async send(command) {
    if (
      !["prompt", "steer"].includes(command?.type)
      || typeof command.message !== "string"
      || (command.streamingBehavior !== undefined && command.streamingBehavior !== "steer")
    ) {
      throw new Error("无效的原子消息命令");
    }
    this.#state = {
      ...this.#state,
      lastCommand: {
        type: command.type,
        message: command.message,
        ...(command.streamingBehavior === undefined
          ? {}
          : { streamingBehavior: command.streamingBehavior }),
      },
    };
    return { type: "response", command: command.type, success: true };
  }

  async prompt(message) {
    this.#state = { ...this.#state, lastCommand: { type: "prompt", message } };
  }

  async steer(message) {
    this.#state = { ...this.#state, lastCommand: { type: "steer", message } };
  }

  async abort() {}

  async getState() {
    return {
      ...this.#state,
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      ...(typeof this.#state.promptPath === "string"
        ? { promptPathExistsAfterStart: existsSync(this.#state.promptPath) }
        : {}),
    };
  }
}
