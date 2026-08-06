# 27 - 完成 Windows 本地 package 与开发验收

Type: task

**What to build:** 在功能与 TUI 闭合后，以隔离临时目录验证本地 Pi package 的装配形态，并在 Windows 的最低/当前两个宿主组合中完成核心旅程、负向安全矩阵、资源清理和可复核证据。

Blocked by: 26 - 交付代理树 TUI 可观测性

Status: ready-for-agent

- [ ] 验证 package manifest 只有一个显式扩展入口，生产依赖在 `npm install --omit=dev` 或等价装配后完整；Pi 临时加载、本地用户 scope 持久安装和已信任项目 scope 形态均可运行，未信任项目不能绕过 project trust。（REQ-004..005、REQ-052；AC-003、AC-027）
- [ ] 在隔离临时目录执行安装/加载，不创建或修改模板、`subagent.json`、Pi 用户/项目设置；测试结束清理临时目录、桥接进程、Pi 子进程、监督通道、Job Object 和所有平台句柄，清理失败即验收失败。（REQ-052；AC-027）
- [ ] Windows 最低组合 Node `22.19.0` + Pi `0.83.0` 与验收时锁定的当前组合各运行一套核心旅程：创建、复用、steering、递归深度、作用域、兄弟并行、中断、级联终止、名额释放和成功 reload。（REQ-048、REQ-050；AC-028）
- [ ] 在 Windows 覆盖五层自动化测试和公开错误码/负向/安全 canary 矩阵，证明桥接进程与 Pi RPC 子进程同属 Job Object，且终止、根关闭和 reload 失败后无存活被监督后代；不设置性能门槛。（REQ-049、REQ-051、REQ-053；AC-018、AC-022、AC-026、AC-030）
- [ ] 记录源码 commit、精确 Windows/Node/Pi 版本、AC 映射、逐项结果、资源清理和脱敏日志/UI 快照。macOS/Linux 原生场景必须单独列为延期，不以 skip、mock 或自动重试伪装通过；后续另立跨平台验收计划。（REQ-054；AC-031）

## Comments

<!-- 追加实现与审查记录。 -->
