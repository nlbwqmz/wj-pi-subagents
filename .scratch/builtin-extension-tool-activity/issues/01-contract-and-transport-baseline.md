# 01 — 契约与传输基线

**What to build:** 为内置扩展工具活动适配铺好基础——监督通道单字符串上限从 16 KB 提升到 64 KB，使活动帧能承载后续切片引入的 32 KB 字段；规范活动契约版本与监督协议版本同步递增（`wj-pi-subagents.activity/13` 与 `wj-pi-subagents/31`），旧版本仍按既有兼容性边界处理。完成后：64 KB 以内的单字符串可跨端发布/接收，超过 64 KB 仍按 `frame_too_large` 拒绝；版本不一致的父子仍互不认领；全量测试通过，且不引入任何新的活动条目字段或显示行为。

**Blocked by:** None — 可立即开始

**Status:** resolved

- [x] 监督通道的帧校验接受 64 KB 以内的单字符串（含 32 KB 边界值），超过 64 KB 仍按 `frame_too_large` 拒绝
- [x] 帧总大小上限（512 KB）与 JSON 条目数上限保持不变
- [x] 规范活动契约版本常量递增为 `wj-pi-subagents.activity/13`，监督协议版本常量递增为 `wj-pi-subagents/31`
- [x] 既有测试中所有版本断言同步更新，全量 `npm run check` 通过
- [x] 版本不一致（旧契约或旧协议）仍按既有兼容性边界处理：不认领、不转换、不迁移，旧版本条目按协议故障处理
- [x] 不新增任何活动条目字段、来源类别或面板显示行为（本票只做基线与机械更新）

## Answer

只做契约与传输基线，未引入任何新的活动条目字段、来源类别或面板显示行为。

- **传输上限**（`src/supervisor-channel.ts`）：`SUPERVISOR_CHANNEL_LIMITS.maxStringBytes` 16 KB → 64 KB；`maxFrameBytes`（512 KB）与 `maxJsonEntries`（512）保持不变。超过 64 KB 的单字符串仍在帧解析路径按 `frame_too_large` 拒绝。
- **版本递增**：`CANONICAL_ACTIVITY_CONTRACT_VERSION` → `wj-pi-subagents.activity/13`（`src/canonical-activity.ts`）；`SUPERVISOR_PROTOCOL_VERSION` → `wj-pi-subagents/31`（`src/supervisor-channel.ts`）。三处既有硬编码版本断言同步更新（`test/canonical-activity.test.ts`、`test/agent-display-drafts.test.ts`、`test/conversation-transport.test.ts`）。
- **兼容性边界不变**：发布端拒绝旧契约条目、接收端把旧版本条目升级为协议故障；旧协议帧按 `protocol_mismatch` 拒绝；不认领、不转换、不迁移。
- **验证**：新增用例（`test/agent-activity-channel.test.ts`）证明 32 KB 与 64 KB 单字符串可经发布/接收与 JSON wire 往返，64 KB+1 在接收端按 `frame_too_large` 拒绝；`npm run check`（`tsc --noEmit` + 全量测试）通过：563 pass / 0 fail / 5 skipped。
- **代码审查**：Standards 轴 1 项文档化口径冲突（契约版本递增触发条件注释）与若干判断项，已修正注释、统一常量注释口径并强化用例（JSON wire 往返、去掉无用中间帧）；Spec 轴无缺失、无 scope creep、无实现错误。
