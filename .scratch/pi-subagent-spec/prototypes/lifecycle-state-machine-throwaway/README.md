# 子代理生命周期状态机原型（THROWAWAY）

> 这是用于回答规格问题的可抛弃原型，不是扩展生产代码，不应直接打包或发布。

## 要回答的问题

公开七态模型 `starting`、`idle`、`working`、`interrupting`、`failed`、`terminating`、`terminated`，能否在启动失败、中断后继续执行已接受消息、迟到事件、等待竞态、运行故障和级联终止下保持单向且可解释，同时严格区分协作式中断与永久终止？

## 运行

仓库没有现成任务运行器，直接使用已安装的 Node.js：

```powershell
node .scratch/pi-subagent-spec/prototypes/lifecycle-state-machine-throwaway/tui.mjs
```

运行内置演示场景：

```powershell
node .scratch/pi-subagent-spec/prototypes/lifecycle-state-machine-throwaway/tui.mjs --demo
```

交互模式每次读取一行命令，并在每次动作后重新渲染完整内存状态。输入 `help` 查看命令，输入 `quit` 退出。

## 文件

- `machine.mjs`：无 I/O 的纯内存状态机，维护节点状态、消息计数、等待器、修订号和状态转换轨迹。
- `tui.mjs`：可抛弃的交互终端外壳，以及用于人工评审的内置演示场景。

## 内置演示覆盖

1. `spawn_agent` 握手完成后才从 `starting` 进入 `idle`。
2. `agent_end` 与 `abort` 响应不能结束 `interrupting`，只有 `agent_settled` 可以。
3. 等待器可因 settle 完成，但返回最新快照时节点已经重新进入 `working`。
4. 接受状态未知的消息不会立即使健康节点进入 `failed`，后续 settle 可消解未决交付。
5. 终止屏障忽略迟到 settle，`termination_incomplete` 保持 `terminating`。
6. 启动失败先留下 `failed` 转换记录，再自动清理为 `terminating`、最终 `terminated`。
7. 级联终止在一个树修订中覆盖目标及后代，父节点只能在全部后代终止后确认回收。
8. 中间节点崩溃后保留 `failed`，其后代自动进入防孤儿终止流程。

## 有意不做的内容

- 不启动真实 Pi RPC 进程，不验证 JSONL、进程信号或 Windows 进程树回收。
- 不实现持久化、自动重启、发布结构、模板加载或配额计算。
- 不提供生产级校验、日志、错误恢复或测试套件；原型只用于人工推动困难状态分支。
