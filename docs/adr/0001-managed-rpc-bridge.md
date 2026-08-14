# 使用受管 RPC 桥接进程绑定 Pi RpcClient 与进程树

Status: accepted

> 本 ADR 中的 Pi `0.83.0` 是决策形成时的研究基线，不是现行兼容门槛；当前最低宿主为 Pi `0.84.1`。以下公共 API 观察说明受管桥接决策的背景。

Pi `0.83.0` 的公共 `RpcClient.start()` 固定自行创建 RPC 子进程，不能接收外部 transport、spawn factory 或独立退出观察；Windows Job Object 和 Unix process group/session 又必须在目标进程运行前建立归属。扩展因此由 `ProcessTreeAdapter` 先启动包内受管 RPC 桥接进程，桥接进程再独占公共 `RpcClient`，并只把监督器需要的高层命令、事件和故障事实通过有界本地协议暴露给父进程。桥接进程创建的 Pi RPC 子进程继承同一 Job Object 或 process group/session，从而把 RPC 命令面和进程树资源绑定为一个受管 RPC 节点。桥接进程不生成 `agent_id`，不是独立子代理，只是该节点的内部承载层。

## 备选方案

- 修改 Pi 公共 `RpcClient` 以注入 transport 或 spawn：会让独立扩展依赖上游核心改动和新的最低版本，违背当前不修改 Pi 核心的边界。
- 在扩展中复制 Pi JSONL 客户端：会复制上游协议、请求关联和事件解析，扩大兼容风险。

## 影响

每个子代理增加一个本地桥接进程和一条内部协议，但复杂度集中在受管 RPC 节点模块内。`RpcSupervisor` 不再分别接收可独立组合的 `RpcClient`、进程说明和树适配器；生产与测试都必须通过同一个受管节点接口证明 RPC 进程与资源句柄属于同一启动事务。
