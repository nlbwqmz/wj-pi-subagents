# 27 - 完成 Windows 本地 package 与开发验收

Type: task

**What to build:** 本批次不再由代理执行 Windows 真实系统环境下的本地 Pi package 与开发验收；相关测试由人工依据规格完成，本工单不保留对应代理任务项。

Blocked by: 26 - 交付代理树 TUI 可观测性

Status: ready-for-human

## Comments

<!-- 追加实现与审查记录。 -->

- 2026-08-06：按用户确认的批次范围，删除本工单中全部依赖真实 Windows、Node/Pi 宿主组合、package 安装和进程资源环境的测试与证据任务；这些真实环境验收改由人工完成。
- 2026-08-07：本轮在 Windows 10、Node 22.21.1 环境执行 `npm test`，259 个用例中 254 个通过，5 个 Unix 原生用例按平台范围跳过；Windows Job Object 回归覆盖默认编译 bridge 与 40 KiB 模板提示文件路径。执行 `npm run pack:smoke` 成功，当前 tarball 已重新安装至 `package-smoke/node_modules/pi-subagents-wj`。
- 2026-08-07：使用重新打包的本地 package 在隔离 Pi 项目完成 Windows 10、Node 22.21.1、Pi 0.84.1 真实旅程：`--no-approve` 不加载项目 package 命令或 provider，`--approve` 后真实 root Pi 创建真实 child Pi；child 明确继承 `--approve`，读取 40 KiB 模板正文且正文不进入 argv，启动屏障后临时提示文件已删除。child 在新实例已认领 lease、后续 factory 延迟 6.5 秒的 reload 窗口内提交 final，父会话恢复后保留既有树并接纳 8 张各 24 KiB 的 `image/png`；根 Pi stdin EOF 后 Windows Job Object 确认回收 child PID。最终 `npm test` 为 261 项中 256 通过、0 失败、5 个 Unix 原生用例按平台跳过。该证据满足当前 Node 22.19.0 + Pi 0.84.1 最低版本中的 Pi 版本，但未在精确 Node 22.19.0 环境重跑，且不替代 macOS/Linux 原生 runner 的人工验收，因此工单继续保持 `ready-for-human`。
