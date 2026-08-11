import {
  SupervisorChannel,
  SupervisorRequestIdRegistry,
  type SupervisorChannelPublicState,
  type SupervisorEvent,
  type SupervisorFrame,
  type SupervisorReply,
  type SupervisorReplyInput,
  type SupervisorSnapshot,
  type SupervisorTaskStarted,
} from "../../src/supervisor-channel.ts";
import {
  MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
  type ManagedRpcSupervisorInit,
} from "../../src/managed-rpc-node.ts";

export interface BridgeSupervisorEndpointOptions {
  readonly init: ManagedRpcSupervisorInit;
  readonly send: (frame: Uint8Array) => void;
  readonly onFault?: () => void;
}

/**
 * 旧 bridge child 端点只作为协议测试替身保留。生产 bridge 是透明字节中继，
 * 真正 child runtime 才拥有监督端点、子树发布器和关闭级联。
 */
export class BridgeSupervisorEndpoint {
  private readonly protocol: SupervisorChannel;
  private readonly initialSnapshot: ManagedRpcSupervisorInit["initial_snapshot"];
  private readonly initialSubtreeRevision: number;
  private readonly sendFrame: (frame: Uint8Array) => void;
  private readonly onFault: (() => void) | undefined;
  private snapshotSent = false;
  private faulted = false;

  constructor(options: BridgeSupervisorEndpointOptions) {
    this.protocol = new SupervisorChannel({
      role: "child",
      rootId: options.init.root_id,
      localAgentId: options.init.local_agent_id,
      peerAgentId: options.init.peer_agent_id,
      parentAgentId: options.init.parent_agent_id,
      depth: options.init.depth,
      credential: options.init.credential,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      limits: { maxFrameBytes: MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES },
    });
    this.initialSnapshot = Object.freeze(
      options.init.initial_snapshot.map((node) => Object.freeze({ ...node })),
    );
    this.initialSubtreeRevision = options.init.initial_subtree_revision;
    this.sendFrame = options.send;
    this.onFault = options.onFault;
  }

  start(): void {
    this.send(this.protocol.startHandshake());
  }

  receive(frame: Uint8Array): void {
    if (this.faulted) return;
    const result = this.protocol.receive(frame);
    if (result.kind === "protocol_fault" || result.kind === "eof") {
      this.fail();
      return;
    }
    if (result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap") {
      for (const outbound of result.outbound) this.send(outbound);
    }
    if (!this.snapshotSent && this.protocol.getPublicState().state === "awaiting_snapshot") {
      this.snapshotSent = true;
      try {
        this.send(this.protocol.publishSnapshot(
          this.initialSnapshot,
          this.initialSubtreeRevision,
        ));
      } catch {
        this.fail();
      }
    }
  }

  publishReply(reply: SupervisorReplyInput | SupervisorReply): void {
    this.send(this.protocol.publishReply(reply));
  }

  publishTaskStarted(started: SupervisorTaskStarted): void {
    this.send(this.protocol.publishTaskStarted(started));
  }

  publishEvent(event: Omit<SupervisorEvent, "root_id" | "agent_id">): void {
    this.send(this.protocol.publishEvent(event));
  }

  publishSnapshot(nodes: readonly SupervisorSnapshot["nodes"][number][], subtreeRevision: number): void {
    this.send(this.protocol.publishSnapshot(nodes, subtreeRevision));
  }

  getLatestSnapshot(): SupervisorSnapshot | undefined {
    return this.protocol.getLatestSnapshot();
  }

  establishTerminationBarrier(): void {
    this.protocol.establishTerminationBarrier();
  }

  close(): void {
    this.protocol.establishTerminationBarrier();
    this.send(this.protocol.createCloseFrame());
  }

  getPublicState(): SupervisorChannelPublicState {
    return this.protocol.getPublicState();
  }

  private send(frame: SupervisorFrame): void {
    if (this.faulted) return;
    try {
      this.sendFrame(this.protocol.encode(frame));
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    if (this.faulted) return;
    this.faulted = true;
    this.protocol.markProtocolFault();
    try {
      this.onFault?.();
    } catch {
      // 测试替身的故障观察者不能再次进入协议路径。
    }
  }
}
