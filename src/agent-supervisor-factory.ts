import { randomBytes, randomUUID } from "node:crypto";
import { AGENT_TOOL_NAMES } from "./agent-tools.ts";
import type {
  AgentSupervisorFactory,
  AgentSupervisorFactoryInput,
} from "./agent-controller.ts";
import {
  createManagedRpcNode,
  type ManagedRpcNodeLike,
  type ManagedRpcReply,
  type ManagedRpcSupervisorInit,
} from "./managed-rpc-node.ts";
import { ManagedRpcSupervisorChannel } from "./managed-rpc-supervisor-channel.ts";
import type { ProcessTreeAdapter } from "./process-tree-capability.ts";
import {
  RpcSupervisor,
  type RpcSupervisorChannelBinding,
} from "./rpc-supervisor.ts";
import type { RootRuntimeContext } from "./root-runtime-context.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "./template-discovery-snapshot.ts";
import { SupervisorRequestIdRegistry } from "./supervisor-channel.ts";
import type { TreeActor, TreeController } from "./tree-controller.ts";

export interface AgentSupervisorFactoryOptions {
  readonly tree: TreeController;
  readonly actor: TreeActor;
  readonly processTreeAdapter: ProcessTreeAdapter;
  readonly rootRuntime: RootRuntimeContext;
  readonly templateSnapshot: TemplateDiscoverySnapshot;
  readonly rootId?: string;
  readonly bridgeScriptPath?: string;
  readonly startupTimeoutMs?: number;
  readonly gracefulShutdownMs?: number;
  readonly nodeFactory?: (template: TemplateDefinition) => ManagedRpcNodeLike;
  readonly activeTools?: () => readonly string[];
  readonly currentModel?: string | (() => string | undefined);
  readonly currentThinking?: string | (() => string | undefined);
  readonly managementToolNames?: readonly string[];
  /** 只有宿主消息已同步进入父会话上下文时才返回 true，随后协议才会 ACK。 */
  readonly deliverReply?: (agentId: string, reply: ManagedRpcReply) => boolean;
}

/** 生产节点装配所需的稳定桥接超时；不受 wait_agent 参数影响。 */
export const DEFAULT_RPC_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_GRACEFUL_SHUTDOWN_MS = 2_000;

/**
 * 创建 AgentController 使用的生产监督器工厂。工厂本身不启动进程；每次
 * `createSupervisor` 只构造一个节点，实际 launch 仍由 RpcSupervisor.start 线性化。
 */
export function createAgentSupervisorFactory(
  options: AgentSupervisorFactoryOptions,
): AgentSupervisorFactory {
  if (options.templateSnapshot === undefined) throw new TypeError("生产工厂需要模板快照");
  const rootId = options.rootId ?? randomUUID();
  const localAgentId = options.actor.kind === "agent" ? options.actor.agent_id : null;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_RPC_STARTUP_TIMEOUT_MS;
  const gracefulShutdownMs = options.gracefulShutdownMs ?? DEFAULT_RPC_GRACEFUL_SHUTDOWN_MS;
  const requestIdRegistry = new SupervisorRequestIdRegistry();

  return (input: AgentSupervisorFactoryInput): RpcSupervisor => {
    const template = input.template ?? resolveTemplate(options.templateSnapshot, input.reservation.templateId);
    if (template === undefined) throw new Error("模板快照未提供有效模板");
    const node = options.nodeFactory?.(template) ?? createManagedRpcNode({
      processTreeAdapter: options.processTreeAdapter,
      cwd: options.rootRuntime.cwd,
      env: options.rootRuntime.environment,
      rpcOptions: buildManagedRpcOptions(template, {
        currentModel: options.currentModel,
        currentThinking: options.currentThinking,
        managementTools: childManagementEnabled(options, input, template)
          ? (options.managementToolNames ?? AGENT_TOOL_NAMES)
          : [],
      }),
      ...(options.bridgeScriptPath === undefined ? {} : { bridgeScriptPath: options.bridgeScriptPath }),
    });

    return new RpcSupervisor({
      controller: options.tree,
      actor: input.actor,
      reservation: input.reservation,
      managedNode: node,
      channelFactory: (context): RpcSupervisorChannelBinding => {
        const credential = randomBytes(32).toString("base64url");
        const channel = new ManagedRpcSupervisorChannel({
          node,
          rootId,
          localAgentId,
          peerAgentId: context.agent_id,
          parentAgentId: context.parent_agent_id,
          depth: context.depth,
          credential,
          requestIdRegistry,
          onReply: (reply) => {
            if (options.deliverReply === undefined) return false;
            try {
              return options.deliverReply(context.agent_id, {
                text: reply.text,
                ...(reply.images === undefined
                  ? {}
                  : { images: reply.images.map((image) => Object.freeze({ ...image })) }),
              }) === true;
            } catch {
              return false;
            }
          },
        });
        const supervisor: ManagedRpcSupervisorInit = {
          root_id: rootId,
          local_agent_id: context.agent_id,
          peer_agent_id: localAgentId ?? "",
          parent_agent_id: context.parent_agent_id,
          depth: context.depth,
          credential,
          initial_snapshot: context.initial_snapshot,
          initial_subtree_revision: 1,
        };
        const runtime = options.rootRuntime.createChildRuntimeContext({
          parentAgentId: context.parent_agent_id ?? rootId,
          agentId: context.agent_id,
          depth: context.depth,
        });
        return Object.freeze({
          channel,
          nodeStartContext: Object.freeze({
            supervisor,
            environment: runtime.environment,
          }),
        });
      },
      startupTimeoutMs,
      gracefulShutdownMs,
    });
  };
}

function resolveTemplate(
  snapshot: TemplateDiscoverySnapshot,
  templateId: string,
): TemplateDefinition | undefined {
  const result = snapshot.resolveTemplate(templateId);
  return result.kind === "valid" ? result.template : undefined;
}

export function buildManagedRpcOptions(
  template: TemplateDefinition,
  options: {
    readonly currentModel?: AgentSupervisorFactoryOptions["currentModel"];
    readonly currentThinking?: AgentSupervisorFactoryOptions["currentThinking"];
    readonly managementTools?: readonly string[];
  } = {},
): Readonly<Record<string, unknown>> {
  const args: string[] = ["--no-session"];
  if (template.contextFiles === "disabled") args.push("--no-context-files");
  const thinking = template.thinking ?? resolveCurrent(options.currentThinking);
  if (thinking !== undefined) args.push("--thinking", thinking);
  if (template.body.trim() !== "") {
    args.push(template.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", template.body);
  }
  const tools = [...new Set([...template.tools, ...(options.managementTools ?? [])])];
  // 空字符串仍是显式 allowlist；省略 --tools 会错误启用 Pi 默认工具。
  args.push("--tools", tools.join(","));
  const selectedModel = template.model ?? resolveCurrent(options.currentModel);
  const [provider, model] = splitModel(selectedModel);
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    args: Object.freeze(args),
  });
}

function childManagementEnabled(
  options: Pick<AgentSupervisorFactoryOptions, "tree" | "rootRuntime">,
  input: AgentSupervisorFactoryInput,
  template: TemplateDefinition,
): boolean {
  if (template.subagents === "disabled") return false;
  const parentCapability = options.tree.getManagementCapability(input.actor);
  if (!parentCapability.ok || !parentCapability.data.enabled) return false;
  if (input.actor.kind === "root") return 1 < options.rootRuntime.config.maxDepth;
  const parent = options.tree.getStatus(input.actor.agent_id);
  return parent.ok && parent.data.depth + 1 < options.rootRuntime.config.maxDepth;
}

function resolveCurrent(
  value: string | (() => string | undefined) | undefined,
): string | undefined {
  if (typeof value !== "function") return value;
  try {
    return value();
  } catch {
    return undefined;
  }
}

function splitModel(value: string | undefined): [string | undefined, string | undefined] {
  if (value === undefined) return [undefined, undefined];
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return [undefined, undefined];
  return [value.slice(0, separator), value.slice(separator + 1)];
}
