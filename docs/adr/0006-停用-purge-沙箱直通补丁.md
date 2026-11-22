# 0006 停用 purge 的沙箱直通补丁 #6 / #15

- 状态：已采纳（2026-11-22）
- 影响面：`vendor/dsh-purge/lib/core.js`、`dsh-sandbox-local/lib/index.js`

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
