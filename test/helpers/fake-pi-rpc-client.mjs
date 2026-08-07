import {
  nativeLocalSupervisorTransportAdapter,
} from "../../src/local-supervisor-transport.ts";
import {
  RUNTIME_EPHEMERAL_ENV_KEYS,
  RUNTIME_INTERNAL_ENV_KEYS,
} from "../../src/root-runtime-context.ts";
import { StreamSupervisorChannel } from "../../src/stream-supervisor-channel.ts";
import { SupervisorRequestIdRegistry } from "../../src/supervisor-channel.ts";

/**
 * 生产 bridge 协议集成所用的最小 RpcClient 替身。它不访问模型或网络，
 * 只模拟真实 RpcClient 把传入环境交给 child Pi 的行为。
 */
export class RpcClient {
  #options;
  #listeners = new Set();
  #channel;
  #ready;
  #endpoint;
  #localCredential;
  #agentId;

  constructor(options = {}) {
    this.#options = options;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {
    const childEnvironment = this.#options.env ?? {};
    const endpoint = requiredString(
      childEnvironment[RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint],
    );
    const localCredential = requiredString(
      childEnvironment[RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential],
    );
    const supervisorCredential = requiredString(
      childEnvironment[RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential],
    );
    const rootId = requiredString(process.env[RUNTIME_INTERNAL_ENV_KEYS.rootId]);
    const agentId = requiredString(process.env[RUNTIME_INTERNAL_ENV_KEYS.agentId]);
    const parentValue = process.env[RUNTIME_INTERNAL_ENV_KEYS.parentAgentId];
    const parentAgentId = parentValue === "" ? null : requiredString(parentValue);
    const depth = Number(requiredString(process.env[RUNTIME_INTERNAL_ENV_KEYS.depth]));
    const transport = await nativeLocalSupervisorTransportAdapter.connect({
      endpoint,
      agentId,
      credential: localCredential,
    });
    const channel = new StreamSupervisorChannel({
      role: "child",
      rootId,
      localAgentId: agentId,
      peerAgentId: parentAgentId ?? "",
      parentAgentId,
      depth,
      credential: supervisorCredential,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      initialSnapshot: [{
        agent_id: agentId,
        parent_agent_id: parentAgentId,
        template_id: "researcher",
        name: "生产桥接 fake 子端点",
        depth,
        state: "starting",
        pending_message_count: 0,
        revision: 1,
      }],
      initialSubtreeRevision: 1,
    });
    this.#channel = channel;
    this.#endpoint = endpoint;
    this.#localCredential = localCredential;
    this.#agentId = agentId;
    await channel.bind(new AbortController().signal);
    // 生产 bridge 必须在 RpcClient.start 返回后才能绑定 listener；ready 只能后台等待。
    this.#ready = channel.waitForReady(new AbortController().signal);
  }

  async prompt() {
    await this.#requireReady();
    // 任务 RPC 的同名事件是 canary；生产 bridge 必须忽略它。
    for (const listener of this.#listeners) {
      listener({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "不得从任务 RPC 上行" }],
        },
      });
    }
    await this.#channel.publishReply({ text: "真正 child 监督回复" });
  }

  async steer() {}

  async abort() {}

  async getState() {
    await this.#requireReady();
    return {
      supervisor: this.#channel.getPublicState(),
      endpoint: this.#endpoint,
      localCredential: this.#localCredential,
      agentId: this.#agentId,
    };
  }

  async stop() {
    await this.#channel?.release();
  }

  async #requireReady() {
    if (this.#channel === undefined || this.#ready === undefined) {
      throw new Error("fake RpcClient 尚未启动");
    }
    await this.#ready;
  }
}

function requiredString(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("fake RpcClient 缺少运行时字段");
  }
  return value;
}
