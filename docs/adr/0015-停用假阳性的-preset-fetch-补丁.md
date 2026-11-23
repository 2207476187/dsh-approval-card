# 0015 停用假阳性的 preset fetch 补丁

- 状态：已采纳
- 日期：2026-11-22

## 背景

purge 的 `#24 PRESET_FETCH_ENABLED` 想把 preset 里的网页抓取从关改成开：pattern 匹配

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000
```

替换成 `fetch: true` 并追加一行 `# [dsh-purge] preset fetch enabled`。

6 个 `preset-*` 别名经 `targetFiles()` → `shippedPresetYml()` 解析，候选位置有两类：`dsh-web-app` 包内 `presets` 目录下的 `<name>.patch.yml`，以及 `dsh-agent-presets` 包内 `presets` 目录下 `<name>` 子目录里的 `agent.cordis.yml`。本机没有 `dsh-agent-presets` 这个包，`preset-unrestricted` 读的是用户目录、`preset-liangshen` 系列在包里也不存在，所以真正参与判定的只有 `cordis`、`ptc`、`standard` 三个 patch 文件。

实测这三个文件：

| 文件 | 宿主 | 官方副本（10/2） | 有没有 `[dsh-purge] preset fetch enabled` |
|---|---|---|---|
| cordis 的 patch 文件 | 第 120 行 `fetch: true` | 第 139 行 `fetch: true` | 无 |
| ptc 的 patch 文件 | 第 125 行 `fetch: true` | 第 142 行 `fetch: true` | 无 |
| standard 的 patch 文件 | 第 126 行 `fetch: true` | 第 140 行 `fetch: true` | 无 |

即：官方本来就把 `fetch` 开着，`#24` 的 pattern（`fetch: false`）从未匹配，替换从未执行，三个文件里也没有它该留下的标记。

它显示 `applied` 纯靠 marker 太宽——`markersAny: true` 加上 `markers` 里有一条仅仅是 `fetch: true`，任何 preset 写着 `fetch: true` 就判它已应用。

## 候选

- **A 什么都不做**：面板继续把这条显示成 `applied`。实际无害，但会持续误导「这条已经处理过」。
- **B 只收窄 marker**（改定义，删掉那条 `fetch: true`）：状态会落成 `pattern_not_found`，变成一条报警而不是安静的状态；且仍保留「官方一旦改回 false 就强制开网」的行为。
- **C 停用桩（采纳）**：`disabled: true` 加哨兵 pattern，状态直接 `skipped`，未来官方真把默认改成 `false` 也不会被这条改回去。
- **D 停用后还原**：否决。这几个 `.dshpurge.bak` 是 purge 首次改动时的快照，里面还是 `#63` 三段的旧文案，整文件覆盖会把今天已还原的 plan mode 第一段再打回去。

## 决定

采用 C。`node tools\disable-purge-patch.mjs 24`，桩 887 → 398 字符，**不进 `RESTORE` 表**——它没有真正改过任何 preset 文件，没有需要还原的东西。

结果：`#24` 状态 `skipped`，全量 `applied 29 / skipped 40 / na 16 / missing_file 1`（原 30/39）；两份 `core.js` 同哈希 `DA90F055`、355,897 B，`node --check` 均通过；三个 preset 文件的 mtime 未变（仍是 `#63` 那次，22:46:05）。

## 代价

- 面板只剩「跳过」，看不出这条本来想做什么；意图留在本文件和 `tools/README.md` 里。
- 若将来真的需要「预设强制开 fetch」（例如某个 preset 默认关掉），得手改 preset，或另写一条 pattern 正确的补丁——不能靠复活这条。
- 它的 pattern 已与当前官方版本脱节（官方默认就是开着），停用等于让它彻底沉默；这也意味着这条定义将来可以删。
- 顺带记一条判据：`markersAny` 里放常用值（`fetch: true` 这种）必然产生假阳性，新写补丁时 marker 应当是「只有本补丁会写出的串」。
