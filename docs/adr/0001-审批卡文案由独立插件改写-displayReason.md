# 0001 审批卡文案改由独立插件接管，且只改写 displayReason

日期：2026-11-03
状态：Accepted

## 背景

审批卡经常只显示一句 `目标含工作区外路径 1 处：C:\Windows\Temp`，看不到真正被写的是哪个文件。
排查后确认卡片正文有两个生产者，且都没能力给出「精确目标」：

- 审批门 `dsh-approval-gate` 在 `src/index.mjs:3329` 用 `showChineseReason()` 把 `req.reason`
  直接换成它自己拼的中文（`操作：/路径：` 两行，路径最多 5 条、每条被 `clip()` 尾部截断）；
  它做路径抽取时对**写入内容**也扫，于是正文里的 `p://`（来自 `http://`）、`/**`、正则片段
  会被当成「工作区外路径」，卡片因此比原文更含糊。
- 宿主提权模板（`dsh-sandbox/lib/index.js:110-113`）只把模型写的一句话 `justification` 塞进
  `displayReason.zh`，模型常常只写个文件名或目录。

另外 `dsh-client-ui-chat` 的 `ApprovalCommand` 只认 `args.command`，所以文件类工具的审批卡
**一行详情都没有**。

## 候选

1. 改 `dsh-approval-gate` 的 `zh.mjs`（在源头把路径写全）。
2. 改宿主的提权模板（往 `approveEscalation` 里塞 target）。
3. 在审批瀑布最前面加一个插件，只改写 `displayReason.zh`。

## 决定

选 3，并落在 `C:\Users\<user>\.dsh\profiles\desktop\plugins\dsh-approval-card\`
（不是 `node_modules`、不是程序目录 —— 那两处在 DSH 更新时会被重写）。

理由：

- gate 与宿主都属于「别人的包」，更新会覆盖；profile 目录下的插件目录不会。
- 审批门的 `reason` 被上游（放行规则、审计、其它插件）解析，改它有连带风险；
  卡片标题优先读 `displayReason`，只动这一处就能改观，且失败时最多是退回原文。
- 插件永远 `return next()`：不参与放行决策，出问题不会卡住审批。

## 代价

- 代价一：与 `dsh-approval-zh`（同一需求的早期版本）逻辑重叠，靠 `hasSummary` 幂等去重；
  建议只启用一个。
- 代价二：文案在两处生成（门的 `reason`、我们的 `displayReason`），排查时要分清哪句是谁写的。
- 代价三：`displayReason` 的换行依赖客户端 CSS（`_headline` 没有 `white-space`），
  `client.js` 半边必须加载，否则两行会被折叠成一行。
