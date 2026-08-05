import type {
  ExitObservation,
  ResourceObservation,
} from "./process-tree-capability.ts";

export interface ProcessTreeResourceEvidence {
  readonly exit: ExitObservation;
  readonly resources: ResourceObservation;
}

/** 进程树资源边界的三态结果，不等同于代理生命周期状态。 */
export type ProcessTreeResourceState = "confirmed_exited" | "present" | "unknown";

export interface ProcessTreeResourceAssessment {
  readonly state: ProcessTreeResourceState;
}

/**
 * 汇总平台进程树观察，但不裁决代理生命周期或配额。
 * 控制器仍须结合监督端点、本节点和全部后代的确认事实。
 */
export function classifyProcessTreeResources(
  evidence: ProcessTreeResourceEvidence,
): ProcessTreeResourceAssessment {
  if (evidence.exit.state === "exited" && evidence.resources.state === "released") {
    return { state: "confirmed_exited" };
  }

  if (evidence.exit.state === "present" || evidence.resources.state === "present") {
    return { state: "present" };
  }

  return { state: "unknown" };
}
