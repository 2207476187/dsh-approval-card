// 抓页面 HTML，抽出所有图片地址与「可能藏原图」的属性，用来判断图片被卡在哪一层
const url = process.argv[2];
const res = await fetch(url, {
  headers: {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
    referer: 'https://www.jvid.com/',
  },
});
const html = await res.text();
console.log(`HTTP ${res.status}  HTML ${(html.length / 1024).toFixed(1)} KB`);

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? m[1] : null;
};

const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
console.log(`<img> 标签 ${imgs.length} 个`);
const rows = [];
for (const tag of imgs) {
  rows.push({
    src: attr(tag, 'src'),
    dataSrc: attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy'),
    srcset: attr(tag, 'srcset'),
    cls: attr(tag, 'class'),
    alt: (attr(tag, 'alt') || '').slice(0, 20),
  });
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const srcs = uniq(rows.map((r) => r.src));
const dataSrcs = uniq(rows.map((r) => r.dataSrc));

console.log(`\n唯一 src: ${srcs.length} 个`);
for (const s of srcs.slice(0, 25)) console.log('  src   ', s.slice(0, 150));
if (dataSrcs.length) {
  console.log(`\n唯一 data-src(懒加载): ${dataSrcs.length} 个`);
  for (const s of dataSrcs.slice(0, 25)) console.log('  data  ', s.slice(0, 150));
}

// 背景图 / 行内 JSON 里出现的图片地址
const bg = uniq([...html.matchAll(/url\((['"]?)(https?:\/\/[^)'"]+)\1\)/gi)].map((m) => m[2]));
if (bg.length) {
  console.log(`\nbackground-image: ${bg.length} 个`);
  for (const s of bg.slice(0, 15)) console.log('  bg    ', s.slice(0, 150));
}

const jsonImgs = uniq([
  ...html.matchAll(/"(?:url|src|image|img|cover|thumb|preview|photo)[A-Za-z_]*"\s*:\s*"(https?:\/\/[^"]+)"/gi),
].map((m) => m[1]));
if (jsonImgs.length) {
  console.log(`\nJSON 字段里的图片地址: ${jsonImgs.length} 个`);
  for (const s of jsonImgs.slice(0, 20)) console.log('  json  ', s.slice(0, 150));
}

// 关键线索：有没有「付费/解锁/登录」相关的接口或标记
const clues = ['paywall', 'isPaid', 'unlock', 'purchase', 'needBuy', 'is_buy', 'vip', 'member', 'blur', 'watermark'];
console.log('\n付费/解锁相关关键字命中:');
for (const k of clues) {
  const n = (html.match(new RegExp(k, 'gi')) || []).length;
  if (n) console.log(`  ${k}: ${n} 次`);
}
