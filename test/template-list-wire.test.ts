import assert from "node:assert/strict";
import test from "node:test";
import {
  createRootAuthorityControlHandler,
  RemoteTreeAuthorityPort,
  SupervisorControlClient,
  type SupervisorControlHandler,
  type SupervisorControlLink,
} from "../src/authority-control-router.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "../src/template-discovery-snapshot.ts";
import type { SupervisorControlResponse } from "../src/supervisor-channel.ts";
import type { TreeActor } from "../src/tree-controller.ts";
import { TreeController } from "../src/tree-controller.ts";
import { RootTreeAuthority } from "../src/tree-authority.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeAuthority(excludeTools?: readonly string[]): RootTreeAuthority {
  const template: TemplateDefinition = Object.freeze({
    templateId: "demo",
    source: "user",
    templateDirectory: ".",
    description: "演示模板",
    tools: undefined,
    ...(excludeTools === undefined ? {} : { excludeTools: Object.freeze([...excludeTools]) }),
    extensions: undefined,
    allowSubagents: true,
    contextFiles: false,
    systemPromptMode: "append",
    body: "",
  });
  const snapshot: TemplateDiscoverySnapshot = Object.freeze({
    templates: Object.freeze([template]),
    invalidCandidates: Object.freeze([]),
    sourceDiagnostics: Object.freeze([]),
    resolveTemplate: (templateId: string) => templateId === template.templateId
      ? Object.freeze({ kind: "valid" as const, template })
      : Object.freeze({ kind: "not_found" as const }),
    toJSON: () => ({}),
  });
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
    initialActor: {
      agentId: AGENT_ID,
      parentAgentId: null,
      depth: 1,
      managementEnabled: true,
      templateId: "demo",
      name: "父代理",
    },
  });
  return new RootTreeAuthority({ tree, templateSnapshot: snapshot });
}

/** 单进程控制链：请求直接进入根处理器，响应同步回投给请求器。 */
function directLink(handler: SupervisorControlHandler): SupervisorControlLink {
  const responseListeners = new Set<(response: SupervisorControlResponse) => void>();
  return {
    async publishControlRequest(request) {
      const response = await handler(request);
      for (const listener of [...responseListeners]) listener(response);
    },
    async publishControlResponse() {},
    onControlRequest() {
      return () => {};
    },
    onControlResponse(listener) {
      responseListeners.add(listener);
      return () => responseListeners.delete(listener);
    },
    failProtocol() {},
  };
}

function actor(): TreeActor {
  return Object.freeze({ kind: "agent", agent_id: AGENT_ID });
}

function makeRemoteAuthority(excludeTools?: readonly string[]): {
  readonly remote: RemoteTreeAuthorityPort;
  readonly client: SupervisorControlClient;
} {
  const client = new SupervisorControlClient(
    directLink(createRootAuthorityControlHandler(makeAuthority(excludeTools))),
  );
  return { remote: new RemoteTreeAuthorityPort(AGENT_ID, client), client };
}

test("list_templates 经控制路由保留排除项", async () => {
  const { remote, client } = makeRemoteAuthority(["mcp_*", "future_business_tool"]);
  try {
    const result = await remote.listTemplates(actor());
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.data, [{
      template_id: "demo",
      description: "演示模板",
      exclude_tools: ["mcp_*", "future_business_tool"],
    }]);
  } finally {
    client.close();
  }
});

test("resolve_template 经控制路由保留排除项", async () => {
  const { remote, client } = makeRemoteAuthority(["mcp_*"]);
  try {
    const result = await remote.resolveTemplate(actor(), "demo");
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.data.template.excludeTools, ["mcp_*"]);
  } finally {
    client.close();
  }
});
