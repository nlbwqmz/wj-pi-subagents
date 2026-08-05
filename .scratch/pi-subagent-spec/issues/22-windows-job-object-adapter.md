# 22 - 实现 Windows Job Object 进程树适配器

**What to build:** 在 Windows 上让每个子代理及其后代从启动起受同一 Job Object 监督，并能在优雅关闭失败时一次性回收整棵 OS 进程树。

**Blocked by:** 17 - 预构资源确认边界与可注入进程树替身

**Status:** resolved

- [x] 子进程启动前完成节点专用 Job Object 绑定，后代不会脱离监督范围。
- [x] 优雅请求、清理期限、强制整树终止、退出等待、资源检查和句柄释放均通过不透明适配器完成，控制器不读取 PID 或递归 kill。
- [x] 原生 helper 测试覆盖直接子进程、孙进程、优雅超时、强制回收、仍存在和无法确认三类结果，并确认未确认资源不会被报告为 `terminated`。（REQ-006、REQ-041..042；AC-022）

## Answer

已交付 Windows Job Object 进程树适配器，并接入宿主兼容门禁的标准加载路径。`WindowsJobObjectAdapter.launch()` 为每个节点创建随机命名的控制管道和事件管道；PowerShell helper 内嵌 C#，使用 `CreateProcess(CREATE_SUSPENDED)` 创建目标进程，先创建节点专用 Job Object、设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、分配进程，再恢复线程。返回值只包含目标进程的 stdin/stdout/stderr，不暴露 PID、Job 句柄或其他 native 句柄。

强制清理只通过 `TerminateJobObject` 完成，退出和资源观察由 helper 的 `QueryInformationJobObject(JobObjectBasicProcessIdList)` 分别映射为 `present`、`released` 或 `unknown`；`release()` 在资源未确认时保留 `unknown`，不伪造 `terminated`。启动事务在进程已创建但绑定或恢复失败时直接调用 `TerminateProcess`，避免留下未纳入 Job 的挂起进程。helper 的 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 使用正确的 Windows 原生字段顺序，确保 `KILL_ON_JOB_CLOSE` 实际写入并可生效。

宿主门禁默认在 Windows 加载该适配器；尚未交付 Unix 适配器的平台继续失败关闭。规范审查中提出的孙进程结论已在当前 Windows 环境复跑为通过：`detached`/`unref` 孙进程保持 `present`，强制阶段确认整树 `released` 并清除孙进程。

验证结果：

- `npm run typecheck` 通过。
- `node --experimental-strip-types --test test\windows-job-object-adapter.test.ts`：5/5 通过。
- `node --experimental-strip-types --test test\host-gate.test.ts`：23/23 通过。
- `npm run check`：90/90 测试通过。
- `git diff --check` 通过；诊断过程中未遗留 helper、worker、目标 Node 进程、命名管道或临时文件。
