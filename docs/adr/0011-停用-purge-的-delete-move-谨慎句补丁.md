# 0011 停用 purge 的 delete/move 谨慎句补丁

- 状态：已采纳（2026-11-22）
- 影响面：`dsh-tool-bash`、`dsh-tool-pwsh`

## 背景

`#48` `TOOL_SHELL_DELETE_MOVE_NEUTRAL`（`file: ["tool-bash","tool-pwsh"]`，`optional: true`，`softSettle: true`）只做一处替换，但打在两个函数里：

```
Before any delete or move, verify that the resolved absolute target path is the
intended one; never run it against a computed path you have not checked.
```

被换成 `Proceed with operator-requested paths.`。实际落在 `dsh-tool-bash/lib/index.js` 1 处、`dsh-tool-pwsh/lib/index.js` 2 处（base 描述与 Windows 专属分支各一份）。

这条与 `#33` 的区别在于介入时机：`#33` 管"被沙箱拒绝之后怎么说"，`#48` 管"动手删除/移动之前核不核"。删掉的是一层意图防护——不是"变量会不会为空"，而是"这个算出来的绝对路径，究竟指向哪里"。

最要命的是它紧跟着保留了官方的另一半：

```
An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`.
```

前半句（先 Resolve-Path 核对绝对路径）被换成"照做"，后半句（用 `${VAR:?}` 防空展开）还在。于是描述里剩下的只有语法层提示，而"路径算对了但不是你想动的那个"这类纯语义错误彻底失去防线。

典型失败：`Remove-Item "$target\*" -Recurse` 在 `$target` 拼错或未赋值时变成 `Remove-Item "\*"`；`rm -rf "$dir/build"` 在 `dir` 为空时变成 `rm -rf "/build"`；在错误的 workdir 下 `rm -rf ..\data` 删掉的是别处。官方要求的动作是"先 `Resolve-Path` / `realpath` 打印出来人眼确认，再删"。

`.dshpurge.bak` 与 live 同样逐字节相同（bash 备份里 `Proceed` 1 次、官方句 0 次；pwsh 备份 `Proceed` 2 次、官方句 0 次），`RESTORE` 表不可用。

## 候选

- **A** 保持现状。否决：与"删除前核对路径"这条基础操作纪律相反，且它和 `#33` 是同一批降级的一部分。
- **B** 只停用不还原。否决：文本已是改后的样子，停用只阻止下次重打。
- **C** 停用 + 按官方原文定点回改 3 处。（采纳）
- **D** 保留"照做"但补一句自定义警告。否决：官方原句本来就在，自写措辞只会引入第二套说法，且上游更新后更易失配。

## 决定

1. `#48` 改写成停用桩（`disabled: true` + `patterns: ["__DSH_PURGE_DISABLED_48__"]`）。
2. `tools/disable-purge-patch.mjs` 的 `STRING_FIXES` 增加 `48` 两条定点回改：`dsh-tool-bash` 预期 1 次、`dsh-tool-pwsh` 预期 2 次。不进 `RESTORE`（备份脏）。
3. 保留官方原句尾随空格（`...you have not checked. `），与相邻句子之间的分隔一致。

验证：bash 29,146 → 29,260 B、pwsh 31,982 → 32,210 B；两文件官方句在位（bash 1 / pwsh 2）、`Proceed with operator-requested paths.` 归零；上一轮 `#33` 的官方沙箱句未被牵连（bash 1 / pwsh 2）；`node --check core.js` 通过；`#48 skipped`，全量 `applied 31 / skipped 38 / na 16 / missing_file 1`；`verify-apply-skips-disabled` 20 条停用项零写入、51 文件零变化；重跑输出「没有需要改动的地方」。

## 代价

- `STRING_FIXES` 现有三张定点表（`33`、`36`、`48`），全部靠字面量匹配；上游改写这几句时会打印「未匹配到已知污点」并跳过，需人工重取官方原文。
- 升级 DSH 后要重放 `node tools\disable-purge-patch.mjs 33 48`，否则宿主回官方态、这两条补丁会把话术重新打上。已并入 `tools/README.md` 的重放命令。
- `#48` 的 `softSettle: true` 本来就是为了"上游删掉谨慎句时也算完成"；停用后这个语义不再有意义，判断依据只剩 `tools/README.md` 与本文档。
