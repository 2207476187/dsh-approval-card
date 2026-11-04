# 记录规范

## 分工
git 记「什么变了」，文档记「为什么变」。diff 能告诉你改了哪几行，永远看不到被否决的方案。

## 提交
- 提交前先 `git status`，确认没有意外文件混入。
- message 格式 `type(scope): 说明`，type ∈ feat|fix|refactor|docs|test|chore|perf。
- 标题 ≤ 50 字符，写「做了什么」；正文写「为什么」，不复述 diff。
- 一次提交只做一件事，混合改动必须拆。

## 决策
- 触发：引入依赖、改数据模型、改公开接口、技术选型、推翻既有方案。
- 落盘 `docs/adr/NNNN-短标题.md`，一页以内，四段：背景 / 候选 / 决定 / 代价。
- 决策文档只写半年后仍成立的内容。

## 过程
- 踩坑、失败尝试、被推翻的假设 → 追加 `docs/devlog/YYYY-MM.md`。
- 只记转折点，不记流水账；原始报错存 `logs/`，文档里引用 `路径:行号`。

## 禁止
- 密钥、token、凭据不进任何受版本控制的文件。
- 文档里不抄易变的接口签名和字段列表，让它从代码生成。
- 不记录可重建的东西：代码本身、构建产物、临时文件。

细则见 user skill：`chronicle-adr`（决策）、`chronicle-changelog`（变更）、`chronicle-devlog`（过程）、`chronicle-index`（索引）、`chronicle-release`（发版）、`chronicle-claude-md`（维护本文件）。
