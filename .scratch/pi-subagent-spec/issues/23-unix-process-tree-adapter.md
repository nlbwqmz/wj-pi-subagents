# 23 - 实现 macOS/Linux process group 进程树适配器

**What to build:** 在 macOS 和 Linux 上让每个子代理运行于专用 process group 或 session，并以平台原语可靠观察和回收整棵进程树。

**Blocked by:** 17 - 预构资源确认边界与可注入进程树替身

**Status:** ready-for-human

- [x] 启动阶段建立专用 process group 或 session，再启动子进程，后代属于同一受监督树。
- [x] 优雅关闭、内部期限升级、整树强制回收、退出观察、资源检查和释放遵守统一适配器契约，不以直接子进程 `kill` 代替树回收。
- [ ] macOS/Linux 原生 helper 测试覆盖后代残留、部分回收、重复终止和无法确认结果，并证明平台能力缺失时由兼容门禁拒绝激活。（REQ-006、REQ-041..043；AC-022、AC-029）

## Answer

新增 `src/unix-process-tree-adapter.ts`，实现 `UnixProcessTreeAdapter`。`launch()` 使用 Node POSIX `detached: true` 在启动前建立专用 process group/session，并只返回子进程的 stdin/stdout/stderr；`attach()` 仅接受启动说明，拒绝无法证明已归属专用树的已运行进程。适配器以 `available` 暴露当前宿主能力，非 macOS/Linux 或平台声明不匹配时由宿主门禁拒绝激活。

优雅关闭通过 stdin EOF 完成，期限升级后使用负 PID 的 `SIGKILL` 针对整个 process group；正常回收不调用直接子进程 `kill`，也不向控制器暴露 PID。退出观察由子进程生命周期事件提供，资源观察使用 `kill(-pgid, 0)` 区分 `present`、`released` 和 `unknown`。释放活动句柄时先发送整组回收信号，但句柄随后不可再观察，因此统一报告 `unknown`，重复强制终止和释放保持幂等。启动回滚若仍无法确认资源，则抛出带不透明树句柄和三态清理结果的 `UnixProcessTreeLaunchError`，供监督器继续重试，不丢失未确认树。

宿主门禁默认在 macOS/Linux 加载 Unix 适配器，Windows 继续加载 Job Object，其他平台保持失败关闭。新增 `test/unix-process-tree-adapter.test.ts`，在 Unix runner 上覆盖优雅 EOF、同组孙进程残留、强制整组回收、期限升级、重复终止、活动句柄释放、启动失败、已运行进程拒绝、取消信号和非 Unix 能力拒绝；Windows runner 安全跳过 Unix 原生场景。更新宿主门禁测试确认 Unix 默认入口。

验证：`npm run typecheck` 通过；Windows 当前 runner 的 `npm test` 为 96 个测试通过（5 个 Unix 原生场景按平台跳过）；`git diff --check` 通过。macOS/Linux 原生进程场景尚未在对应 runner 执行，因此票据保留 `ready-for-human`，不把当前结果记为完整 AC-022 证据。

## Comments

- 2026-08-06：完成 Unix process group/session 适配器、宿主门禁接入和原生场景测试，待跨平台 runner 执行最终证据。
