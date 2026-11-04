/**
 * Minimal reproduction for dsh-approval-gate:
 * a structured file path that contains a space is truncated at the space,
 * then classified as "outside the workspace" and escalated to a human approval.
 *
 *   node repro-gate-path-truncation.mjs                 # run inside the package repo
 *   node repro-gate-path-truncation.mjs <pkg-dir>       # or point at an installed copy
 *
 * Exit code 0 = bug reproduced, 1 = not reproduced (likely fixed upstream).
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function packageDir() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv
  // self-reference works when this file is inside the package
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('dsh-approval-gate/package.json'))
  } catch {
    return null
  }
}

const pkgDir = packageDir()
if (!pkgDir) {
  console.error('usage: node repro-gate-path-truncation.mjs <path-to-dsh-approval-gate>')
  process.exit(2)
}

const { extractAbsolutePaths, classifyPathScope, resolveRoots } = await import(
  pathToFileURL(join(pkgDir, 'src', 'paths.mjs')).href
)

// A workspace whose path contains a space — common on Windows
// ("D:\My Work", "C:\Users\me\source\repos\my app", ...).
const workspace = 'D:\\My Work'
// Exactly what a write/edit tool puts in arguments.file_path.
const filePath = 'D:\\My Work\\a.txt'

const roots = resolveRoots(workspace)

// (1) today: resolveToolCallTargets() feeds args.file_path into extractAbsolutePaths()
const structured = extractAbsolutePaths(filePath)
// (2) a quoted path inside a shell command survives — that is why only some tools break
const quoted = extractAbsolutePaths(`Set-Content '${filePath}' -Value x`)

console.log('package              :', pkgDir)
console.log('workspace            :', workspace)
console.log('arguments.file_path  :', filePath)
console.log()
console.log('extractAbsolutePaths(file_path) :', JSON.stringify(structured))
console.log('  -> scope                      :', classifyPathScope(structured, roots).scope)
console.log()
console.log('same path, quoted inside a command:')
console.log('  extract                       :', JSON.stringify(quoted.map((p) => p.raw)))
console.log('  -> scope                      :', classifyPathScope(quoted, roots).scope)
console.log()
console.log('full path, classified directly:')
console.log('  -> scope                      :', classifyPathScope([filePath], roots).scope)

const reproduced =
  structured.length === 1 &&
  structured[0].raw === 'D:\\My' &&
  classifyPathScope(structured, roots).scope === 'outside' &&
  classifyPathScope([filePath], roots).scope === 'inside'

console.log()
console.log(reproduced ? 'BUG REPRODUCED' : 'not reproduced (probably fixed)')
process.exit(reproduced ? 0 : 1)
