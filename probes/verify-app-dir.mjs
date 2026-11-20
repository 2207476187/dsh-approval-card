// 校验 resources\app 与 app.asar 头记录是否一致（逐文件大小 + unpacked 源比对）
// 用法：node verify-app-dir.mjs <app.asar> <app 目录>
import { openSync, readSync, closeSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [asar, appDir] = process.argv.slice(2);
if (!asar || !appDir) {
  console.error('usage: node verify-app-dir.mjs <app.asar> <appDir>');
  process.exit(2);
}

const fd = openSync(asar, 'r');
const total = statSync(asar).size;
const head = Buffer.alloc(16);
readSync(fd, head, 0, 16, 0);
const baseOffset = 8 + head.readUInt32LE(4);

const probe = Buffer.alloc(Math.min(total - 8, 64 * 1024 * 1024));
readSync(fd, probe, 0, probe.length, 8);
const start = probe.indexOf(0x7b);
let depth = 0, inStr = false, esc = false, end = -1;
for (let i = start; i < probe.length; i += 1) {
  const c = probe[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === 0x5c) esc = true;
    else if (c === 0x22) inStr = false;
  } else if (c === 0x22) inStr = true;
  else if (c === 0x7b) depth += 1;
  else if (c === 0x7d) { depth -= 1; if (depth === 0) { end = i; break; } }
}
const header = JSON.parse(probe.subarray(start, end + 1).toString('utf8'));
closeSync(fd);

const missing = [];
const sizeMismatch = [];
const unpackedMissing = [];
let packed = 0, unpacked = 0, bytesOnDisk = 0;

(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const abs = join(appDir, ...rel.split('/'));
    if (child.files) { walk(child, rel); continue; }
    if (!existsSync(abs)) { missing.push(rel); continue; }
    const disk = statSync(abs).size;
    bytesOnDisk += disk;
    if (child.unpacked === true) {
      unpacked += 1;
      const src = `${asar}.unpacked\\${rel.split('/').join('\\')}`;
      if (!existsSync(src)) unpackedMissing.push(rel);
    } else {
      packed += 1;
      if (disk !== Number(child.size)) sizeMismatch.push(`${rel}: disk=${disk} header=${child.size}`);
    }
  }
})(header, '');

console.log(`packed=${packed} unpacked=${unpacked} bytesOnDisk=${bytesOnDisk}`);
console.log(`missing=${missing.length} sizeMismatch=${sizeMismatch.length} unpackedSourceMissing=${unpackedMissing.length}`);
for (const m of missing.slice(0, 10)) console.log(`  MISSING ${m}`);
for (const m of sizeMismatch.slice(0, 10)) console.log(`  SIZE ${m}`);
for (const m of unpackedMissing.slice(0, 10)) console.log(`  UNPACKED-SRC ${m}`);

// 顶层条目对照：磁盘上是否多出东西
const topAsar = new Set(Object.keys(header.files));
const topDisk = new Set(readdirSync(appDir));
const extra = [...topDisk].filter((n) => !topAsar.has(n));
if (extra.length) console.log(`extra top-level on disk: ${extra.join(', ')}`);
process.exit(missing.length === 0 && sizeMismatch.length === 0 ? 0 : 1);
