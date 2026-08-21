Status: resolved
Type: prototype
Blocked by: 01

# final_message 的权威完成与回合收束

## Question

设计并验证显式 `final_message` 工具的最小行为：工具参数与返回值、成功仅以 Pi/监督器方法调用成功为准还是需要更强确认、工具成功后当前 Pi loop 是否继续、后续普通输出或工具调用如何处理，以及抛错后的重试提示。产出一个足够具体的行为原型或状态草图，供人确认，而不是直接实现正式版本。

## Answer

原型确认采用“继续可用”的轻量语义：

- `final_message(text)` 是一次同步的 Pi 方法调用；匹配的调用成功即可返回成功，不等待父端 ACK，也不引入任务身份。
- 成功不会封存当前 Pi loop 或子代理；后续 `send_message`、普通输出和工具调用仍可继续。
- 再次成功调用 `final_message` 被视为另一条结果，不做去重或顺序裁决。
- 调用抛错只产生本次工具错误，运行状态保持不变；模型可以按系统提示词重试。
- “成功 final 后封存当前运行”不属于正式协议。

行为原型见 [final-message-state.html](../prototype/final-message-state.html)。该原型验证了正常继续、失败重试、重复 final 和 final 后紧接消息四个场景；它不进入正式运行代码。
