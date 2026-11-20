# 0003 外部 skill 装进 `$DSH_HOME\skills`，并把它当依赖对待

- 状态：Accepted
- 日期：2026-11-21

## 背景

装了 cocoloop（skill 管理器）和它的第一个产物 `self-improving-agent`，两个都来自外部 URL：

- `https://dl.cocoloop.cn/cocoloop-main.zip`（20,519 B，7 个文件）
- `https://dl.cocoloop.cn/bss/skills/pskoett-self-improving-agent-3.0.21.zip`（26,211 B，16 个文件，`_meta.json` 记 `version: 3.0.21`）

skill 和普通依赖不一样：它没有可执行入口，内容是**给模型读的文本**。装一个 skill 等于给以后每个会话的提示词里加一段别人写的指令——信任边界在提示词这一层，不在代码执行这一层。

## 候选

1. **不装**。用户明确要求，且 cocoloop 后续要维护一批 skill，绕不过。
2. **装到工作区**（`D:\DeepSeek Harness工作目录\...`）。工作区随仓库走，等于把第三方文本提交进公开仓库，还得处理改名/清洗。
3. **装到 `$DSH_HOME\skills\`**（DSH 的技能目录，不进仓库）。
4. **装到 `$DSH_HOME\skills\` 并改写文件内容**（比如把 OpenClaw 专用路径改成本机的）。改一处就要维护一处，下次作者发版就冲突。

## 决定

选 3，并且：

- **只改一处**：`self-improving-agent` 的 frontmatter `name` 从 `self-improvement` 改成 `self-improving-agent`（用户指定名称，且 DSH 目录名与 `name` 保持一致最省事）。其余文件逐字节原样。
- **装前做静态检查**：`eval` / `exec(` / `rm -rf` / `base64 -d` 命中 0；`SKILL.md` 里只有 4 个出处链接，没有动态下载代码的行为。两个包都只有文本与 shell/ts 样例。
- **记录指纹**：`cocoloop\SKILL.md` sha256 前 16 位 `25093139b07f4c9d`，`self-improving-agent\SKILL.md` `ad703b1493e2177b`。日后怀疑被改，先比这个。
- **不写进 profile**：skill 由 DSH 扫目录加载，不进 `package.json` / `cordis.patch.yml`，也不受插件更新影响。

## 代价

- `self-improving-agent` 的 `scripts\*.sh` 与 `hooks\openclaw\*` 是 **OpenClaw 专用**，DSH 不会执行；它们只是躺着，但会让人误以为装了钩子。
- 两个包都**没有版本号字段**（cocoloop 完全没有，self-improving-agent 只有 `_meta.json` 的 3.0.21），「是不是最新版」只能靠比对 URL 或文件指纹，无法自动判定。
- 第三方文本进入提示词后，其行为我无法逐条审计；它自己写着「captures learnings, errors, corrections」并会在工作区建 `.learnings/`，属于会**改工作区文件**的 skill——用之前先看清楚它要写哪里。
