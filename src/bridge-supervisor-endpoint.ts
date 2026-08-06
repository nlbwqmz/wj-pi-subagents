import {
  SupervisorChannel,
  SupervisorRequestIdRegistry,
  type SupervisorChannelPublicState,
  type SupervisorEvent,
  type SupervisorFrame,
  type SupervisorReply,
} from "./supervisor-channel.ts";
import {
  MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
  type ManagedRpcSupervisorInit,
} from "./managed-rpc-node.ts";

export interface BridgeSupervisorEndpointOptions {
  readonly init: ManagedRpcSupervisorInit;
  readonly send: (frame: Uint8Array) => void;
  readonly onFault?: () => void;
}

/**
 * 桥接进程内的 child 监督端点。它只接收完整监督帧，不接触 Pi JSONL，
 * 并把协议自动产生的 hello、快照、ACK 和重同步帧交还桥接写入器。
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
    if (
      !this.snapshotSent
      && this.protocol.getPublicState().state === "awaiting_snapshot"
    ) {
      this.snapshotSent = true;
      try {
        this.send(this.protocol.publishSnapshot(
          this.initialSnapshot,
          this.initialSubtreeRevision,
        ));
      } catch {
        this.fail();
        return;
      }
    }
  }

  publishReply(reply: Omit<SupervisorReply, "reply_seq">): void {
    this.send(this.protocol.publishReply(reply));
  }

  publishEvent(event: Omit<SupervisorEvent, "root_id" | "agent_id">): void {
    this.send(this.protocol.publishEvent(event));
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
      // 故障观察者异常不能再次进入协议路径。
    }
  }
}
