Status: open
Type: grilling
Blocked by: 01, 02, 03

# 模型可见身份与内部关联键

## Question

在直接同步调用成为候选方案后，逐项判断 `task_id`、`turn_id`、`message_id`、`reply_seq`、`commit_id` 哪些仍有内部职责，哪些应从模型可见返回值、工具提示和父子 envelope 中移除。目标是避免把“去掉名字”换成另一套同样复杂的身份系统，同时保留真正不可避免的传输安全边界。
