#!/usr/bin/env node
// DSH 升级之后的体检：在点「应用」之前，确认现在这 22 条能重新打上。
//
// 用法：
//   node tools/preflight-upgrade.mjs --write-baseline   # 升级前跑一次，记下当前该有哪 22 条
//   node tools/preflight-upgrade.mjs                    # 升级后跑，比对基线
//   node tools/preflight-upgrade.mjs --json             # 机器可读
//
// 只看基线里那些 id。purge 里本来就有十几条 skipped/na（当前版本就不匹配），
// 把它们算进结论只会制造噪音——它们不参与判定。
//
// 退出码：0 基线全部可打；1 有掉队的；2 环境有问题（找不到 purge / 没有基线）。

import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'purge-baseline.json');

const DSH = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const CORE = join(DSH, 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib', 'core.js');
const AI = process.env.DSH_AI_BASE
  ?? 'X:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai';

const JSON_OUT = process.argv.includes('--json');
const WRITE = process.argv.includes('--write-baseline');

if (!existsSync(CORE)) {
  console.error(`找不到 purge：${CORE}`);
  process.exit(2);
}

const mod = await import(pathToFileURL(CORE).href);
const st = await mod.patchStatus(AI);
const entries = st instanceof Map ? [...st.entries()] : Object.entries(st);
const statusOf = (id) => {
  const v = entries.find(([k]) => String(k) === String(id))?.[1];
  return typeof v === 'string' ? v : (v?.status ?? 'unknown');
};
const nameOf = (id) => mod.ALL_PATCHES.find((p) => String(p.id) === String(id))?.name ?? '';

// ── 记基线 ──────────────────────────────────────────────
if (WRITE) {
  const applied = mod.ALL_PATCHES
    .filter((p) => p?.disabled !== true && statusOf(p.id) === 'applied')
    .map((p) => ({ id: p.id, name: p.name ?? '', file: p.file ?? p.rel ?? null }));
  const doc = {
    note: '基线：这些补丁当前处于 applied。DSH 升级后应能重新打上，否则 preflight 会报掉队。',
    generatedAt: new Date().toISOString(),
    expectedCount: applied.length,
    entries: applied,
  };
  writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`已写入基线 ${BASELINE}`);
  console.log(`${applied.length} 条：${applied.map((e) => '#' + e.id).join(' ')}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`没有基线文件。先跑一次：node tools/preflight-upgrade.mjs --write-baseline`);
  process.exit(2);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const OK = new Set(['applied', 'already', 'pending']);
const rows = base.entries.map((e) => {
  const status = statusOf(e.id);
  return { id: e.id, name: e.name || nameOf(e.id), status, ok: OK.has(status) };
});
const bad = rows.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({
    dshBase: AI,
    baselineFrom: base.generatedAt,
    expected: base.expectedCount,
    rows,
    bad: bad.length,
  }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

console.log('== DSH 升级体检 ==');
console.log(`宿主: ${AI}`);
console.log(`基线: ${base.entries.length} 条（记于 ${base.generatedAt}）\n`);
for (const r of rows) {
  console.log(`${r.ok ? '  ' : '❌'} #${String(r.id).padEnd(3)} ${r.status.padEnd(16)} ${r.name}`);
}

if (bad.length === 0) {
  console.log(`\n✅ ${rows.length} 条全部可打。可以点「应用」了。`);
  console.log(`   点完核对面板：22 应用 / 47 跳过 / 16 不适用 / 1 文件缺失。`);
} else {
  console.log(`\n❌ ${bad.length} 条打不上：`);
  for (const r of bad) {
    console.log(`   #${r.id} ${r.name} → ${r.status}`);
    console.log(`      它本来要改：${JSON.stringify(base.entries.find((e) => e.id === r.id)?.file ?? null)}`);
  }
  console.log(`\n   这些补丁不会改坏文件，只是不生效。多半是新版 DSH 改了那几句话。`);
  console.log(`   看具体改什么：node .build\\patch-json.mjs <id>`);
  console.log(`   决定：补一条 pattern（改 core.js，重跑 purge-restore-state）或就此放弃。`);
}
process.exit(bad.length ? 1 : 0);
