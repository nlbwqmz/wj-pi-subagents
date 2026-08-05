# 34 - 落地六组合开发验收矩阵与证据

**What to build:** 让首版扩展在规定的三平台、两宿主组合中通过核心旅程和负向安全矩阵，并产出可复核、脱敏且不隐藏失败的开发验收证据。

**Blocked by:** 33 - 验证隔离环境中的本地 package 安装形态

**Status:** ready-for-agent

- [ ] Windows、macOS、Linux 各执行最低 Node/Pi 组合与验收时锁定的当前稳定 Node/Pi 组合；每个 job 运行真实 `pi --mode rpc --no-session` 和原生进程树回收，不能用 mock 替代平台回收。
- [ ] 六个 job 完整执行创建、复用、steering、递归深度、作用域、并行、中断、终止、名额释放和成功 reload 旅程；失败清理、父故障、协议乱序、配置错误、模板能力不足、错误码闭集和秘密 canary 负向矩阵均有覆盖。
- [ ] 自动化测试覆盖纯逻辑、Pi 契约、原生进程集成、TUI 交互和本地 package 五层，不依赖外部模型网络、API key 或人工交互；低版本、缺 API 和不支持平台的集中负向契约测试也通过。
- [ ] 记录源码 commit、精确 OS/Node/Pi 版本、执行的 `AC-xxx`、逐项结果、资源清理结论和脱敏日志/UI 快照；不设置性能、吞吐、延迟、RSS、句柄或 coverage 百分比门槛，不使用 skip、quarantine 或自动重试掩盖失败。（REQ-048..054；AC-028、AC-030、AC-031）

