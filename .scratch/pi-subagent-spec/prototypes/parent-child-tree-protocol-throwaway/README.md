# 父子树协议原型（THROWAWAY）

> 这是用于验证 11 号票据协议规则的可抛弃原型，不是 Pi 扩展生产代码，不应直接打包或发布。

## 要回答的问题

在直接父子通信的前提下，帧重复、帧断序和子树快照替换是否能让父控制器得到一个一致的只读树，并在不保存无限事件历史的情况下恢复连接？

## 运行

在仓库根目录执行：

```powershell
node .scratch\pi-subagent-spec\prototypes\parent-child-tree-protocol-throwaway\demo.mjs
```

脚本使用内存传输模拟一个根控制器和一个子控制器，依次验证：

- 首次快照按 `subtree_revision` 原子装入父控制器；
- 重复帧只 ACK、不重复应用；
- 序号出现空洞时不应用断序帧，而是用最新完整快照重同步；
- 旧 `subtree_revision` 不能覆盖较新的树；
- 根侧每次完整替换产生一个新的 `tree_revision`；
- 控制器只保留最新快照和序号水位，不积累事件日志。

原型不启动真实 Pi RPC 进程，不创建 Unix socket 或 Windows 命名管道，也不验证真实模型回复注入；这些边界由实现阶段和 12 号监督器票据负责。
