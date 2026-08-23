# 父端接纳与消息发送失败语义

Status: open
Type: grilling
Blocked by: 01, 02, 03

## Question

是否为 `send_message`、`reply_to_parent` 和 `final_report` 建立统一的同步发送契约：调用接收侧 Pi 的发送接口并正常返回即视为发送成功，接口抛错则同步返回稳定异常；本 effort 不做自动重试，不等待模型处理完成、父端 context 事件或最终渲染，也不因发送失败修改子代理生命周期。需要进一步决定 ParentReplyInbox、监督通道 ACK、通知登记和异常收敛如何适配该契约，避免“Pi 未接纳消息”和“子代理运行失败”再次混为一谈。
