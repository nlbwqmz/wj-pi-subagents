import assert from "node:assert/strict";
import test from "node:test";
import {
  RootTreeAuthority,
  type SpawnGrant,
} from "../src/tree-authority.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
  type ControlResult,
} from "../src/tree-controller.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "../src/template-discovery-snapshot.ts";

const FIRST_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ID = "10000000-0000-4000-8000-000000000002";

function template(
  templateId = "worker",
  subagents: TemplateDefinition["subagents"] = "inherit",
  body = "初始模板正文",
): TemplateDefinition {
  return Object.freeze({
    templateId,
    source: "project" as const,
    tools: Object.freeze(["read"]),
    subagents,
    contextFiles: "enabled" as const,
    systemPromptMode: "append" as const,
    body,
  });
}

function snapshot(...templates: readonly TemplateDefinition[]): TemplateDiscoverySnapshot {
  const byId = new Map(templates.map((item) => [item.templateId, item]));
  return Object.freeze({
    templates: Object.freeze([...templates]),
    invalidCandidates: Object.freeze([]),
    sourceDiagnostics: Object.freeze([]),
    resolveTemplate: (templateId: string) => {
      const item = byId.get(templateId);
      return item === undefined
        ? Object.freeze({ kind: "not_found" as const })
        : Object.freeze({ kind: "valid" as const, template: item });
    },
    toJSON: () => ({}),
  });
}

function expectSuccess<T>(result: ControlResult<T>): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("预期控制成功");
  return result.data;
}

function expectFailure<T>(result: ControlResult<T>, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
}

test("根权威以模板修订闭合解析与预留事务", async () => {
  const ids = [FIRST_ID, SECOND_ID];
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 2, maxAgentsPerTree: 2, waitTimeoutMs: 10_000 },
    idFactory: () => ids.shift() ?? SECOND_ID,
  });
  const authority = new RootTreeAuthority({ tree, templateSnapshot: snapshot(template()) });

  const resolved = expectSuccess(await authority.resolveTemplate(ROOT_TREE_ACTOR, "worker"));
  assert.equal(resolved.template_revision, 1);
  assert.equal(resolved.template.body, "初始模板正文");
  assert.equal(Object.isFrozen(resolved.template), true);

  authority.updateTemplateSnapshot(snapshot(template("worker", "inherit", "reload 后正文")));
  expectFailure(await authority.reserveChild(ROOT_TREE_ACTOR, {
    template_id: "worker",
    template_revision: resolved.template_revision,
    name: "过期创建",
  }), "template_invalid");
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 0);

  const current = expectSuccess(await authority.resolveTemplate(ROOT_TREE_ACTOR, "worker"));
  const grant = expectSuccess(await authority.reserveChild(ROOT_TREE_ACTOR, {
    template_id: "worker",
    template_revision: current.template_revision,
    name: "当前创建",
  }));
  assert.equal(grant.node.agent_id, FIRST_ID);
  assert.equal(grant.node.state, "starting");
  assert.equal(grant.template_revision, 2);
  assert.equal(grant.management_enabled, true);
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 1);
});

test("两个父并发争抢最后一个全树名额时根权威只签发一个 grant", async () => {
  const ids = [FIRST_ID, SECOND_ID];
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 2, maxAgentsPerTree: 1, waitTimeoutMs: 10_000 },
    idFactory: () => ids.shift() ?? SECOND_ID,
  });
  const authority = new RootTreeAuthority({ tree, templateSnapshot: snapshot(template()) });
  const revision = (expectSuccess(await authority.resolveTemplate(ROOT_TREE_ACTOR, "worker"))).template_revision;

  const outcomes = await Promise.all([
    authority.reserveChild(ROOT_TREE_ACTOR, {
      template_id: "worker",
      template_revision: revision,
      name: "竞争者一",
    }),
    authority.reserveChild(ROOT_TREE_ACTOR, {
      template_id: "worker",
      template_revision: revision,
      name: "竞争者二",
    }),
  ]);
  const successes = outcomes.filter((item): item is { readonly ok: true; readonly data: SpawnGrant } => item.ok);
  const failures = outcomes.filter((item) => !item.ok);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  expectFailure(failures[0]!, "max_tree_agents_reached");
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 1);
});

test("控制准入、终止屏障与资源确认都重复校验直接父关系", async () => {
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 2, maxAgentsPerTree: 2, waitTimeoutMs: 10_000 },
    idFactory: () => FIRST_ID,
  });
  const authority = new RootTreeAuthority({ tree, templateSnapshot: snapshot(template()) });
  const revision = (expectSuccess(await authority.resolveTemplate(ROOT_TREE_ACTOR, "worker"))).template_revision;
  const grant = expectSuccess(await authority.reserveChild(ROOT_TREE_ACTOR, {
    template_id: "worker",
    template_revision: revision,
    name: "受控节点",
  }));

  expectFailure(await authority.admitControl(ROOT_TREE_ACTOR, grant.node.agent_id, "send_message"), "agent_unavailable");
  expectSuccess(tree.applyLifecycleEvent(grant.node.agent_id, {
    type: "startup_ready",
    expected_generation: grant.lifecycle_generation,
  }));
  const admitted = expectSuccess(await authority.admitControl(
    ROOT_TREE_ACTOR,
    grant.node.agent_id,
    "send_message",
  ));
  assert.equal(admitted.node.state, "idle");

  const barrier = expectSuccess(await authority.beginTermination(ROOT_TREE_ACTOR, grant.node.agent_id));
  assert.deepEqual(barrier.agent_ids, [grant.node.agent_id]);
  const confirmed = expectSuccess(await authority.confirmResources(ROOT_TREE_ACTOR, grant.node.agent_id));
  assert.equal(confirmed.node.state, "terminated");

  const foreignActor = Object.freeze({ kind: "agent" as const, agent_id: grant.node.agent_id });
  expectFailure(await authority.confirmResources(foreignActor, grant.node.agent_id), "not_direct_child");
});

test("根权威以单一树修订原子确认级联屏障的全部成员", async () => {
  const ids = [
    "10000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000012",
    "10000000-0000-4000-8000-000000000013",
  ];
  const tree = new TreeController({
    config: { maxDepth: 3, maxChildrenPerAgent: 3, maxAgentsPerTree: 6, waitTimeoutMs: 10_000 },
    idFactory: () => ids.shift() ?? SECOND_ID,
  });
  const authority = new RootTreeAuthority({ tree, templateSnapshot: snapshot(template()) });
  const templateRevision = (expectSuccess(await authority.resolveTemplate(ROOT_TREE_ACTOR, "worker"))).template_revision;
  const reserveReady = async (
    actor: typeof ROOT_TREE_ACTOR | { readonly kind: "agent"; readonly agent_id: string },
    name: string,
  ): Promise<SpawnGrant> => {
    const grant = expectSuccess(await authority.reserveChild(actor, {
      template_id: "worker",
      template_revision: templateRevision,
      name,
    }));
    expectSuccess(tree.applyLifecycleEvent(grant.node.agent_id, {
      type: "startup_ready",
      expected_generation: grant.lifecycle_generation,
    }));
    return grant;
  };
  const parent = await reserveReady(ROOT_TREE_ACTOR, "父代理");
  const child = await reserveReady({ kind: "agent", agent_id: parent.node.agent_id }, "子代理");
  const grandchild = await reserveReady({ kind: "agent", agent_id: child.node.agent_id }, "孙代理");
  expectSuccess(await authority.beginTermination(ROOT_TREE_ACTOR, parent.node.agent_id));

  const before = expectSuccess(tree.getTreeSnapshot()).tree_revision;
  const visibleRevisions: number[] = [];
  const unsubscribe = tree.onChange(() => {
    visibleRevisions.push(expectSuccess(tree.getTreeSnapshot()).tree_revision);
  });
  const confirmed = expectSuccess(await authority.confirmResources(ROOT_TREE_ACTOR, parent.node.agent_id));
  unsubscribe();

  assert.equal(confirmed.node.state, "terminated");
  assert.deepEqual(visibleRevisions, [before + 1]);
  assert.deepEqual(
    expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => [
      node.agent_id,
      node.state,
      node.termination_result,
    ]),
    [
      [parent.node.agent_id, "terminated", "completed"],
      [child.node.agent_id, "terminated", "completed"],
      [grandchild.node.agent_id, "terminated", "completed"],
    ],
  );
});
