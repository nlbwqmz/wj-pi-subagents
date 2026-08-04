# 确定 RPC 监督器与跨平台进程回收架构

Type: prototype
Status: open
Blocked by: 03, 04, 08, 11

## Question

扩展应封装 Pi 公开 `RpcClient`，还是实现专用 RPC 监督器，才能统一保证逐节点命令串行化、进程启动与退出观测、stdin EOF 优雅关闭、超时升级、子树级联终止，以及 Windows 和其他目标平台上的强制进程树回收？原型需要给出清晰模块责任和可测试接口，而不能依赖只终止直接子进程的默认行为。

## Answer

<!-- 解决时填写，并链接架构原型资产。 -->

## Comments

<!-- 追加讨论历史。 -->
