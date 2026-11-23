// 把 #42 插入的 persistLegacy 改成原子写：先写 tmp，再 rename 覆盖正本。
// 必须同时改两处：宿主 dsh-settings/lib/index.js（实际生效的）与两份 core.js 里 #42 的 replace 文本
// （否则点「应用」会按旧定义把非原子写打回来）。
// 用法：node .build/harden-legacy-write.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const LIVE = 'X:\\Program Files\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-settings\\lib\\index.js';
const CORES = [
  path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib', 'core.js'),
  path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-purge', 'lib', 'core.js'),
];

// —— 宿主文件：真实制表符 ——
const LIVE_OLD = '\t\tawait writeFile(this.legacyPath, stringify(this.legacyDocument), "utf8");';
const LIVE_NEW = [
  '\t\tconst tmpFile = this.legacyPath + "." + process.pid + ".tmp"; // [dsh-purge-hardening] atomic legacy write',
  '\t\tawait writeFile(tmpFile, stringify(this.legacyDocument), "utf8");',
  '\t\tawait rename(tmpFile, this.legacyPath);',
].join('\n');

// —— core.js：#42 replace 里的同一条语句（反斜杠是源码里的字面转义） ——
const CORE_OLD = '"\\t\\tawait writeFile(this.legacyPath, stringify(this.legacyDocument), \\"utf8\\");\\n"';
const CORE_NEW = [
  '"\\t\\tconst tmpFile = this.legacyPath + \\".\\" + process.pid + \\".tmp\\"; // [dsh-purge-hardening] atomic legacy write\\n" +',
  '"\\t\\tawait writeFile(tmpFile, stringify(this.legacyDocument), \\"utf8\\");\\n" +',
  '"\\t\\tawait rename(tmpFile, this.legacyPath);\\n"',
].join('\n');

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

let failures = 0;

function patch(file, oldText, newText, label) {
  if (!fs.existsSync(file)) {
    console.log(`[跳过] ${label}: 文件不存在`);
    failures += 1;
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const hits = countOf(text, oldText);
  if (hits === 0) {
    const already = countOf(text, 'atomic legacy write');
    console.log(`[跳过] ${label}: 未找到原始语句（已有加固标记 ${already} 处）`);
    if (already === 0) failures += 1;
    return;
  }
  if (hits !== 1) {
    console.log(`[拒绝] ${label}: 原始语句出现 ${hits} 次，预期 1 次，不猜`);
    failures += 1;
    return;
  }
  const next = text.replace(oldText, newText);
  if (!APPLY) {
    console.log(`[演练] ${label}: ${oldText.length} → ${newText.length} 字符`);
    return;
  }
  const backup = `${file}.bak-${stamp}-atomic`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, next, 'utf8');
  console.log(`[写入] ${label}: ${fs.statSync(file).size} B（备份 ${path.basename(backup)}）`);
}

console.log(APPLY ? '== 实际写入 ==' : '== 演练（加 --apply 才写盘） ==');
patch(LIVE, LIVE_OLD, LIVE_NEW, 'dsh-settings/lib/index.js');
for (const [i, core] of CORES.entries()) patch(core, CORE_OLD, CORE_NEW, `core.js #${i + 1}`);

if (failures > 0) {
  console.log(`\n${failures} 处未完成，需人工确认后再跑。`);
  process.exit(3);
}
console.log(APPLY ? '\n完成。请自己跑 node --check 复核语法。' : '\n演练结束，无改动。');
