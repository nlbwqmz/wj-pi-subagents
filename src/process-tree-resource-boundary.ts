import type {
  ExitObservation,
  ResourceObservation,
} from "./process-tree-capability.ts";

export interface ProcessTreeTerminationEvidence {
  readonly exit: ExitObservation;
  readonly resources: ResourceObservation;
}

/** 进程树资源边界的三态结果，不等同于代理生命周期状态。 */
export type ProcessTreeResourceState = "confirmed_exited" | "present" | "unknown";

export type ProcessTreeTerminationDecision =
  | {
      readonly resourceState: "confirmed_exited";
      readonly lifecycle: "terminated";
      readonly releaseQuotaSlots: true;
    }
  | {
      readonly resourceState: Exclude<ProcessTreeResourceState, "confirmed_exited">;
      readonly lifecycle: "terminating";
      readonly releaseQuotaSlots: false;
    };

/**
 * 将平台观察转换为控制器可消费的保守决策，适配器本身不修改生命周期或配额。
 */
export function decideProcessTreeTermination(
  evidence: ProcessTreeTerminationEvidence,
): ProcessTreeTerminationDecision {
  if (evidence.exit.state === "exited" && evidence.resources.state === "released") {
    return {
      resourceState: "confirmed_exited",
      lifecycle: "terminated",
      releaseQuotaSlots: true,
    };
  }

  if (evidence.exit.state === "present" || evidence.resources.state === "present") {
    return {
      resourceState: "present",
      lifecycle: "terminating",
      releaseQuotaSlots: false,
    };
  }

  return {
    resourceState: "unknown",
    lifecycle: "terminating",
    releaseQuotaSlots: false,
  };
}
