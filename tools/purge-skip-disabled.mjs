// 给 purge 的「应用」与「状态」两处加 disabled 短路：停用桩在点应用时不再改文件。
// 幂等：已打过就跳过。core.js 会被 purge 升级重写，届时重跑本脚本。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const CORE = join(DSH, 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib', 'core.js');
const DRY = process.argv.includes('--dry-run');

// 1) applyPatches：disabled 直接记 skipped，continue（不读文件、不写文件）
const APPLY_OLD = `  const preserveClientBundles = options.preserveClientBundles === true;
  await repairPluginCordisYaml();
  for (const p of patches) {
    if (!patchAppliesHere(p)) {`;
const APPLY_NEW = `  const preserveClientBundles = options.preserveClientBundles === true;
  await repairPluginCordisYaml();
  for (const p of patches) {
    // [local] 显式停用的补丁（disabled: true）一律跳过：点「应用」不再改文件。
    // 这些是我们为中和 purge 自带改动而写的停用桩，patterns 是永不命中的哨兵。
    if (p.disabled) {
      report.push({
        patch_id: p.id,
        name: p.name,
        status: "skipped",
        path: "",
        applied: 0,
        already: 0,
        missing: 0,
      });
      continue;
    }
    if (!patchAppliesHere(p)) {`;

// 2) patchStatus：disabled 直接报 skipped，不参与 applied/pending 判定
const STATUS_OLD = `  for (const p of patches) {
    if (!patchAppliesHere(p)) {
      status[p.id] = "na";`;
const STATUS_NEW = `  for (const p of patches) {
    // [local] 停用桩如实报 skipped，避免将来软完成判定把它算成 pending/applied。
    if (p.disabled) {
      status[p.id] = "skipped";
      continue;
    }
    if (!patchAppliesHere(p)) {
      status[p.id] = "na";`;

if (!existsSync(CORE)) {
  console.error(`找不到 ${CORE}`);
  process.exit(2);
}

const raw = readFileSync(CORE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');

if (text.includes('// [local] 显式停用的补丁')) {
  console.log('[applyPatches] 已存在 disabled 短路，跳过');
} else if (text.includes(APPLY_OLD)) {
  text = text.replace(APPLY_OLD, APPLY_NEW);
  console.log('[applyPatches] 已插入 disabled 短路');
} else {
  console.error('[applyPatches] 锚点未找到，未改动。purge 版本可能不同。');
  process.exit(3);
}

if (text.includes('// [local] 停用桩如实报 skipped')) {
  console.log('[patchStatus] 已存在 disabled 短路，跳过');
} else if (text.includes(STATUS_OLD)) {
  text = text.replace(STATUS_OLD, STATUS_NEW);
  console.log('[patchStatus] 已插入 disabled 短路');
} else {
  console.error('[patchStatus] 锚点未找到，未改动。purge 版本可能不同。');
  process.exit(3);
}

if (text === raw.replace(/\r\n/g, '\n')) {
  console.log('\n没有需要改动的地方。');
  process.exit(0);
}

if (DRY) {
  console.log('\n--- 演练：两处都将改动，未写盘 ---');
  console.log(APPLY_NEW);
  console.log('...');
  console.log(STATUS_NEW);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
copyFileSync(CORE, `${CORE}.bak-${stamp}-disabled-skip`);
if (crlf) text = text.replace(/\n/g, '\r\n');
writeFileSync(CORE, text, 'utf8');
console.log(`\n已写入 ${CORE}`);
console.log(`备份 ${CORE}.bak-${stamp}-disabled-skip`);
console.log('重启 DSH 后生效；之后点「应用」不会再有停用补丁被重新打上。');
