# 核实 Pi 原生子代理承载能力

Type: research
Status: resolved
Blocked by: none

## Question

以 Pi 上游提交 `a96fb984d8c8b065fc5d193309fc812a882adee0` 的源码和官方仓库文档为一手来源，哪些 CLI、RPC、扩展及 TUI API 可以直接承载已确定的临时分层子代理模型，哪些行为必须由扩展自行实现？研究必须覆盖：无会话 RPC 进程、`prompt`/`steer`/`abort`、状态与队列事件、动态工具暴露、子进程按深度加载扩展、根树状态汇聚、取消与进程退出，及 Windows 上级联清理的已知能力或缺口。

## Answer

Pi 原生足以承载单个长期、无会话持久化的 RPC 子代理进程，并直接提供 prompt/steering、abort、状态、队列、完整事件流、动态工具与扩展/TUI 生命周期 API；但 Pi 没有父子代理、深度预算或跨进程代理树领域对象。

统一 `send_message` 在线协议上宜始终发送 `prompt` 并携带 `streamingBehavior: "steer"`：空闲时正常启动，繁忙时原子进入 steering 队列。直接在空闲状态调用原生 `steer` 只会入队，不会启动运行。

扩展必须自行实现节点注册表、逐节点 RPC 串行化、深度与直接父子授权、树状态上报/汇聚、根只读投影和进程 supervisor。两项原生缺口尤其影响契约：`abort` 不清已排队消息且 RPC 没有 `clear_queue`；Windows 的整树终止 helper 未公开，公开 `RpcClient.stop()` 只处理直接子进程。

完整证据、分类和规格约束见 [Pi 原生子代理承载能力研究](../research/pi-native-capabilities.md)。

## Comments

<!-- 追加研究过程或上下文指针。 -->
