// 临时工具：读 app.asar（新版只发 asar，没有 resources\app 目录可 grep）
// 用法：
//   node tmp-asar.mjs list <asar> <prefix>
//   node tmp-asar.mjs cat  <asar> <path>
//   node tmp-asar.mjs grep <asar> <pattern> <pathPrefix> [maxFiles]
//
// 头部不按 pickle 的字段长度硬算：直接扫描第一个 '{' 并用括号配对找 JSON 结尾，
// 文件数据起点用 pickle 里的 headerPayloadSize（第二个 uint32）算，稳。
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const [mode, asar, ...rest] = process.argv.slice(2);
if (!mode || !asar) {
  console.error('usage: list|cat|grep <asar> ...');
  process.exit(2);
}

const fd = openSync(asar, 'r');
const total = statSync(asar).size;

function readAt(pos, len) {
  const buf = Buffer.alloc(Math.max(0, Math.min(len, total - pos)));
  const n = readSync(fd, buf, 0, buf.length, pos);
  return buf.subarray(0, n);
}

const head = readAt(0, 16);
const headerPayloadSize = head.readUInt32LE(4);
const baseOffset = 8 + headerPayloadSize;

// 扫 JSON
const probe = readAt(8, Math.min(total - 8, 64 * 1024 * 1024));
const start = probe.indexOf(0x7b); // '{'
let depth = 0;
let inStr = false;
let esc = false;
let end = -1;
for (let i = start; i < probe.length; i += 1) {
  const c = probe[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === 0x5c) esc = true;
    else if (c === 0x22) inStr = false;
  } else if (c === 0x22) inStr = true;
  else if (c === 0x7b) depth += 1;
  else if (c === 0x7d) {
    depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end < 0) {
  console.error('header JSON not found');
  process.exit(1);
}
const header = JSON.parse(probe.subarray(start, end + 1).toString('utf8'));

const files = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p);
    else if (child.unpacked !== true) files.push({ path: p, offset: Number(child.offset), size: child.size });
  }
})(header, '');

const readFile = (entry) => readAt(baseOffset + entry.offset, entry.size).toString('utf8');

if (mode === 'list') {
  const prefix = rest[0] ?? '';
  const hits = files.filter((f) => f.path.startsWith(prefix));
  console.log(`total=${files.length} matched=${hits.length}`);
  for (const f of hits.slice(0, 120)) console.log(`${f.size}\t${f.path}`);
} else if (mode === 'cat') {
  const entry = files.find((f) => f.path === rest[0]);
  if (!entry) {
    console.error(`not found: ${rest[0]}`);
    process.exit(1);
  }
  process.stdout.write(readFile(entry));
} else if (mode === 'grep') {
  const pattern = rest[0];
  const prefix = rest[1] ?? '';
  const maxFiles = Number(rest[2] ?? 10);
  let scanned = 0;
  let found = 0;
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    if (!/\.(m?js|cjs|json|md|yml)$/.test(f.path)) continue;
    scanned += 1;
    let text;
    try {
      text = readFile(f);
    } catch {
      continue;
    }
    const hits = text.match(new RegExp(pattern, 'g'));
    if (!hits) continue;
    found += 1;
    console.log(`${f.path}\thits=${hits.length}`);
    const lines = text.split('\n');
    let printed = 0;
    for (let i = 0; i < lines.length && printed < 2; i += 1) {
      if (new RegExp(pattern).test(lines[i])) {
        console.log(`  ${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        printed += 1;
      }
    }
    if (found >= maxFiles) break;
  }
  console.log(`scanned=${scanned} filesWithHits=${found}`);
}

closeSync(fd);
