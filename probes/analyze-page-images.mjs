// 分析已落盘的页面 HTML：找图片地址、懒加载属性、背景图、内联 JSON 里的图，以及付费/水印线索
import fs from 'node:fs';

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
console.log(`HTML ${(html.length / 1024).toFixed(1)} KB`);

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? m[1] : null;
};
const uniq = (a) => [...new Set(a.filter(Boolean))];

const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
console.log(`<img> ${imgs.length} 个`);

const pick = (names) => uniq(imgs.map((t) => names.map((n) => attr(t, n)).find(Boolean)));
const srcs = pick(['src']);
const lazies = pick(['data-src', 'data-original', 'data-lazy', 'data-echo', 'data-url']);

const show = (label, list, n = 20) => {
  console.log(`\n${label}: ${list.length} 个`);
  for (const s of list.slice(0, n)) console.log('  ' + s.slice(0, 160));
};

show('src', srcs, 12);
show('data-* 懒加载', lazies);

const bg = uniq([...html.matchAll(/url\(\s*['"]?(https?:[^)'"]+)['"]?\s*\)/gi)].map((m) => m[1]));
show('background-image', bg, 12);

const jsonUrls = uniq([...html.matchAll(/"(?:url|src|image|img|cover|thumb|preview|photo|photoUrl|imageUrl)"\s*:\s*"(https?:[^"\\]+)"/gi)].map((m) => m[1]));
show('JSON 字段里的图片', jsonUrls, 20);

// 图片域名分布
const hosts = uniq([...srcs, ...lazies, ...bg, ...jsonUrls].map((u) => { try { return new URL(u).host; } catch { return null; } }));
console.log('\n图片所在域名: ' + hosts.join(', '));

// 付费/限制线索
console.log('\n付费/限制线索命中次数:');
for (const k of ['preview', 'watermark', 'blur', 'isPaid', 'is_paid', 'purchase', 'unlock', 'needBuy', 'isBuy', 'locked', 'trial', 'sample', 'demo']) {
  const n = (html.match(new RegExp(k, 'g')) || []).length;
  if (n) console.log(`  ${k}: ${n}`);
}

// 内联 JSON（Nuxt/Next 之类）里挑出疑似作品/图片清单的键
const bigJson = [...html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]{200,200000}?)<\/script>/gi)];
console.log(`\n内联 JSON 块: ${bigJson.length} 个`);
for (const [, body] of bigJson) {
  try {
    const obj = JSON.parse(body);
    const keys = Object.keys(obj).slice(0, 12);
    console.log('  键: ' + keys.join(', '));
  } catch {
    console.log('  (无法解析，前 120 字符) ' + body.slice(0, 120).replace(/\s+/g, ' '));
  }
}
