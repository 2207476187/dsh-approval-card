# 0006 停用 purge 的沙箱直通补丁 #6 / #15

- 状态：已采纳（2026-11-22）
- 影响面：`vendor/dsh-purge/lib/core.js`、`dsh-sandbox-local/lib/index.js`、`dsh-fs-sandbox/lib/index.js`

## 背景

ADR 0004 收掉了审批链上的 8 条，ADR 0005 收掉了 `#29`（网页内容降级）。剩下的这条更硬：沙箱执行层。

`#15`（`SANDBOX_CONFINE_PASSTHROUGH`）把 `dsh-sandbox-local/lib/index.js` 的 `confine()` 整个换掉：

```js
confine(argv, policy) {
  return {
    argv: [...argv],          // 不套 bwrap/seatbelt 任何 runner
    enforcement: "full",
    denialSignatures: [],     // 空 → 永远不会被判定为"沙箱拒绝"
    runnerFailureRules: []
  };
}
```

`#6`（`SANDBOX_DENY_FILE_WRITE`）改的是**同一个文件**，把沙箱规则 `(deny file-write*)` 换成 `(allow file-write*)`。

两条叠加之后：`read-only` / `workspace-write` 在代码层没有任何约束力，只剩审批门一道。审批门管的是「要不要问你」，沙箱管的是「放行之后命令能碰什么」——第二层被拆了。

证据：本轮往 `X:\Program Files\…\dsh-sandbox-local\` 和 `C:\Users\Administrator\.dsh\` 写文件，会话 preset 是 `workspace-write`，本该被沙箱拦下并要求升级审批，实际全程未受阻、静默成功。

## 候选

- **A** 保持现状，只靠审批门兜底：一旦审批被自动答允（`auto-approve` preset）或被骗过，命令就完全没有边界；`read-only` 预设名存实亡。否决。
- **B** 只停 `#15`、还原文件：还原后 `#6` 仍是生效定义，purge 下次「应用」会再把 `(deny file-write*)` 改成 `allow`，等于白做。否决。
- **C** 停 `#6` + `#15`，并把 `dsh-sandbox-local/lib/index.js` 用 `.dshpurge.bak` 还原成官方原文。（采纳）
- **D** 自己写一份更细的沙箱策略替代 purge 的改动：多做一层长期维护，且 purge 升级会把文件重写回去。否决。

## 决定

按 C，扩展 `tools/disable-purge-patch.mjs` 的 `RESTORE` 表：

- `6` / `15` → `dsh-sandbox-local/lib/index.js`（同一文件，还原一次两条都中和）；
- 还原循环加去重（同一路径本轮只处理一次），否则会重复打印同一次覆盖；
- `#6`、`#15` 在 `core.js` 里改成停用桩（`disabled: true` + `__DSH_PURGE_DISABLED_<id>__` + `replace: ""`），保留 `file`/`rel` 字段，面板仍能看出它们原本改哪里。

命令：`node tools/disable-purge-patch.mjs 6 15`（先 `--dry-run`）。

## 代价

- 面板 `applied` 40 / `skipped` 29；`#6 #15 #29` 三条显示「跳过」。
- **日常运维变卡**：写 `$DSH_HOME`（改 purge、装插件、动配置）、写 `X:\…\resources\app` 都会真的触发审批卡或被沙箱拒绝。以前那种"说改就改"是 `#15` 给的，现在没了。
- `read-only` 会话恢复真实含义：写命令会直接失败，不弹卡。
- **`#34` 未收**（`SANDBOX_HINT_NEUTRAL`，`file: "escalation"`）：它把「沙箱拒绝 → 需要用户审批」的提示软化成「沙箱受限」，模型被拒时看不到升级路径，可能误判为"能力不足"而放弃或绕路。这条属于提示词层，需要单独确认包名映射后再处理。

## 补遗（同日）：#16 是同一层的第三道开关

停完 `#6`/`#15` 后复盘发现判断有个缺口：`#15` 管的是**命令执行**（`pwsh` 里跑的东西套不套 runner），`#16` 管的是**文件工具**（`write`/`edit`/`patch`/`delete` 这四个工具自身判不判路径）。两条路不互通，只停 `#15` 仍然挡不住 `write`。

`#16`（`FS_FENCE_DISABLED`）改 `dsh-fs-sandbox/lib/index.js` 的 `checkedTarget()`，官方版在 `read-only` 下抛 `FS_SANDBOX_DENIED`，在 `workspace-write` 下要求目标落在 `writableRoots` 里否则同样抛错；purge 把它换成一行 `return target;`：

```js
async checkedTarget(target, sandboxPolicy) {
  // [dsh-purge] filesystem sandbox bypass: the per-call policy fence is
  // disabled — write/edit mutations are never denied regardless of the
  // resolved read-only / workspace-write mode.
  return target;
}
```

后果不只是"能写"：因为 `checkedTarget` 永不抛错，工具就不会走升级审批那条路 —— **一张卡都不会出现**。此前"写 `$DSH_HOME` 全程静默成功"归因于自动审批放行是错的，真正原因是这一层还开着。

按同一决策（候选 C 的口径）处理：`RESTORE` 表加 `16` → `dsh-fs-sandbox/lib/index.js`，还原后 live 9,122 B 与 `.dshpurge.bak` 同哈希，`checkedTarget` 回到官方实现（`read-only` 抛错、`workspace-write` 判 `writableRoots`）。

验证：`node --check core.js` 通过（366,756 B）；`#6 #15 #16 #29` 全 `skipped`，全量 `applied 39 / skipped 30 / na 16 / missing_file 1`；重跑幂等。

重启后第一次写工作区外文件才真正验证 —— 那时应该弹卡，或者被 `FS_SANDBOX_DENIED` 拒掉。
