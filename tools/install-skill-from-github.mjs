#!/usr/bin/env node
// 从 GitHub 仓库安装一个 skill 目录到 DSH 的 skills 目录。
//
// 用法：
//   node tools/install-skill-from-github.mjs <owner/repo> <远端目录> <本地名称> [选项]
//
// 选项：
//   --ref <ref>      分支/标签，默认 main
//   --dest <dir>     目标根目录，默认 %DSH_HOME%\skills
//   --dry-run        只列清单，不落盘
//   --json           只输出 JSON 摘要
//
// 行为：
//   1. 用 gh api 读 git tree，取出远端目录下全部 blob（保留相对路径）
//   2. 逐文件用 gh api raw 下载
//   3. 静态扫描可疑模式（eval/exec/rm -rf/base64 解码/管道进 shell/child_process）
//   4. 计算每个文件的 sha256，打印 SKILL.md 的短指纹
//
// 退出码：0 成功，1 参数/下载失败，2 静态扫描发现可疑内容（文件已落盘，需要人工判断）

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SUSPICIOUS = [
  { name: 'eval(', re: /\beval\s*\(/ },
  { name: 'exec(', re: /\bexec(Sync)?\s*\(/ },
  { name: 'rm -rf', re: /\brm\s+-rf?\b/ },
  { name: 'base64 decode', re: /base64\s+(-d|--decode)|FromBase64String/i },
  { name: 'pipe to shell', re: /\|\s*(bash|sh|pwsh|powershell)\b/i },
  { name: 'Invoke-Expression', re: /\bInvoke-Expression\b|\biex\s*\(/i },
  { name: 'child_process', re: /require\(['"]child_process['"]\)|from ['"]child_process['"]/ },
  { name: 'download+run', re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*\S*(sh|bash|exe)/i },
];

const TEXT_EXT = /\.(md|txt|json|ya?ml|js|mjs|cjs|ts|py|sh|ps1|cmd|bat|html|css|toml|cfg|ini)$/i;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const optValue = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };

  const [ownerRepo, remoteDir, localName] = positional;
  if (!ownerRepo || !remoteDir || !localName) {
    die('用法: node tools/install-skill-from-github.mjs <owner/repo> <远端目录> <本地名称> [--ref main] [--dest <dir>] [--dry-run] [--json]', 1);
  }

  const ref = optValue('ref', 'main');
  const dshHome = process.env.DSH_HOME ?? `${(process.env.USERPROFILE ?? '').replace(/\\/g, '/')}/.dsh`;
  const destRoot = resolve(optValue('dest', join(dshHome, 'skills')));
  const dryRun = flags.has('--dry-run');
  const jsonOnly = flags.has('--json');
  const destDir = join(destRoot, localName);
  const prefix = remoteDir.replace(/\/+$/, '') + '/';

  const log = (...a) => { if (!jsonOnly) console.log(...a); };

  // 1. 列文件
  const treeRaw = gh(['api', `repos/${ownerRepo}/git/trees/${ref}?recursive=1`]).toString('utf8');
  const tree = JSON.parse(treeRaw);
  if (!Array.isArray(tree.tree)) die(`读不到 ${ownerRepo}@${ref} 的 tree`, 1);
  const blobs = tree.tree
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path, size: e.size ?? 0, rel: e.path.slice(prefix.length) }));
  if (blobs.length === 0) die(`远端目录 ${remoteDir} 下没有文件（ref=${ref}）`, 1);

  const total = blobs.reduce((n, b) => n + b.size, 0);
  log(`仓库 ${ownerRepo}@${ref}`);
  log(`远端目录 ${remoteDir} → ${destDir}`);
  log(`文件 ${blobs.length} 个，合计 ${(total / 1024).toFixed(1)} KB`);
  for (const b of blobs) log(`  ${String(b.size).padStart(8)}  ${b.rel}`);

  if (dryRun) {
    log('（--dry-run，未写盘）');
    return;
  }

  // 2. 下载
  if (existsSync(destDir)) die(`目标目录已存在，先自行处理：${destDir}`, 1);
  mkdirSync(destDir, { recursive: true });

  const hashes = {};
  const hits = [];
  for (const b of blobs) {
    const buf = gh(['api', '-H', 'Accept: application/vnd.github.raw',
      `repos/${ownerRepo}/contents/${encodeURI(b.path).replace(/#/g, '%23')}?ref=${ref}`]);
    const target = join(destDir, b.rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
    const sha = createHash('sha256').update(buf).digest('hex');
    hashes[b.rel] = sha;
    if (TEXT_EXT.test(b.rel)) {
      const text = buf.toString('utf8');
      for (const s of SUSPICIOUS) {
        if (s.re.test(text)) hits.push({ file: b.rel, pattern: s.name });
      }
    }
  }

  const written = blobs.length;
  const skillMd = hashes['SKILL.md'];
  log(`\n已写入 ${written} 个文件到 ${destDir}`);
  if (skillMd) log(`SKILL.md sha256: ${skillMd.slice(0, 16)}…`);

  const summary = {
    repo: `${ownerRepo}@${ref}`,
    remoteDir,
    localName,
    destDir,
    files: written,
    bytes: total,
    skillMdSha256: skillMd ?? null,
    suspicious: hits,
    hashes,
  };

  if (hits.length > 0) {
    log('\n⚠ 静态扫描命中可疑模式：');
    for (const h of hits) log(`  ${h.file}: ${h.pattern}`);
    log('文件已落盘，但请人工确认后再启用。');
  } else {
    log('静态扫描：无命中。');
  }

  if (jsonOnly) console.log(JSON.stringify(summary, null, 2));
  process.exit(hits.length > 0 ? 2 : 0);
}

main();
