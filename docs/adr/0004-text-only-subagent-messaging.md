# 子代理业务通信只允许文本

Status: accepted

> 本文的纯文本通信决策继续有效；当前协议版本、任务身份和 final 提交语义已由 [ADR-0005](./0005-task-mailbox-and-delayed-final-commit.md) 覆盖。

`send_message`、`reply_to_parent` 和运行时自动生成的 final 统一为纯文本通信。公开工具 schema 不声明 `images`，控制器和回复 codec 对绕过 schema 注入的 `images` 字段返回错误；Pi assistant 的图片内容块不进入候选输出，图片-only 处理形成 `output_state: "absent"`、`reason_code: "no_output"` 的 final。父会话 inbox 只注入结构化文本信封。

此前图片载荷由模型或调用方直接提供原始 Base64，扩展只能验证编码、大小和 MIME 文本，不能证明载荷是可解码且完整的图片。无效载荷仍会进入父会话并触发宿主或 provider 的图片解析错误。继续保留任一上行、下行图片入口都会保留相同的不可信二进制边界；完整的格式解码、重编码和引用式存储不属于当前扩展的职责，因此不以更复杂的图片校验替代移除。

这是破坏性协议变更。监督协议升级为 `pi-subagent/4`，回复信封版本升级为 2，任务 RPC 的 prompt/steer 图片参数同步删除。v4 端点显式拒绝 v3 帧和带图片字段的回复，既有 v3 活动树必须结束并重建，不能通过 `/reload` 热接管。ADR-0003 中关于图片载荷和 `pi-subagent/3` 的陈述由本决策覆盖，其余结构化回复、轮次、ACK 和唤醒语义保持不变。
