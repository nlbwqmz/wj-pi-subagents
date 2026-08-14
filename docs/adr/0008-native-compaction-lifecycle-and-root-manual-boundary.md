# 只以 Pi 原生生命周期处理子代理压缩，并把人工压缩限定在根会话

Status: accepted

> 当前会话本地、直接父边压缩协调与 `pi-subagent/10` 硬切换由 [ADR-0010](./0010-session-local-direct-edge-compaction.md) 覆盖；历史递归 `/9` 方案由 [ADR-0009](./0009-generic-recursive-compaction-barrier.md) 记录，本文的 `/8` 版本号和“第三方压缩不协调”限制保留为本 ADR 作出时的历史记录。

父子监督协议硬切换到 `pi-subagent/8`，managed RPC bridge 硬切换到 `pi-subagent/managed-rpc/3`。运行时不再发布 generation-scoped `compaction_resume`，不再使用 `adaptive_steer`、固定延迟、状态读取后再命令或私有 Pi RPC 来推断 continuation 所有权。第三方压缩扩展没有公开的独占 continuation lease 或跨扩展交付确认，因此本扩展不为其提供兼容性承诺，也不会猜测它是否已经续跑。

受管 child 只处理 Pi 原生 `"threshold"` 和 `"overflow"` 自动压缩。自动压缩发生在 `agent_end` 与最终的单次 `agent_settled` 之间；压缩结束后，mailbox 只接受真实 `agent_start` 或 `agent_settled` 作为下一步投递依据。阈值压缩可以保留已完成的 assistant candidate；`overflow` 且 `willRetry: true` 必须撤销旧 candidate，并等待下一次真实 `agent_start` 建立新 turn。压缩结束本身不证明宿主静止、loop 已开始或消息已经交付。

人工 `/compact` 是根会话的宿主行为，不属于 managed child coordinator、mailbox 或 supervisor 生命周期。child 侧出现 `"manual"` 压缩事件属于运行时不变量违约并关闭监督协议；它不会创建 successor task、`interrupted/absent` replacement final 或同 turn 第二个 final。协作式 `interrupt_agent` 仍可通过 assistant `stopReason: "aborted"` 产生 `interrupted` final，这与压缩无关。桥接层继续严格校验 Pi 公共事件闭集中的 `"manual" | "threshold" | "overflow"`，但 managed supervisor 只接纳后两者。

每个 turn 的首个已接纳 final 单调生效；同 turn 的后续 final 只能作为幂等重复推进 reply ACK，不能覆盖任务结果。Pi command 接纳只证明公共 `prompt()` 或 `steer()` 调用返回成功：`prompt()` 还需真实 `agent_start` 才证明 loop 已启动，任何拒绝或时序矛盾都进入粘性的 `suspended/delivery_uncertain`。自动压缩失败进入粘性的 `suspended/maintenance_failed`。两种屏障都不由后续 lifecycle 事件自动清除，也不触发自动重投递。`pi-subagent/7`、managed bridge `/2` 和更早活动树不能通过 reload 热接管，必须结束后以新版本重建。
