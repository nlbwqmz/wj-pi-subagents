# 20 - 建立代理树身份、七态生命周期与配额内核

**What to build:** 让控制器在当前根会话内维护有向代理树的身份、直接父所有权、生命周期事实、资源名额和安全快照，并为所有公开控制调用提供一致裁决。

**Blocked by:** 18 - 冻结根工作基础、环境、信任与配置

**Status:** resolved

- [x] 新节点分配不可复用的 canonical UUID v4 `agent_id`，每个节点只有一个直接父；根关闭或会话切换后树不跨根恢复，终止记录仍可查询但不占名额。
- [x] 只允许 `starting`、`idle`、`working`、`interrupting`、`failed`、`terminating`、`terminated` 七态，并用已接纳意图和已确认事实守卫合法转换及迟到事件。
- [x] `pending_message_count`、节点 `revision`、UTC `observed_at`、生命周期时间和树修订只在公开事实变化时更新，状态代际不会被旧事件越过。
- [x] 管理能力按直接父授权、祖先 `subagents` 开关和 `maxDepth` 逐级收窄；直接子代理名额与全树名额在创建前原子预留，只有完整回收后释放。
- [x] 所有控制调用共享 `{ok,data}` / `{ok:false,error}` 外壳和规范闭集错误码，安全字段不含正文、路径、环境、凭据、句柄或堆栈；状态机、配额和并发预留有纯逻辑测试。（REQ-001..003、REQ-018..024、REQ-032；AC-001、AC-010、AC-011、AC-018）

## Answer

已在 `src/tree-controller.ts` 交付 `TreeController`（并保留 `AgentTreeController` 兼容别名），在当前根实例内统一维护节点身份、直接父关系、生命周期事实、配额和安全快照。新身份使用 canonical 小写 UUID v4 且不会复用；终止记录保留查询但不再占用名额。管理能力按父能力、模板 `subagents` 开关和 `maxDepth` 只能收窄，直接子代理与全树名额在登记前同步预留，只有后代及本节点资源确认后进入 `terminated` 才释放。

生命周期严格限定七态。监督事件必须携带 `expected_generation`；代际随生命周期状态转换推进，pending 事件在节点顺序域内串行处理，迟到或越过终止屏障的事件只返回无变化结果。`pending_message_count`、节点 `revision`、UTC 毫秒 `observed_at` 与 `tree_revision` 仅在可见事实变化时递增；正常时长从 `starting -> idle` 线性化点按单调时钟计算，`failed` 快照冻结，进入 `terminating` 后继续累计清理时长，`terminated` 再次冻结。启动失败在同一顺序域记录 `failed` 后立即建立 `terminating` 屏障，监督器只需继续提交资源确认；控制器不会在未确认时提前释放，实际进程树回收由后续监督器/平台适配工单负责。

所有控制结果使用统一成功/失败外壳，错误码来自规范闭集并使用固定脱敏消息；节点和树快照不含正文、路径、环境、凭据、句柄或堆栈。纯逻辑测试位于 `test/tree-controller.test.ts`，覆盖身份分配、配额、能力衰减、七态转换、强制代际、启动失败清理路径、计时冻结/恢复、终止屏障和安全错误。

验证：`npm run check` 通过，全部 73 项测试通过；`git diff --check` 通过。实现提交为 `5719226`，后续代际、计时与启动失败清理修正提交为 `cadba87`、`ed6fa7b`、`ce52f9c`。Standards/Spec 双轴审查已完成；查询按直接父/子树裁剪和根关闭级联清理分别留给工单 28、29、30 的纵向边界。
