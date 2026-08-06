import { PassThrough } from "node:stream";
import {
  processTreeStrategyFor,
  type ExitObservation,
  type ManagedProcessTransport,
  type ProcessLaunchSpec,
  type ProcessTreeAdapter,
  type ProcessTreeHandle,
  type ProcessTreeLaunch,
  type ProcessTreeStrategy,
  type ResourceObservation,
} from "./process-tree-capability.ts";
import type { SupportedPlatform } from "./host-gate.ts";

export interface FakeProcessTreeStep {
  readonly exit: ExitObservation["state"];
  readonly resources: ResourceObservation["state"];
}

export interface FakeProcessTreeScenario {
  readonly initial?: FakeProcessTreeStep;
  readonly afterGracefulClose: FakeProcessTreeStep;
  readonly afterForceTerminate?: readonly FakeProcessTreeStep[];
}

export interface FakeProcessTreeAdapterOptions {
  readonly platform?: SupportedPlatform;
  readonly scenarios?: readonly FakeProcessTreeScenario[];
}

interface FakeTreeState {
  readonly scenario: FakeProcessTreeScenario;
  observation: FakeProcessTreeStep;
  forceIndex: number;
  gracefulCloseRequested: boolean;
  released: boolean;
}

interface FakeTreeToken {
  readonly owner: symbol;
}

const DEFAULT_SCENARIO: FakeProcessTreeScenario = {
  initial: { exit: "present", resources: "present" },
  afterGracefulClose: { exit: "present", resources: "present" },
  afterForceTerminate: [{ exit: "exited", resources: "released" }],
};

function copyStep(step: FakeProcessTreeStep): FakeProcessTreeStep {
  return { exit: step.exit, resources: step.resources };
}

function copyScenario(scenario: FakeProcessTreeScenario): FakeProcessTreeScenario {
  return {
    ...(scenario.initial === undefined ? {} : { initial: copyStep(scenario.initial) }),
    afterGracefulClose: copyStep(scenario.afterGracefulClose),
    ...(scenario.afterForceTerminate === undefined
      ? {}
      : { afterForceTerminate: scenario.afterForceTerminate.map(copyStep) }),
  };
}

/**
 * 进程树适配器的确定性替身。场景状态存放在 WeakMap 中，树句柄只是一枚不透明令牌。
 */
export class FakeProcessTreeAdapter implements ProcessTreeAdapter {
  readonly platform: SupportedPlatform;
  readonly strategy: ProcessTreeStrategy;

  private readonly scenarios: readonly FakeProcessTreeScenario[];
  private readonly states = new WeakMap<object, FakeTreeState>();
  private readonly owner = Symbol("fake-process-tree-adapter");
  private nextSequence = 0;

  constructor(options: FakeProcessTreeAdapterOptions = {}) {
    this.platform = options.platform ?? "linux";
    this.strategy = processTreeStrategyFor(this.platform);
    this.scenarios = options.scenarios === undefined || options.scenarios.length === 0
      ? [copyScenario(DEFAULT_SCENARIO)]
      : options.scenarios.map(copyScenario);
  }

  private createTree(): ProcessTreeHandle {
    const scenario =
      this.scenarios[Math.min(this.nextSequence, this.scenarios.length - 1)] ??
      DEFAULT_SCENARIO;
    const initial = scenario.initial ?? { exit: "present", resources: "present" };
    const token: FakeTreeToken = Object.freeze({
      owner: this.owner,
    });
    this.nextSequence += 1;
    this.states.set(token, {
      scenario,
      observation: initial,
      forceIndex: 0,
      gracefulCloseRequested: false,
      released: false,
    });
    return token;
  }

  /** 测试受管节点使用的同事务启动入口。 */
  async launch(_spec: ProcessLaunchSpec): Promise<ProcessTreeLaunch> {
    const tree = this.createTree();
    const transport: ManagedProcessTransport = Object.freeze({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    return Object.freeze({ tree, transport });
  }

  async requestGracefulClose(tree: ProcessTreeHandle, _signal: AbortSignal): Promise<void> {
    const state = this.readState(tree);
    if (state.released || state.gracefulCloseRequested) return;
    state.gracefulCloseRequested = true;
    state.observation = state.scenario.afterGracefulClose;
  }

  async forceTerminate(tree: ProcessTreeHandle): Promise<void> {
    const state = this.readState(tree);
    if (state.released) return;
    const steps = state.scenario.afterForceTerminate;
    if (steps === undefined || steps.length === 0) return;
    const step = steps[Math.min(state.forceIndex, steps.length - 1)];
    if (step !== undefined) state.observation = step;
    state.forceIndex += 1;
  }

  async waitForExit(tree: ProcessTreeHandle, _deadline: number | Date): Promise<ExitObservation> {
    const state = this.readState(tree);
    // fake 不消耗真实时间；present/unknown 表示到达调用方期限时仍未确认退出。
    if (state.released) return { state: "unknown" };
    return { state: state.observation.exit };
  }

  async inspect(tree: ProcessTreeHandle): Promise<ResourceObservation> {
    const state = this.readState(tree);
    if (state.released) return { state: "unknown" };
    return { state: state.observation.resources };
  }

  async release(tree: ProcessTreeHandle): Promise<void> {
    const state = this.readState(tree);
    // 释放句柄后无法再从平台确认资源，因此后续观察安全地返回 unknown。
    state.released = true;
  }

  private readState(tree: ProcessTreeHandle): FakeTreeState {
    if (typeof tree !== "object" || tree === null) {
      throw new TypeError("invalid fake process tree handle");
    }
    const token = tree as FakeTreeToken;
    if (token.owner !== this.owner) {
      throw new TypeError("foreign fake process tree handle");
    }
    const state = this.states.get(token);
    if (state === undefined) throw new TypeError("unknown fake process tree handle");
    return state;
  }
}
