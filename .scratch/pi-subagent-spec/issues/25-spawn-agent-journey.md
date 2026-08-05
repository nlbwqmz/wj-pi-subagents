# 25 - 纵向打通 `spawn_agent` 创建旅程

**What to build:** 让父会话能够按模板创建一个真实、长期复用且进入 `idle` 的直接子代理，并在创建失败时返回可操作的安全结果。

**Blocked by:** 19 - 发布可信代理模板发现快照；22 - 实现 Windows Job Object 进程树适配器；23 - 实现 macOS/Linux process group 进程树适配器；24 - 封装 Pi RPC 监督器与单节点命令顺序域

**Status:** ready-for-agent

- [ ] 输入只接受 `template_id` 和 `name`，不得携带首条任务或覆盖 cwd、环境、模型、thinking、工具、扩展、技能、提示、信任、深度和配额。
- [ ] 创建前完成模板 schema、父业务工具子集、provider/model、认证、thinking、管理能力、深度和名额预检；缺失能力不静默削减，也不启动进程。
- [ ] 子代理使用根 cwd、环境快照和 project trust，按模板装配工具、模型/thinking、上下文文件和提示模式，不复制父历史或渲染后系统提示。
- [ ] 只有监督握手、首个完整快照和 Pi RPC 就绪后才返回 `idle` 与 canonical UUID；启动失败、超时和清理不完整分别返回规范错误并正确保留或释放名额。（REQ-015..016、REQ-025；AC-009、AC-012）

