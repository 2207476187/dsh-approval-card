# 0023 收掉 purge 的 overlay 兜底

- 状态：已采纳
- 日期：2026-11-24
- 相关：`#78` `OVERLAY_RESTORE_FROM_BAK`

## 背景

`#78` 改的是 `dsh-app-boot/lib/index.js` 的 `loadOverlayPatches(binName, file)`。这个函数读的是**必需**的补丁文件——`loadProfileDirectory` 里由 `bundlePatchPaths(packageDir, bundle)` 解析出来的那份，注释原文写着缺了属于 misconfiguration，不是「没有 overlay」。官方实现读不到就抛错，指名哪个文件、什么错误：

```js
try {
  content = readFileSync(file, "utf8");
} catch (error) {
  throw new Error(`${binName}: failed to read overlay ${file}: ${String(error)}`);
}
```

`#78` 在 catch 里插了兜底：ENOENT 时改读 `file + ".dshpurge.bak"`，读到了就当 overlay 内容用。宿主文件因此多出 352 字节（备份 227,100 B → live 227,452 B）。

这条兜底有三个后果。一是**删除失效**：想靠删掉某个 bundle 的 `cordis.patch.yml` 关掉一层配置，文件一删反而从备份读回来继续加载，行为跟没删一样，且没有任何提示。二是**加载的是旧内容**：`.dshpurge.bak` 是 purge 改动之前的快照，年纪可能比当前 DSH 版本还老，拿它当 overlay 等于用过期配置启动新版本。三是**诊断噪声**：文件真丢了（磁盘故障、安装器清理、误删）本该立刻启动报错并指名文件，现在改成静默沿用备份，症状转移到后面才出现。

与前面几条不同，它不放权、不改语义，只是把「明确失败」换成「继续跑」。

## 候选

- **A 保持现状**：多一层保命。代价是配置缺失永远不报警，且与「purge 只改行为、不动失败语义」的原则不一致。
- **B 只标停用、不还原宿主文件**：停止它以后再被应用，但宿主里那份兜底代码还在生效，等于只关了一半。
- **C 停用 + 整文件还原**（采纳）：`RESTORE` 表声明 `78` → `dsh-app-boot/lib/index.js`，用备份覆盖回官方实现；同时把定义改成停用桩，让面板再点「应用」也不会重打。
- **D 改成只在 debug 环境兜底**：思路合理，但要动宿主代码、还要自己维护一个环境判断，收益不如直接回到官方。

## 决定

选 C。备份是干净的官方原文（marker 0、`dsh-purge` 0 处、`loadOverlayPatches` 逐字等于源码），整文件还原没有连带风险，不需要 `STRING_FIXES` 那条定点回改的路。

落地后 `loadOverlayPatches` 回到「读不到就抛错」，`#78` 显示 `skipped`。

## 代价

- 失去兜底：bundle 声明的补丁文件真的缺失时，DSH 会启动失败。这是**故意**要的——缺失应该立刻可见。
- 依赖「文件不会意外消失」这一前提。当前 57 个 `.dshpurge.bak` 的原件全部存在，所以现在不触发；哪天原件真丢了，报错会明确指出是哪个文件，比静默用旧配置好排查。
- 与其它停用桩一样，purge 重装或面板重新应用后需要重跑 `node tools\disable-purge-patch.mjs 78`。
