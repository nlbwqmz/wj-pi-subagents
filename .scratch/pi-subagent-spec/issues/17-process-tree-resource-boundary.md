# 17 - 预构资源确认边界与可注入进程树替身

**What to build:** 让控制器能够可靠区分子代理整棵进程树已经回收、仍有资源存在和无法确认三种结果，并为后续监督器提供可确定复现的平台边界。

**Blocked by:** 16 - 交付可原子失活的 Pi package 与宿主兼容门禁

**Status:** resolved

- [x] 进程树边界只暴露不透明树句柄和优雅关闭、强制回收、退出等待、资源观察、释放等能力，不把 PID 递归和生命周期裁决泄漏给控制器。
- [x] 资源观察明确区分“确认退出”“仍存在”“无法确认”，发送信号、EOF 或直接进程退出不能单独产生成熟的回收确认。
- [x] 可注入替身能确定复现优雅超时、孙进程残留、部分回收、重复回收和句柄释放，并在每种结果下给出稳定可断言的观察值。
- [x] 纯逻辑测试固定资源确认边界，证明未确认资源不会提前进入 `terminated` 或释放名额。（REQ-039、REQ-041..043；AC-016、AC-021、AC-022）

## Answer

新增 `src/process-tree-resource-boundary.ts`，以独立纯逻辑函数 `decideProcessTreeTermination` 汇总进程退出观察和整树资源观察。只有 `exit: "exited"` 与 `resources: "released"` 同时确认时才返回 `confirmed_exited`、`terminated` 和 `releaseQuotaSlots: true`；任一观察为 `present` 时保持 `terminating`，任一无法确认时保持 `terminating/unknown`，两种未完成结果都不释放名额。适配器只负责平台句柄和观察，不直接修改生命周期或配额。

新增 `src/fake-process-tree-adapter.ts`。`FakeProcessTreeAdapter` 通过 `WeakMap` 保存场景状态并返回不透明令牌，支持按场景确定性推进优雅关闭、强制回收、部分回收重试、孙进程残留、重复强制回收和句柄释放；释放后观察安全地回到 `unknown`，重复释放幂等。它声明 Windows 的 `job_object` 及 macOS/Linux 的 `process_group_or_session` 策略，可直接注入既有 `ProcessTreeAdapter`/宿主门禁契约，但不实现真实平台回收。

测试位于 `test/process-tree-resource-boundary.test.ts` 和 `test/fake-process-tree-adapter.test.ts`，覆盖直接进程退出不足以确认、三态资源观察、优雅超时、孙进程残留、部分回收、重复回收、句柄释放和三平台契约。真实 Job Object 与 process group/session 适配器仍分别属于 22/23 号票据，RPC 监督器接入属于 24 号票据。

## Comments

- 2026-08-05：实现完成并通过专项测试与 `npm run typecheck`；完整检查和双轴代码审查在提交前执行。
