# 0017 收掉 purge 的 persona `text` 字段别名

- 状态：已采纳
- 日期：2026-11-23

## 背景

`dsh-persona` 0.1.2 里人格字段叫 `text`，0.1.5 改名 `prefix` 并设为 `z.string().required()`。升级后，凡是仍写 `text:` 的预设会因「缺 prefix」挂载失败、会话起不来。

purge 的 `#38 PERSONA_TEXT_PREFIX_ALIAS` 就是为这个断层留的后门，两处替换：

1. Config schema：`prefix: z.string().required()` → `prefix: z.string().default("")`，并新增 `text: z.string().default("")`；
2. 读取处：`text: config.prefix,` → `text: config.prefix || config.text || "",`。

复核后发现它已经没有服务对象：本机唯一的自定义预设 `redteam` 用的是新版 `prefix: |`，注释里还特意写了「text 会因缺 prefix 挂载失败」；在 `.agent-presets` 与 `profiles/desktop` 的所有 yml/yaml/json 里搜 `^\s*text:`，命中 0 处。

同时要澄清一个容易搞错的点：`required()` 只要求**字段存在**，空字符串 `""` 是合法值。所以 `#43` 把四个预设的 `prefix` 清成 `""`，官方校验本来就能过——`#38` 对此不负责任。它真正放宽的是「整个 `prefix` 字段都不写」，以及多认一个旧字段名。

## 候选

- **A 保持现状**：继续兼容未知的 0.1.2 旧预设。代价是留下「漏写 prefix 也静默通过」这道放宽，出错时不报错、只是人格没了。
- **B 只删 `text` 别名、保留 `prefix` 可空**：去掉无主的兼容分支，但仍允许字段缺失，问题没解决一半。
- **C 整条还原成官方**（采纳）：`.dshpurge.bak` 是干净的官方原文，可以整文件覆盖，不涉及定点回改。
- **D 改成 `prefix` 与 `text` 二选一必填**：需要写 `superRefine`，为一个已经不存在的兼容需求增加自定义校验，复杂度不划算。

## 决定

采纳 C。`RESTORE` 表加 `38 → dsh-persona/lib/index.js`，跑 `node tools\disable-purge-patch.mjs 38`，用备份整文件覆盖。

结果：live 与 `.dshpurge.bak` 同哈希（2,163 B / `1E9DD7F0DFD87CBF`），`prefix: z.string().required()` 1 处、`text` 字段 0 处、marker 0 处；`#38` 转 `skipped`，全量计数 `applied 28 / skipped 41 / na 16 / missing_file 1`。

## 代价

- 将来真引入带 `text:` 的 0.1.2 旧预设，会在挂载时报「缺 prefix」；届时按报错把字段名改成 `prefix` 即可，比留一道无主宽松校验更可控。
- 预设漏写 `prefix` 现在会**启动即报错**，而不是静默变成空人格——这正是要的行为，但会让「抄配置少写一行」的人第一次遇到失败。
- 生效需重启 DSH，面板才把 `#38` 显示成「跳过」。
