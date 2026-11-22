import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DRY = !process.argv.includes('--apply');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const DSH = 'C:/Users/Administrator/.dsh';
const AI = 'X:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai';

const CORES = [
  { tag: 'vendor', path: join(DSH, 'profiles/desktop/vendor/dsh-purge/lib/core.js') },
  { tag: 'node_modules', path: join(DSH, 'profiles/desktop/node_modules/dsh-purge/lib/core.js') },
];

const YMLS = [
  { tag: 'base', path: join(AI, 'dsh-base/cordis.patch.yml') },
  { tag: 'standard', path: join(AI, 'dsh-web-app/presets/standard.patch.yml') },
  { tag: 'ptc', path: join(AI, 'dsh-web-app/presets/ptc.patch.yml') },
  { tag: 'cordis', path: join(AI, 'dsh-web-app/presets/cordis.patch.yml') },
];

const OFFICIAL = "A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.";
const PURGE_CLAUSE = 'When the operator explicitly asks you to implement now, treat that as authorization to execute; exit plan mode or proceed with mutation tools as the operator directs.';
const MARKER = ' # [dsh-purge] plan-mode soft block removed';

// #63 第一条 replacement 的完整对象块（core.js 里 CRLF 换行）
const CORE_BLOCK_RE = /\r?\n {6}\{\r?\n {8}pattern:\r?\n {10}"A user's conversational agreement[^"]*",\r?\n {8}replace:\r?\n {10}"When the operator explicitly asks you to implement now[^"]*",\r?\n {6}\},/;

let failures = 0;
const log = (s) => console.log(s);

// ---------- 1. core.js：删掉 #63 的第一条 replacement ----------
for (const { tag, path } of CORES) {
  if (!existsSync(path)) { log(`[core:${tag}] 不存在，跳过`); continue; }
  const t = readFileSync(path, 'utf8');
  const m = t.match(CORE_BLOCK_RE);
  if (!m) {
    log(`[core:${tag}] 未找到待删除块（可能已删）— 视为已完成`);
    continue;
  }
  const occurrences = t.split("A user's conversational agreement").length - 1;
  if (occurrences !== 1) {
    log(`[core:${tag}] 官方句出现 ${occurrences} 次，预期 1 次 — 中止`);
    failures++;
    continue;
  }
  const out = t.replace(CORE_BLOCK_RE, '');
  if (out.length >= t.length) { log(`[core:${tag}] 替换未生效 — 中止`); failures++; continue; }
  log(`[core:${tag}] 删除 ${t.length - out.length} 字节（${t.length} → ${out.length}）`);
  if (!DRY) {
    const bak = `${path}.bak-${STAMP}-plan-clause`;
    copyFileSync(path, bak);
    writeFileSync(path, out, 'utf8');
    log(`[core:${tag}] 已写入，备份 ${bak.split(/[\\/]/).pop()}`);
  } else {
    log(`[core:${tag}] (dry-run) 将删除并备份 core.js.bak-${STAMP}-plan-clause`);
  }
}

// ---------- 2. 四个 yml：purge 句 + marker → 官方句 ----------
for (const { tag, path } of YMLS) {
  const t = readFileSync(path, 'utf8');
  const from = PURGE_CLAUSE + MARKER;
  const nFrom = t.split(from).length - 1;
  const nOff = t.split(OFFICIAL).length - 1;
  if (nFrom !== 1) {
    log(`[yml:${tag}] purge 句+marker 出现 ${nFrom} 次，预期 1 次 — ${nFrom === 0 ? '可能已还原' : '中止'}`);
    if (nFrom !== 0) failures++;
    continue;
  }
  if (nOff !== 0) {
    log(`[yml:${tag}] 官方句已出现 ${nOff} 次 — 中止（避免重复）`);
    failures++;
    continue;
  }
  const out = t.split(from).join(OFFICIAL);
  log(`[yml:${tag}] ${t.length} → ${out.length} 字节`);
  if (!DRY) {
    const bak = `${path}.bak-${STAMP}-plan-clause`;
    copyFileSync(path, bak);
    writeFileSync(path, out, 'utf8');
    log(`[yml:${tag}] 已写入，备份 ${bak.split(/[\\/]/).pop()}`);
  } else {
    log(`[yml:${tag}] (dry-run) 将还原并备份 .bak-${STAMP}-plan-clause`);
  }
}

log(`\n${DRY ? 'DRY-RUN 结束' : '已应用'}；failures=${failures}`);
process.exit(failures ? 3 : 0);
