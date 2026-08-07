// THROWAWAY PROTOTYPE：只用于验证 Pi 子代理生命周期决策，不是生产实现。

export const STATES = Object.freeze([
  "starting",
  "idle",
  "working",
  "interrupting",
  "failed",
  "terminating",
  "terminated",
]);

const BASE_TIME_MS = Date.parse("2026-08-04T00:00:00.000Z");
const SENDABLE_STATES = new Set(["idle", "working", "interrupting"]);
const WAIT_TERMINAL_STATES = new Set(["failed", "terminated"]);

export function createModel() {
  return {
    clock: 0,
    tree_revision: 0,
    next_creation_order: 1,
    nodes: [],
    waiters: [],
    trace: [],
    last_result: null,
  };
}

function cloneModel(model) {
  return structuredClone(model);
}

function getNode(model, agentId) {
  return model.nodes.find((node) => node.agent_id === agentId);
}

function pendingCount(node) {
  return node.pending_messages.length;
}

function publicSignature(node) {
  return JSON.stringify({
    state: node.state,
    pending_message_count: pendingCount(node),
    error: node.error,
  });
}

function publicFields(node) {
  const result = {
    agent_id: node.agent_id,
    parent_agent_id: node.parent_agent_id,
    state: node.state,
    pending_message_count: pendingCount(node),
    revision: node.revision,
  };

  if (node.error) {
    result.error = structuredClone(node.error);
  }

  return result;
}

function makeError(code, message, retryable = false) {
  return { code, message, retryable, at: null };
}

function setLastResult(model, action, result) {
  model.last_result = {
    action: structuredClone(action),
    ...result,
  };
}

function mutateVisible(model, nodes, actionType, mutate) {
  const candidates = [...new Set(nodes)].filter(Boolean);
  const before = new Map(
    candidates.map((node) => [
      node.agent_id,
      {
        signature: publicSignature(node),
        state: node.state,
        pending_message_count: pendingCount(node),
        error_code: node.error?.code ?? null,
      },
    ]),
  );

  for (const node of candidates) {
    mutate(node);
  }

  const changed = candidates.filter(
    (node) => before.get(node.agent_id).signature !== publicSignature(node),
  );

  if (changed.length === 0) {
    return [];
  }

  const treeRevision = model.tree_revision + 1;
  for (const node of changed) {
    model.clock += 1;
    node.revision += 1;
    if (node.error?.at === null) {
      node.error.at = new Date(BASE_TIME_MS + model.clock).toISOString();
    }

    const previous = before.get(node.agent_id);
    model.trace.push({
      tree_revision: treeRevision,
      action: actionType,
      agent_id: node.agent_id,
      from_state: previous.state,
      to_state: node.state,
      from_pending: previous.pending_message_count,
      to_pending: pendingCount(node),
      from_error: previous.error_code,
      to_error: node.error?.code ?? null,
      node_revision: node.revision,
    });
  }

  model.tree_revision = treeRevision;
  return changed.map((node) => node.agent_id);
}

function subtreeNodes(model, agentId) {
  const result = [];
  const queue = [agentId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const current = getNode(model, currentId);
    if (!current) continue;
    result.push(current);

    for (const child of model.nodes) {
      if (child.parent_agent_id === currentId) {
        queue.push(child.agent_id);
      }
    }
  }

  return result;
}

function descendantNodes(model, agentId) {
  return subtreeNodes(model, agentId).filter(
    (node) => node.agent_id !== agentId,
  );
}

function completeWaiters(model, agentId, outcome) {
  for (const waiter of model.waiters) {
    if (waiter.agent_id === agentId && waiter.status === "waiting") {
      waiter.status = "completed";
      waiter.outcome = outcome;
      waiter.triggered_at_tree_revision = model.tree_revision;
    }
  }
}

function registerNode(model, action) {
  if (!action.agent_id || getNode(model, action.agent_id)) {
    setLastResult(model, action, {
      ok: false,
      error: "agent_id_missing_or_duplicate",
    });
    return;
  }

  if (action.parent_agent_id) {
    const parent = getNode(model, action.parent_agent_id);
    if (!parent) {
      setLastResult(model, action, { ok: false, error: "parent_not_found" });
      return;
    }
    if (
      parent.termination_barrier ||
      ["failed", "terminating", "terminated"].includes(parent.state)
    ) {
      setLastResult(model, action, {
        ok: false,
        error: "parent_unavailable",
      });
      return;
    }
  }

  model.clock += 1;
  model.tree_revision += 1;
  const node = {
    agent_id: action.agent_id,
    parent_agent_id: action.parent_agent_id ?? null,
    creation_order: model.next_creation_order++,
    state: "starting",
    revision: 1,
    pending_messages: [],
    active_message_id: null,
    error: null,
    termination_barrier: false,
  };
  model.nodes.push(node);
  model.trace.push({
    tree_revision: model.tree_revision,
    action: action.type,
    agent_id: node.agent_id,
    from_state: null,
    to_state: "starting",
    from_pending: 0,
    to_pending: 0,
    from_error: null,
    to_error: null,
    node_revision: 1,
  });
  setLastResult(model, action, { ok: true, state: "starting" });
}

export function inspectModel(model) {
  return {
    tree_revision: model.tree_revision,
    nodes: [...model.nodes]
      .sort((left, right) => left.creation_order - right.creation_order)
      .map((node) => ({
        ...publicFields(node),
        termination_barrier: node.termination_barrier,
        active_message_id: node.active_message_id,
        pending_messages: structuredClone(node.pending_messages),
      })),
    waiters: model.waiters.map((waiter) => ({ ...waiter })),
    last_result: model.last_result,
  };
}

export function getWaitResult(model, waitId) {
  const waiter = model.waiters.find((candidate) => candidate.wait_id === waitId);
  if (!waiter) {
    return { ok: false, error: "waiter_not_found" };
  }

  const node = getNode(model, waiter.agent_id);
  if (!node) {
    return { ok: false, error: "agent_not_found" };
  }

  if (waiter.status === "waiting") {
    return { ok: true, status: "waiting", agent_id: node.agent_id };
  }

  return {
    ok: true,
    status: "completed",
    outcome: waiter.outcome,
    ...publicFields(node),
  };
}

export function getOperationMatrix(model, agentId) {
  const node = getNode(model, agentId);
  if (!node) return { ok: false, error: "agent_not_found" };

  return {
    ok: true,
    state: node.state,
    send_message: SENDABLE_STATES.has(node.state)
      ? "allowed"
      : "agent_unavailable",
    wait_agent: "allowed",
    interrupt_agent:
      node.state === "starting"
        ? "agent_unavailable"
        : node.state === "working"
          ? "changes_to_interrupting"
          : "idempotent_no_change",
    terminate_agent:
      node.state === "terminated"
        ? "idempotent_no_change"
        : node.state === "terminating"
          ? "join_existing_termination"
          : "changes_to_terminating",
    query: "allowed",
  };
}

function actionNode(model, action) {
  const node = getNode(model, action.agent_id);
  if (!node) {
    setLastResult(model, action, { ok: false, error: "agent_not_found" });
    return null;
  }
  return node;
}

function handshakeCompleted(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (node.state !== "starting") {
    setLastResult(model, action, { ok: false, error: "incompatible_state" });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.state = "idle";
    current.error = null;
  });
  completeWaiters(model, node.agent_id, "settled");
  setLastResult(model, action, { ok: true, state: node.state });
}

function admitMessage(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (!SENDABLE_STATES.has(node.state)) {
    setLastResult(model, action, { ok: false, error: "agent_unavailable" });
    return;
  }
  if (
    !action.message_id ||
    node.pending_messages.some((message) => message.message_id === action.message_id) ||
    node.active_message_id === action.message_id
  ) {
    setLastResult(model, action, {
      ok: false,
      error: "message_id_missing_or_duplicate",
    });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.pending_messages.push({
      message_id: action.message_id,
      stage: "controller",
    });
  });
  setLastResult(model, action, {
    ok: true,
    admitted: true,
    pending_message_count: pendingCount(node),
  });
}

function acceptMessage(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (!SENDABLE_STATES.has(node.state)) {
    setLastResult(model, action, { ok: false, error: "agent_unavailable" });
    return;
  }

  const message = node.pending_messages.find(
    (candidate) => candidate.message_id === action.message_id,
  );
  if (!message) {
    setLastResult(model, action, { ok: false, error: "message_not_found" });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    const currentMessage = current.pending_messages.find(
      (candidate) => candidate.message_id === action.message_id,
    );
    if (current.state === "idle") {
      current.pending_messages = current.pending_messages.filter(
        (candidate) => candidate.message_id !== action.message_id,
      );
      current.active_message_id = action.message_id;
      current.state = "working";
      return;
    }
    currentMessage.stage = "pi";
  });

  setLastResult(model, action, {
    ok: true,
    accepted: true,
    state: node.state,
    pending_message_count: pendingCount(node),
  });
}

function messageStarted(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (!SENDABLE_STATES.has(node.state)) {
    setLastResult(model, action, { ok: false, error: "ignored_stale_event" });
    return;
  }

  const message = node.pending_messages.find(
    (candidate) => candidate.message_id === action.message_id,
  );
  if (!message) {
    setLastResult(model, action, { ok: false, error: "message_not_found" });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.pending_messages = current.pending_messages.filter(
      (candidate) => candidate.message_id !== action.message_id,
    );
    current.active_message_id = action.message_id;
    if (current.state === "idle") {
      current.state = "working";
    }
  });
  setLastResult(model, action, { ok: true, state: node.state });
}

function deliveryFailed(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  const exists = node.pending_messages.some(
    (message) => message.message_id === action.message_id,
  );
  if (!exists) {
    setLastResult(model, action, { ok: false, error: "message_not_found" });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.pending_messages = current.pending_messages.filter(
      (message) => message.message_id !== action.message_id,
    );
  });
  setLastResult(model, action, {
    ok: false,
    error: "message_delivery_failed",
    retryable: action.retryable ?? true,
    state: node.state,
  });
}

function deliveryUnknown(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  const message = node.pending_messages.find(
    (candidate) => candidate.message_id === action.message_id,
  );
  if (!message) {
    setLastResult(model, action, { ok: false, error: "message_not_found" });
    return;
  }

  message.stage = "unknown";
  setLastResult(model, action, {
    ok: false,
    error: "message_delivery_failed",
    retryable: false,
    acceptance: "unknown",
    state: node.state,
  });
}

function interruptRequested(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (node.state === "starting") {
    setLastResult(model, action, { ok: false, error: "agent_unavailable" });
    return;
  }

  if (node.state === "working") {
    mutateVisible(model, [node], action.type, (current) => {
      current.state = "interrupting";
    });
    setLastResult(model, action, {
      ok: true,
      accepted: true,
      changed: true,
      state: node.state,
    });
    return;
  }

  setLastResult(model, action, {
    ok: true,
    accepted: true,
    changed: false,
    state: node.state,
  });
}

function settledEvent(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (node.state === "idle") {
    const unresolvedCount = node.pending_messages.filter(
      (message) => message.stage !== "controller",
    ).length;
    if (unresolvedCount > 0) {
      mutateVisible(model, [node], action.type, (current) => {
        current.pending_messages = current.pending_messages.filter(
          (message) => message.stage === "controller",
        );
      });
      setLastResult(model, action, {
        ok: true,
        changed: true,
        resolved_uncertain_messages: unresolvedCount,
        state: node.state,
      });
      return;
    }
  }
  if (!["working", "interrupting"].includes(node.state)) {
    setLastResult(model, action, {
      ok: true,
      changed: false,
      ignored: "stale_or_incompatible_event",
      state: node.state,
    });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.state = "idle";
    current.active_message_id = null;
    current.pending_messages = current.pending_messages.filter(
      (message) => message.stage === "controller",
    );
    current.error = null;
  });
  completeWaiters(model, node.agent_id, "settled");
  setLastResult(model, action, { ok: true, changed: true, state: node.state });
}

function passiveEvent(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  setLastResult(model, action, {
    ok: true,
    changed: false,
    state: node.state,
    note: "该事件不能独立推进生命周期",
  });
}

function runtimeFailed(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (["terminating", "terminated"].includes(node.state)) {
    setLastResult(model, action, {
      ok: true,
      changed: false,
      ignored: "termination_precedence",
      state: node.state,
    });
    return;
  }
  if (node.state === "failed") {
    setLastResult(model, action, {
      ok: true,
      changed: false,
      state: node.state,
    });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.state = "failed";
    current.pending_messages = [];
    current.active_message_id = null;
    current.error = makeError(
      action.code ?? "rpc_unavailable",
      action.message ?? "RPC 或进程已无法继续可信使用",
      false,
    );
  });
  completeWaiters(model, node.agent_id, "terminal");

  const descendants = descendantNodes(model, node.agent_id).filter(
    (candidate) => candidate.state !== "terminated",
  );
  mutateVisible(model, descendants, "orphan_prevention_termination", (current) => {
    current.state = "terminating";
    current.termination_barrier = true;
    current.pending_messages = current.pending_messages.filter(
      (message) => message.stage !== "controller",
    );
    current.error = null;
  });

  setLastResult(model, action, {
    ok: true,
    state: node.state,
    orphan_descendants_terminating: descendants.length,
  });
}

function startupFailed(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (node.state !== "starting") {
    setLastResult(model, action, { ok: false, error: "incompatible_state" });
    return;
  }

  const errorCode = action.code ?? "spawn_failed";
  mutateVisible(model, [node], action.type, (current) => {
    current.state = "failed";
    current.pending_messages = [];
    current.error = makeError(
      errorCode,
      action.message ?? "启动或 RPC 握手失败",
      errorCode === "spawn_timeout",
    );
  });
  completeWaiters(model, node.agent_id, "terminal");

  mutateVisible(model, [node], "automatic_startup_cleanup", (current) => {
    current.state = "terminating";
    current.termination_barrier = true;
    current.error = null;
  });
  setLastResult(model, action, {
    ok: false,
    error: errorCode,
    cleanup_state: node.state,
  });
}

function terminateSubtree(model, action) {
  const target = actionNode(model, action);
  if (!target) return;
  const subtree = subtreeNodes(model, target.agent_id);

  const changed = mutateVisible(model, subtree, action.type, (current) => {
    if (current.state === "terminated") return;
    current.state = "terminating";
    current.termination_barrier = true;
    current.pending_messages = current.pending_messages.filter(
      (message) => message.stage !== "controller",
    );
    current.error = null;
  });

  setLastResult(model, action, {
    ok: true,
    changed: changed.length > 0,
    affected_nodes: changed,
    state: target.state,
  });
}

function terminationIncomplete(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (node.state !== "terminating") {
    setLastResult(model, action, { ok: false, error: "incompatible_state" });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.error = makeError(
      "termination_incomplete",
      action.message ?? "仍有资源无法确认退出",
      true,
    );
  });
  setLastResult(model, action, {
    ok: false,
    error: "termination_incomplete",
    retryable: true,
    state: node.state,
  });
}

function resourceReclaimed(model, action) {
  const node = actionNode(model, action);
  if (!node) return;
  if (node.state !== "terminating") {
    setLastResult(model, action, { ok: false, error: "incompatible_state" });
    return;
  }

  const unfinishedDescendants = descendantNodes(model, node.agent_id).filter(
    (candidate) => candidate.state !== "terminated",
  );
  if (unfinishedDescendants.length > 0) {
    setLastResult(model, action, {
      ok: false,
      error: "descendants_not_terminated",
      descendants: unfinishedDescendants.map((candidate) => candidate.agent_id),
    });
    return;
  }

  mutateVisible(model, [node], action.type, (current) => {
    current.state = "terminated";
    current.pending_messages = [];
    current.active_message_id = null;
    current.error = null;
    current.termination_barrier = true;
  });
  completeWaiters(model, node.agent_id, "terminal");
  setLastResult(model, action, { ok: true, state: node.state });
}

function startWait(model, action) {
  if (!action.wait_id || model.waiters.some((waiter) => waiter.wait_id === action.wait_id)) {
    setLastResult(model, action, {
      ok: false,
      error: "wait_id_missing_or_duplicate",
    });
    return;
  }
  const node = actionNode(model, action);
  if (!node) return;

  let outcome = null;
  if (node.state === "idle") outcome = "settled";
  if (WAIT_TERMINAL_STATES.has(node.state)) outcome = "terminal";

  model.waiters.push({
    wait_id: action.wait_id,
    agent_id: node.agent_id,
    status: outcome ? "completed" : "waiting",
    outcome,
    triggered_at_tree_revision: outcome ? model.tree_revision : null,
  });
  setLastResult(model, action, {
    ok: true,
    wait: getWaitResult(model, action.wait_id),
  });
}

function timeoutWait(model, action) {
  const waiter = model.waiters.find((candidate) => candidate.wait_id === action.wait_id);
  if (!waiter) {
    setLastResult(model, action, { ok: false, error: "waiter_not_found" });
    return;
  }
  if (waiter.status === "waiting") {
    waiter.status = "completed";
    waiter.outcome = "timeout";
    waiter.triggered_at_tree_revision = model.tree_revision;
  }
  setLastResult(model, action, {
    ok: true,
    wait: getWaitResult(model, action.wait_id),
  });
}

export function applyAction(currentModel, action) {
  const model = cloneModel(currentModel);
  model.last_result = null;

  switch (action.type) {
    case "register":
      registerNode(model, action);
      break;
    case "handshake_completed":
      handshakeCompleted(model, action);
      break;
    case "admit_message":
      admitMessage(model, action);
      break;
    case "accept_message":
      acceptMessage(model, action);
      break;
    case "message_started":
      messageStarted(model, action);
      break;
    case "delivery_failed":
      deliveryFailed(model, action);
      break;
    case "delivery_unknown":
      deliveryUnknown(model, action);
      break;
    case "interrupt_requested":
      interruptRequested(model, action);
      break;
    case "agent_settled":
      settledEvent(model, action);
      break;
    case "agent_end":
    case "abort_ack":
      passiveEvent(model, action);
      break;
    case "runtime_failed":
      runtimeFailed(model, action);
      break;
    case "startup_failed":
      startupFailed(model, action);
      break;
    case "terminate_subtree":
      terminateSubtree(model, action);
      break;
    case "termination_incomplete":
      terminationIncomplete(model, action);
      break;
    case "resource_reclaimed":
      resourceReclaimed(model, action);
      break;
    case "wait_start":
      startWait(model, action);
      break;
    case "wait_timeout":
      timeoutWait(model, action);
      break;
    default:
      setLastResult(model, action, { ok: false, error: "unknown_action" });
  }

  return model;
}
