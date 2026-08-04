# 领域文档

本文档规定工程技能在探索代码库时，应如何读取和使用本仓库的领域文档。

## 开始探索前读取以下内容

- 读取仓库根目录的 `CONTEXT.md`
- 如果根目录存在 `CONTEXT-MAP.md`，则以它为入口，读取其中指向的、与当前主题相关的各个上下文 `CONTEXT.md`
- 检查 `docs/adr/`，读取与即将处理区域相关的架构决策记录
- 对于多上下文仓库，还应检查 `src/<context>/docs/adr/` 中特定上下文的架构决策记录

如果上述文件或目录尚不存在，静默继续，不要把缺失本身报告为问题，也不要预先建议创建它们。`/domain-modeling` 技能会在术语或决策真正明确时按需创建这些文档；该技能也可能由 `/grill-with-docs` 或 `/improve-codebase-architecture` 触发。

## 当前文件布局

本仓库采用单上下文布局：

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

如果仓库未来演进为真正的多上下文结构，则在根目录添加 `CONTEXT-MAP.md`，并改用以下布局：

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← ordering 上下文的决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表中的术语

当输出内容需要命名领域概念时，例如 Issue 标题、重构建议、假设或测试名称，应使用 `CONTEXT.md` 中定义的术语。不要改用词汇表明确排除的同义词。

如果所需概念尚未出现在词汇表中，这通常表示以下两种情况之一：

- 正在引入项目实际并未使用的语言，应重新考虑该命名
- 领域模型中确实存在缺口，应记录并交由 `/domain-modeling` 处理

## 标明与 ADR 的冲突

如果输出内容与现有 ADR 冲突，应明确指出冲突，不得静默覆盖已有决策。例如：

> 与 ADR-0007（订单采用事件溯源）冲突，但值得重新讨论，因为……
