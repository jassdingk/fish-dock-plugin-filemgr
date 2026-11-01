// tools/build-npm.mjs —— 生成「FISH Dock 第三方插件市场」可直接安装的 npm 发布目录 dist/npm
//
// 背景：宿主 plugin_thirdparty::obtain() 会把 npm tarball 的 package/ 前缀剥掉后，
// 要求【包根】就有 plugin.json + README.md，并且
//   files.size == manifest.files.size + 1   // 多出来的 1 个就是 plugin.json 自身
// 每个 manifest.files 条目都要 sha256 精确匹配。
// npm 又必带 package.json，所以 package.json 必须进入 manifest.files 清单。
// （已实测：npm v11 `npm pack` 不改写 package.json，sha256 前后一致，可安全登记。）
//
// 用法：先 `node tools/build.mjs` 生成 dist/filemgr，再 `node tools/build-npm.mjs <version>`；
// 之后 `npm publish dist/npm`。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve('.')
const SRC = path.join(ROOT, 'dist', 'filemgr')
const OUT = path.join(ROOT, 'dist', 'npm')

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = process.argv[2] || rootPkg.version
if (!/^\d+\.\d+\.\d+/.test(VERSION)) { console.error('✗ 需要版本号，例：node tools/build-npm.mjs 1.0.5'); process.exit(1) }

if (!fs.existsSync(SRC)) {
  console.log('· dist/filemgr 不存在，先跑 tools/build.mjs')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}

fs.rmSync(OUT, { recursive: true, force: true })
function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true })
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const a = path.join(s, e.name), b = path.join(d, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}
copyDir(SRC, OUT)

const pkg = {
  name: rootPkg.name,
  version: VERSION,
  description: rootPkg.description,
  type: 'module',
  files: ['plugin.json', 'README.md', 'bridge.js', 'plugins'],
  engines: { node: '>=18' },
  keywords: rootPkg.keywords,
  repository: rootPkg.repository,
  bugs: rootPkg.bugs,
  homepage: rootPkg.homepage,
  author: rootPkg.author,
  license: rootPkg.license,
  os: rootPkg.os,
}
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const files = {}
;(function walk(d, base = '') {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, rel)
    else { if (rel === 'plugin.json') continue; files[rel] = sha(fs.readFileSync(p)) }
  }
})(OUT)

const pj = JSON.parse(fs.readFileSync(path.join(OUT, 'plugin.json'), 'utf8'))
pj.version = VERSION
pj.files = files
fs.writeFileSync(path.join(OUT, 'plugin.json'), JSON.stringify(pj, null, 2) + '\n')

console.log(`✓ 已生成 dist/npm  版本=${VERSION}  manifest.files=${Object.keys(files).length}`)
console.log('  下一步：npm publish dist/npm')
