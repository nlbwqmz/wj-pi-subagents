# RPC 监督器原型（THROWAWAY）

> 这是用于验证 12 号票据监督器职责和清理阶段的可抛弃原型，不是 Pi 扩展生产代码，不应直接打包或发布。

## 要回答的问题

监督器能否在不复制 Pi RPC 的情况下，把单节点命令串行化、终止优先级、优雅关闭、整树强制回收和部分清理失败组合成一个可观察的阶段模型？

## 运行

在仓库根目录执行：

```powershell
node .scratch\pi-subagent-spec\prototypes\rpc-supervisor-throwaway\demo.mjs
```

原型使用内存 fake 适配器，不启动真实 Pi 进程，依次验证：

- 空闲 prompt 与工作 steering 按单节点顺序执行；
- `interrupting` 只有 settle 事件才能恢复；
- 终止屏障取消未写入命令并优先进入清理；
- 优雅期限后整棵进程树强制回收；
- 孙进程残留造成 `termination_incomplete`，不会提前发布 `terminated`；
- 重复终止复用同一个清理流程。

原型只保留当前阶段、命令日志和资源观察结果，不模拟真实 IPC、Job Object、process group 或 Pi RPC 事件解析；这些由生产适配器和集成测试负责。
