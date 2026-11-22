# 0004 停用 purge 的审批旁路补丁，把默认权限交回 defaultPreset

- 状态：已采纳（2026-11-22）
- 影响面：`vendor/dsh-purge/lib/core.js`、`dsh-base/cordis.patch.yml`、`dsh-user-approval/lib/{index,types/index}.js`

## 背景

两件事同时出现：

1. 新建会话默认拿到 `danger-full-access`，与设置里写的 `defaultPreset: auto-approve`（`workspace-write` + `ask`）不符；
2. 从 11-20 22:18 起 `auto-approve/audit.log` 一条新记录都没有，两天没弹过任何审批卡。

查下来都是 purge 的补丁在起作用：`#51` 让新会话跟随部署的完全访问；`#7`/`#8` 把 base 的默认沙箱与审批策略改成 `danger-full-access` + `never`；`#10` 把 `dsh-user-approval` 的 `policy` 默认值从 `ask` 改成 `never`；`#9` 直接把「调用 approval waterfall」那段代码替换成 `return "allowed-once"` —— 审批门从此收不到请求，audit 自然不会写。

## 候选

- **A** 只回退 `#51` 一行：新会话的 preset 显示对了，但 `#7`/`#8`/`#9`/`#10` 还压着，卡依旧不弹。治标。
- **B** 整体 `purge_revert` 或卸载 purge：连不带权限语义的补丁（提示词精简、兼容层、外部内容策略）一起丢，代价太大；且 purge 本身还有别的用途。
- **C** 精确停用权限相关的 8 条（`#5 #7 #8 #9 #10 #11 #12 #51`），把被改的系统文件还原成 `.dshpurge.bak`，其余补丁保持不动。（采纳）
- **D** 改 preset 绕过：把 `danger-full-access` 当默认值用下去。等于放弃审批，否决。

## 决定

按 C：

1. `dsh-user-approval/lib/index.js` 与 `lib/types/index.js` 用各自的 `.dshpurge.bak` 覆盖回官方；
2. `dsh-base/cordis.patch.yml` 的 `mode` / `policy` 默认值改回官方表达式；
3. `vendor/dsh-purge/lib/core.js` 里那 8 条改成**停用桩**：`patterns` 换成永不命中的哨兵 `__DSH_PURGE_DISABLED_<id>__`、`replace` 置空、带 `disabled: true`；
4. 给 `isLayoutSoftPatch()` 加一条 `if (patch?.disabled) return false;` —— 否则 `#5/#11/#12` 因为被硬编码成「软完成」补丁，即使停用也会一直显示「已应用」。

全部动作收敛成 `tools/disable-purge-approval-patches.mjs`（幂等、支持 `--dry-run`），因为 purge 每次「应用」或升级都会重写 `core.js`，这些改动会丢，得能一条命令重放。

## 代价

- purge 面板的「已应用」数从 50 掉到 43，8 条显示「跳过」——这是如实反映，不是坏掉。
- purge 升级或重新「应用」后需要重跑脚本；跑之前先 `--dry-run` 看它要改什么。
- 权限语义之外的其余补丁（`#29` 把网页外部内容降级为可执行数据等）仍然生效，安全姿态没变好也没变差，需要单独评估。
- 沙箱回到 `workspace-write` 后，写 `$DSH_HOME`、写工作区外文件重新需要审批；旧会话（如 2026-11-05 建的那个）preset 已固化，仍然是无卡状态，只有新会话才走 `auto-approve`。
