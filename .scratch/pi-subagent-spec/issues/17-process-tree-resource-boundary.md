# 17 - 预构资源确认边界与可注入进程树替身

**What to build:** 让控制器能够可靠区分子代理整棵进程树已经回收、仍有资源存在和无法确认三种结果，并为后续监督器提供可确定复现的平台边界。

**Blocked by:** 16 - 交付可原子失活的 Pi package 与宿主兼容门禁

**Status:** resolved

- [x] 进程树边界只暴露不透明树句柄和优雅关闭、强制回收、退出等待、资源观察、释放等能力，不把 PID 递归和生命周期裁决泄漏给控制器。
- [x] 资源观察明确区分“确认退出”“仍存在”“无法确认”，发送信号、EOF 或直接进程退出不能单独产生成熟的回收确认。
- [x] 可注入替身能确定复现优雅超时、孙进程残留、部分回收、重复回收和句柄释放，并在每种结果下给出稳定可断言的观察值。
- [x] 纯逻辑测试固定资源确认边界，证明未确认资源不会提前进入 `terminated` 或释放名额。（REQ-039、REQ-041..043；AC-016、AC-021、AC-022）

## Answer

新增 `src/process-tree-resource-boundary.ts`，以独立纯逻辑函数 `classifyProcessTreeResources` 汇总进程退出观察和整树资源观察。只有 `exit: "exited"` 与 `resources: "released"` 同时确认时才返回进程树级 `confirmed_exited`；任一观察为 `present` 时返回 `present`，其余未确认组合返回 `unknown`。该边界不输出代理生命周期或配额裁决；后续控制器仍须合并监督端点、本节点和全部后代的确认事实，才能发布 `terminated` 并释放名额。

新增 `src/fake-process-tree-adapter.ts`。`FakeProcessTreeAdapter` 通过 `WeakMap` 保存场景状态并返回不透明令牌，支持按场景确定性推进优雅关闭、强制回收、部分回收重试、孙进程残留、重复强制回收和句柄释放；释放后观察安全地回到 `unknown`，重复释放幂等。它声明 Windows 的 `job_object` 及 macOS/Linux 的 `process_group_or_session` 策略，可直接注入既有 `ProcessTreeAdapter`/宿主门禁契约，但不实现真实平台回收。

测试位于 `test/process-tree-resource-boundary.test.ts` 和 `test/fake-process-tree-adapter.test.ts`，覆盖直接进程退出不足以确认、三态资源观察、优雅等待超时后的强制升级、孙进程残留、部分回收、重复回收、句柄释放和三平台契约。纯逻辑输出明确不含 `lifecycle` 或名额释放信号，未确认进程树不能单独推动控制器成熟。真实 Job Object 与 process group/session 适配器仍分别属于 22/23 号票据，完整 RPC 监督器与控制器接入属于 24/20 号票据。

## Comments

- 2026-08-05：初始实现通过专项测试、类型检查和完整检查后提交，随后以实现前提交为固定点执行双轴代码审查。
- 2026-08-05：双轴审查发现进程树证据不足以单独裁决完整资源确认，已移除边界中的生命周期/配额结果，并补齐优雅期限后强制升级测试。
