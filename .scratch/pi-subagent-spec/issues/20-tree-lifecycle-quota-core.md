# 20 - 建立代理树身份、七态生命周期与配额内核

**What to build:** 让控制器在当前根会话内维护有向代理树的身份、直接父所有权、生命周期事实、资源名额和安全快照，并为所有公开控制调用提供一致裁决。

**Blocked by:** 18 - 冻结根工作基础、环境、信任与配置

**Status:** ready-for-agent

- [ ] 新节点分配不可复用的 canonical UUID v4 `agent_id`，每个节点只有一个直接父；根关闭或会话切换后树不跨根恢复，终止记录仍可查询但不占名额。
- [ ] 只允许 `starting`、`idle`、`working`、`interrupting`、`failed`、`terminating`、`terminated` 七态，并用已接纳意图和已确认事实守卫合法转换及迟到事件。
- [ ] `pending_message_count`、节点 `revision`、UTC `observed_at`、生命周期时间和树修订只在公开事实变化时更新，状态代际不会被旧事件越过。
- [ ] 管理能力按直接父授权、祖先 `subagents` 开关和 `maxDepth` 逐级收窄；直接子代理名额与全树名额在创建前原子预留，只有完整回收后释放。
- [ ] 所有控制调用共享 `{ok,data}` / `{ok:false,error}` 外壳和规范闭集错误码，安全字段不含正文、路径、环境、凭据、句柄或堆栈；状态机、配额和并发预留有纯逻辑测试。（REQ-001..003、REQ-018..024、REQ-032；AC-001、AC-010、AC-011、AC-018）

