# 03: 工具结果结构化与错误路径

**What to build:** 10 个工具全部声明 outputSchema 并在成功时输出 structuredContent（与现有 details 一致）；所有失败统一改为 isError 返回而非抛出——模型可见的错误文本与现在完全相同，但结构化错误（含 21 个稳定错误码）在 details/structuredContent 中保留。codemode 脚本与自动化调用方可以直接消费对象、无需 try/catch 解析文本。

**Blocked by:** 02（同一工具定义模块，串行避免冲突）

**Status:** ready-for-agent

- [ ] 10 个工具声明 outputSchema，成功结果的 structuredContent 与 details 一致
- [ ] 失败路径返回 isError:true 且携带 `{ok:false,error}` 结构化对象；不再抛 SubagentToolError
- [ ] 模型可见的错误 content 文本与改造前一致；21 个错误码不变
- [ ] 三处既有错误外壳断言（启动错误、活动归一化、工具渲染错误）改造为 isError 断言
- [ ] 成功/失败两条路径的结构化输出测试通过；现有测试全绿
