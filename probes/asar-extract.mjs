// 从 app.asar 解出完整 app 目录（含 app.asar.unpacked 里的原生文件）
// 用法：node asar-extract.mjs <app.asar> <输出目录>
// 输出目录必须不存在；解完打印文件数、字节数、unpacked 复制数。
import { openSync, readSync, closeSync, mkdirSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [asar, outDir] = process.argv.slice(2);
if (!asar || !outDir) {
  console.error('usage: node asar-extract.mjs <app.asar> <outDir>');
  process.exit(2);
}
if (existsSync(outDir)) {
  console.error(`输出目录已存在：${outDir}`);
  process.exit(2);
}

const fd = openSync(asar, 'r');
const total = statSync(asar).size;

function readAt(pos, len) {
  const buf = Buffer.allocUnsafe(Math.max(0, Math.min(len, total - pos)));
  const n = readSync(fd, buf, 0, buf.length, pos);
  return buf.subarray(0, n);
}

const head = readAt(0, 16);
const baseOffset = 8 + head.readUInt32LE(4);

// 扫头部 JSON：找第一个 '{' 后做括号配对
const probe = readAt(8, Math.min(total - 8, 64 * 1024 * 1024));
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
if (end < 0) {
  console.error('头部 JSON 未找到');
  process.exit(1);
}
const header = JSON.parse(probe.subarray(start, end + 1).toString('utf8'));

mkdirSync(outDir, { recursive: true });

let files = 0;
let bytes = 0;
let unpacked = 0;
const dirs = new Set();

function ensureDir(dir) {
  if (!dir || dirs.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  dirs.add(dir);
}

(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const abs = join(outDir, ...rel.split('/'));
    if (child.files) {
      ensureDir(abs);
      walk(child, rel);
      continue;
    }
    ensureDir(dirname(abs));
    if (child.unpacked === true) {
      const src = `${asar}.unpacked/${rel.split('/').join('\\')}`;
      if (existsSync(src)) {
        copyFileSync(src, abs);
        unpacked += 1;
      } else {
        console.error(`缺 unpacked 源：${src}`);
      }
      continue;
    }
    const size = Number(child.size);
    const offset = Number(child.offset);
    writeFileSync(abs, readAt(baseOffset + offset, size));
    files += 1;
    bytes += size;
  }
})(header, '');

closeSync(fd);
console.log(`files=${files} bytes=${bytes} unpacked=${unpacked} out=${outDir}`);
