// 把 #89 在 buildRequest 里插入的「system 消息抽取」撤掉，回到官方形态。
//
// 官方（.dshpurge.bak）:
//   const boundaryMessages = session.deriveMessages();
//   for (const message of boundaryMessages) { ...deepFreeze... }
//   Object.freeze(boundaryMessages);
//   return markAgentLoopRequest(Object.freeze({
//     ...header.config,
//     messages: boundaryMessages,
//
// 被改（live）: 先按 role === "system" 分流，抽出 systemParts，
//   拼成 systemField 塞进顶层，messages 只留非 system 消息。
//
// 用法：node tools\restore-system-field-extract.mjs [--apply]
// 默认只预览。写盘前备份 <file>.bak-<stamp>-sysfield；锚点计数不为 1 即 exit 3。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOST_AI = process.env.DSH_AI_BASE
  ?? 'X:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai';
const LIVE = join(HOST_AI, 'dsh-agent-loop', 'lib', 'index.js');
const BAK = LIVE + '.dshpurge.bak';

const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function die(msg) {
  console.error(`[失败] ${msg}`);
  process.exit(3);
}

if (!existsSync(LIVE)) die(`找不到 ${LIVE}`);
if (!existsSync(BAK)) die(`找不到备份 ${BAK}`);

const live = readFileSync(LIVE, 'utf8');
const bak = readFileSync(BAK, 'utf8');

// 从官方备份里切出「boundaryMessages 到 messages: boundaryMessages,」这段
const BAK_START = 'const boundaryMessages = session.deriveMessages();';
const BAK_END = 'messages: boundaryMessages,';
const b0 = bak.indexOf(BAK_START);
if (b0 < 0) die('备份里找不到官方起始行');
const b1 = bak.indexOf(BAK_END, b0);
if (b1 < 0) die('备份里找不到官方结束行');
const officialBlock = bak.slice(b0, b1 + BAK_END.length);

// 在 live 里定位被改的那段
const LIVE_START = 'const boundaryMessages = session.deriveMessages(); // [dsh-purge-89] system field extract';
const LIVE_END = 'messages: nonSystemMessages,';
const liveStartCount = live.split(LIVE_START).length - 1;
const liveEndCount = live.split(LIVE_END).length - 1;
if (liveStartCount === 0 && !live.includes('systemParts') && live.includes(BAK_END)) {
  console.log('已是官方形态，无需改动。');
  process.exit(0);
}
if (liveStartCount !== 1) die(`起始锚点出现 ${liveStartCount} 次，拒绝猜`);
if (liveEndCount !== 1) die(`结束锚点出现 ${liveEndCount} 次，拒绝猜`);

const l0 = live.indexOf(LIVE_START);
const l1 = live.indexOf(LIVE_END, l0);
const liveBlock = live.slice(l0, l1 + LIVE_END.length);

// 官方块要套上 live 这行的缩进
const indent = liveBlock.slice(0, liveBlock.indexOf(LIVE_START));
const officialIndented = officialBlock
  .split('\n')
  .map((line, i) => (i === 0 || line.length === 0 ? line : indent + line))
  .join('\n');

const next = live.slice(0, l0) + officialIndented + live.slice(l1 + LIVE_END.length);

// 校验
const checks = [
  ['替换后不再有 systemParts', !next.includes('systemParts')],
  ['替换后不再有 nonSystemMessages', !next.includes('nonSystemMessages')],
  ['替换后不再有 #89 marker', !next.includes('system field extract')],
  ['official 深冻循环回来', next.includes('if (this.frozenMessages.has(message)) continue;')],
  ['official messages 直传回来', next.includes('messages: boundaryMessages,')],
  ['systemField 顶层字段已消失', !next.includes('systemField')],
  ['文件长度变化合理', next.length < live.length],
];

console.log('--- 替换前（live 片段）---');
console.log(liveBlock.split('\n').slice(0, 4).join('\n'));
console.log('...');
console.log(liveBlock.split('\n').slice(-3).join('\n'));
console.log('\n--- 替换为（官方片段）---');
console.log(officialIndented);
console.log('\n--- 校验 ---');
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}
console.log(`\n字节：${live.length} → ${next.length}（差 ${next.length - live.length}）`);
if (!ok) die('校验未通过，未写盘');

if (!apply) {
  console.log('\n预览结束。加 --apply 才写盘。');
  process.exit(0);
}

const backup = `${LIVE}.bak-${stamp}-sysfield`;
copyFileSync(LIVE, backup);
writeFileSync(LIVE, next, 'utf8');
console.log(`\n已写入 ${LIVE}`);
console.log(`备份 ${backup}`);
