# 领域文档

说明工程技能在探索代码库时应如何使用领域文档。

## 探索前先读取

- 根目录的 `CONTEXT.md`；或者
- 根目录存在 `CONTEXT-MAP.md` 时，读取它指向的、与当前主题相关的各个 `CONTEXT.md`
- `docs/adr/` 中与即将修改区域相关的 ADR

如果这些文件不存在，静默继续；不要把它们的缺失作为问题，也不要预先建议创建。`/domain-modeling`（通过 `/grill-with-docs` 或 `/improve-codebase-architecture` 进入）会在实际解决术语或决策时按需创建它们。

## 文件结构

本仓库使用 single-context 布局：

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## 使用术语表中的词汇

在 issue 标题、重构提案、假设或测试名称中命名领域概念时，使用 `CONTEXT.md` 定义的术语。不要改用术语表明确避免的同义词。

如果所需概念尚未出现在术语表中，这表示需要检查是否误造了项目不使用的语言，或记录一个需要 `/domain-modeling` 处理的真实缺口。

## 标记 ADR 冲突

如果输出与现有 ADR 冲突，应明确指出，不要静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重新打开，因为……_
