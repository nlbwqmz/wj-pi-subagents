// THROWAWAY PROTOTYPE：用于手动推动生命周期状态机，不是生产 CLI。

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  applyAction,
  createModel,
  getOperationMatrix,
  getWaitResult,
  inspectModel,
} from "./machine.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const QUESTION =
  "七态生命周期能否在启动失败、中断后继续、迟到事件、等待竞态和级联终止下保持单向且可解释？";

function action(type, agentId, extra = {}) {
  return { type, agent_id: agentId, ...extra };
}

function parseCommand(line) {
  const [command, ...args] = line.trim().split(/\s+/);
  switch (command) {
    case "add":
      return {
        kind: "action",
        value: {
          type: "register",
          agent_id: args[0],
          parent_agent_id: args[1] && args[1] !== "-" ? args[1] : null,
        },
      };
    case "handshake":
      return { kind: "action", value: action("handshake_completed", args[0]) };
    case "admit":
      return {
        kind: "action",
        value: action("admit_message", args[0], { message_id: args[1] }),
      };
    case "accept":
      return {
        kind: "action",
        value: action("accept_message", args[0], { message_id: args[1] }),
      };
    case "start":
      return {
        kind: "action",
        value: action("message_started", args[0], { message_id: args[1] }),
      };
    case "reject":
      return {
        kind: "action",
        value: action("delivery_failed", args[0], {
          message_id: args[1],
          retryable: true,
        }),
      };
    case "unknown":
      return {
        kind: "action",
        value: action("delivery_unknown", args[0], { message_id: args[1] }),
      };
    case "interrupt":
      return { kind: "action", value: action("interrupt_requested", args[0]) };
    case "abort-ack":
      return { kind: "action", value: action("abort_ack", args[0]) };
    case "end":
      return { kind: "action", value: action("agent_end", args[0]) };
    case "settle":
      return { kind: "action", value: action("agent_settled", args[0]) };
    case "fail":
      return {
        kind: "action",
        value: action("runtime_failed", args[0], {
          code: args[1] ?? "rpc_unavailable",
        }),
      };
    case "startup-fail":
      return {
        kind: "action",
        value: action("startup_failed", args[0], {
          code: args[1] ?? "spawn_failed",
        }),
      };
    case "terminate":
      return { kind: "action", value: action("terminate_subtree", args[0]) };
    case "incomplete":
      return { kind: "action", value: action("termination_incomplete", args[0]) };
    case "reclaim":
      return { kind: "action", value: action("resource_reclaimed", args[0]) };
    case "wait":
      return {
        kind: "action",
        value: action("wait_start", args[1], { wait_id: args[0] }),
      };
    case "timeout":
      return { kind: "action", value: { type: "wait_timeout", wait_id: args[0] } };
    case "wait-result":
      return { kind: "query", value: { type: "wait", wait_id: args[0] } };
    case "matrix":
      return { kind: "query", value: { type: "matrix", agent_id: args[0] } };
    case "trace":
      return { kind: "query", value: { type: "trace" } };
    case "help":
      return { kind: "query", value: { type: "help" } };
    case "q":
    case "quit":
      return { kind: "quit" };
    default:
      return { kind: "query", value: { type: "error", error: "未知命令" } };
  }
}

function query(model, request) {
  if (request.type === "wait") return getWaitResult(model, request.wait_id);
  if (request.type === "matrix") return getOperationMatrix(model, request.agent_id);
  if (request.type === "trace") return model.trace;
  if (request.type === "help") return commandHelp();
  return { ok: false, error: request.error ?? "未知查询" };
}

function commandHelp() {
  return [
    "add <代理> [父代理|-]     handshake <代理>",
    "admit <代理> <消息>       accept/start/reject/unknown <代理> <消息>",
    "interrupt/abort-ack/end/settle <代理>",
    "fail <代理> [错误码]      startup-fail <代理> [spawn_failed|spawn_timeout]",
    "terminate/incomplete/reclaim <代理>",
    "wait <等待ID> <代理>      timeout/wait-result <等待ID>",
    "matrix <代理>             trace    help    quit",
  ];
}

function render(model, queryResult = null, shouldClear = true) {
  if (shouldClear) console.clear();
  console.log(`${BOLD}THROWAWAY：Pi 子代理生命周期状态机${RESET}`);
  console.log(`${DIM}问题：${QUESTION}${RESET}\n`);
  console.log(`${BOLD}当前完整状态${RESET}`);
  console.log(JSON.stringify(inspectModel(model), null, 2));

  if (queryResult !== null) {
    console.log(`\n${BOLD}查询结果${RESET}`);
    console.log(
      typeof queryResult === "string"
        ? queryResult
        : JSON.stringify(queryResult, null, 2),
    );
  }

  console.log(`\n${BOLD}命令${RESET}`);
  for (const line of commandHelp()) console.log(`${DIM}${line}${RESET}`);
}

function printDemoStep(title, model, extra = null) {
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log(JSON.stringify(inspectModel(model), null, 2));
  if (extra !== null) {
    console.log(`${DIM}额外观察${RESET}`);
    console.log(JSON.stringify(extra, null, 2));
  }
}

function applyDemoStep(model, title, nextAction, extraFactory = null) {
  const next = applyAction(model, nextAction);
  printDemoStep(title, next, extraFactory ? extraFactory(next) : null);
  return next;
}

function runDemo() {
  console.log(`${BOLD}THROWAWAY 内置演示${RESET}`);
  console.log(`${DIM}${QUESTION}${RESET}`);

  let interruptModel = createModel();
  interruptModel = applyDemoStep(interruptModel, "1. 登记节点 a", {
    type: "register",
    agent_id: "a",
    parent_agent_id: null,
  });
  interruptModel = applyDemoStep(
    interruptModel,
    "2. 握手完成：starting -> idle",
    action("handshake_completed", "a"),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "3. 首条消息进入控制器队列",
    action("admit_message", "a", { message_id: "m1" }),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "4. RPC 接受首条消息：idle -> working",
    action("accept_message", "a", { message_id: "m1" }),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "5. 登记等待器 w1",
    action("wait_start", "a", { wait_id: "w1" }),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "6. 接纳中断：working -> interrupting",
    action("interrupt_requested", "a"),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "7. agent_end 不结束 interrupting",
    action("agent_end", "a"),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "8. 中断期间追加消息 m2，留在控制器队列",
    action("admit_message", "a", { message_id: "m2" }),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "9. agent_settled：interrupting -> idle，并完成 w1",
    action("agent_settled", "a"),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "10. m2 获得接受：idle -> working",
    action("accept_message", "a", { message_id: "m2" }),
    (model) => getWaitResult(model, "w1"),
  );
  const waitRaceObservation = getWaitResult(interruptModel, "w1");
  interruptModel = applyDemoStep(
    interruptModel,
    "11. 终止屏障：working -> terminating",
    action("terminate_subtree", "a"),
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "12. 迟到 agent_settled 被终止优先级忽略",
    action("agent_settled", "a"),
  );
  const lateSettleObservation = structuredClone(interruptModel.last_result);
  interruptModel = applyDemoStep(
    interruptModel,
    "13. 回收未完成：保持 terminating 并附故障",
    action("termination_incomplete", "a"),
  );
  const incompleteObservation = inspectModel(interruptModel).nodes.find(
    (node) => node.agent_id === "a",
  );
  interruptModel = applyDemoStep(
    interruptModel,
    "14. 资源确认回收：terminating -> terminated",
    action("resource_reclaimed", "a"),
  );

  let startupModel = createModel();
  startupModel = applyAction(startupModel, {
    type: "register",
    agent_id: "s",
    parent_agent_id: null,
  });
  startupModel = applyAction(
    startupModel,
    action("wait_start", "s", { wait_id: "ws" }),
  );
  startupModel = applyDemoStep(
    startupModel,
    "15. 启动超时：starting -> failed -> terminating",
    action("startup_failed", "s", { code: "spawn_timeout" }),
    (model) => getWaitResult(model, "ws"),
  );
  const startupWaitObservation = getWaitResult(startupModel, "ws");
  startupModel = applyDemoStep(
    startupModel,
    "16. 启动残留回收：terminating -> terminated",
    action("resource_reclaimed", "s"),
  );

  let deliveryModel = createModel();
  for (const nextAction of [
    { type: "register", agent_id: "u", parent_agent_id: null },
    action("handshake_completed", "u"),
    action("admit_message", "u", { message_id: "mu" }),
  ]) {
    deliveryModel = applyAction(deliveryModel, nextAction);
  }
  deliveryModel = applyDemoStep(
    deliveryModel,
    "17. 交付接受状态未知：工具失败但节点仍 idle",
    action("delivery_unknown", "u", { message_id: "mu" }),
  );
  const deliveryUnknownObservation = inspectModel(deliveryModel).nodes[0];
  deliveryModel = applyDemoStep(
    deliveryModel,
    "18. 后续 settle 消解未决交付，不把节点置为 failed",
    action("agent_settled", "u"),
  );
  const deliveryResolvedObservation = inspectModel(deliveryModel).nodes[0];

  let cascadeModel = createModel();
  for (const nextAction of [
    { type: "register", agent_id: "r", parent_agent_id: null },
    action("handshake_completed", "r"),
    { type: "register", agent_id: "d", parent_agent_id: "r" },
    action("handshake_completed", "d"),
  ]) {
    cascadeModel = applyAction(cascadeModel, nextAction);
  }
  cascadeModel = applyDemoStep(
    cascadeModel,
    "19. 级联终止在一个 tree_revision 中覆盖 r 与 d",
    action("terminate_subtree", "r"),
  );
  const cascadeBarrierObservation = inspectModel(cascadeModel);
  cascadeModel = applyDemoStep(
    cascadeModel,
    "20. 后代未终止前拒绝确认父节点回收",
    action("resource_reclaimed", "r"),
  );
  const earlyParentReclaimObservation = structuredClone(cascadeModel.last_result);
  cascadeModel = applyDemoStep(
    cascadeModel,
    "21. 先确认后代 d 回收",
    action("resource_reclaimed", "d"),
  );
  cascadeModel = applyDemoStep(
    cascadeModel,
    "22. 再确认父节点 r 回收",
    action("resource_reclaimed", "r"),
  );

  let orphanModel = createModel();
  for (const nextAction of [
    { type: "register", agent_id: "p", parent_agent_id: null },
    action("handshake_completed", "p"),
    { type: "register", agent_id: "c", parent_agent_id: "p" },
    action("handshake_completed", "c"),
    { type: "register", agent_id: "g", parent_agent_id: "c" },
    action("handshake_completed", "g"),
  ]) {
    orphanModel = applyAction(orphanModel, nextAction);
  }
  orphanModel = applyDemoStep(
    orphanModel,
    "23. 中间节点 c 崩溃：c 保持 failed，后代 g 自动 terminating",
    action("runtime_failed", "c", { code: "process_exited" }),
  );
  const orphanObservation = inspectModel(orphanModel).nodes.filter((node) =>
    ["c", "g"].includes(node.agent_id),
  );
  orphanModel = applyDemoStep(
    orphanModel,
    "24. 先确认后代 g 回收",
    action("resource_reclaimed", "g"),
  );
  orphanModel = applyDemoStep(
    orphanModel,
    "25. 直接父显式终止故障节点 c",
    action("terminate_subtree", "c"),
  );
  orphanModel = applyDemoStep(
    orphanModel,
    "26. c 在后代终止后完成回收",
    action("resource_reclaimed", "c"),
  );

  console.log(`\n${BOLD}演示完成${RESET}`);
  console.log(`${DIM}关键观察（由当前模型实际计算）${RESET}`);
  console.log(
    JSON.stringify(
      {
        wait_race: waitRaceObservation,
        late_settle: lateSettleObservation,
        termination_incomplete: incompleteObservation,
        startup_wait: startupWaitObservation,
        delivery_unknown: deliveryUnknownObservation,
        delivery_resolved: deliveryResolvedObservation,
        cascade_barrier: cascadeBarrierObservation,
        early_parent_reclaim: earlyParentReclaimObservation,
        orphan_prevention: orphanObservation,
      },
      null,
      2,
    ),
  );
}

async function runInteractive() {
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY),
  });
  let model = createModel();
  let queryResult = null;

  try {
    render(model, queryResult, stdout.isTTY);
    if (stdin.isTTY) stdout.write("\n> ");

    for await (const line of readline) {
      const parsed = parseCommand(line);
      if (parsed.kind === "quit") break;
      if (parsed.kind === "action") {
        model = applyAction(model, parsed.value);
        queryResult = null;
      } else {
        queryResult = query(model, parsed.value);
      }

      render(model, queryResult, stdout.isTTY);
      if (stdin.isTTY) stdout.write("\n> ");
    }
  } finally {
    readline.close();
  }
}

if (process.argv.includes("--demo")) {
  runDemo();
} else {
  await runInteractive();
}
