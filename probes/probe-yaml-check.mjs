import fs from 'node:fs';
import { createRequire } from 'node:module';

// js-yaml 装在 DSH 安装树里；ESM 不认 NODE_PATH，用 createRequire 按绝对路径加载
const req = createRequire('X:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/');
const yaml = req('js-yaml');

const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
const jsTags = (src.match(/!!js\s/g) || []).length;
src = src.replace(/!!js\s/g, ''); // 自定义标签，js-yaml 不认识，先剥掉再校验结构
const doc = yaml.load(src);

console.log('顶层是数组:', Array.isArray(doc), '  条目数:', doc.length, '  剥掉的 !!js 数:', jsTags);

const inserts = doc.filter((e) => Array.isArray(e.insert));
console.log('insert 块数:', inserts.length);
for (const block of inserts) {
  for (const item of block.insert) console.log(`  insert -> ${item.id}  =  ${item.name}`);
}

const sc = inserts.flatMap((b) => b.insert).find((i) => i.id === 'scrapling-mcp');
console.log('\nscrapling-mcp 解析结果:', JSON.stringify(sc ?? null, null, 2));
if (!sc) process.exit(2);
if (!fs.existsSync(sc.config.command)) {
  console.log('⚠️ command 指向的文件不存在:', sc.config.command);
  process.exit(3);
}
console.log('✅ command 存在');
