#!/usr/bin/env node
// fish-dock-filemgr —— 把「文件管理」插件装进本机 FISH Dock。
//
// 做的事和宿主「从文件安装 .fish-plugin」等价：
//   1. 校验 dist/filemgr 里每个文件的 sha256 与 plugin.json 登记值一致
//   2. 拷到 %USERPROFILE%\.fish-dock\host\packages\<id>\<version>\<整包 sha256>\
//   3. 往 host/config/installed-plugins.json 写注册条目（manifest 按宿主解析后的形状补全）
//
// 仅支持 Windows（宿主只发 windows-x86_64）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
const DEV = path.join(PKG_ROOT, 'dist', 'filemgr')
const ARCHIVE = path.join(PKG_ROOT, 'dist', 'jassdingk.filemgr.fish-plugin')

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const say = (...a) => console.log(...a)
const die = msg => { console.error(`${C.red}✗ ${msg}${C.r}`); process.exit(1) }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

const argv = process.argv.slice(2)
const has = (...names) => names.some(n => argv.includes(n))

if (has('-h', '--help')) {
  say(`
${C.b}fish-dock-filemgr${C.r} — 安装 FISH Dock「文件管理」插件

  ${C.cyan}fish-dock-filemgr${C.r}                 安装 / 升级到当前版本
  ${C.cyan}fish-dock-filemgr --path${C.r}          只打印 .fish-plugin 包路径（自行拖进宿主安装）
  ${C.cyan}fish-dock-filemgr --dry-run${C.r}       只做校验，不写磁盘
  ${C.cyan}fish-dock-filemgr --uninstall${C.r}     从注册表移除本插件

安装完成后需要 ${C.y}重启 FISH Dock${C.r} 才会加载新版本。
`)
  process.exit(0)
}

if (process.platform !== 'win32') die('本插件只支持 Windows（FISH Dock 宿主仅提供 windows-x86_64）')

if (!fs.existsSync(path.join(DEV, 'plugin.json'))) {
  die(`找不到 dist/filemgr/plugin.json。\n  这是发行包里预构建的产物；如果你是源码检出，先跑 ${C.cyan}npm run build${C.r}`)
}

const manifest = JSON.parse(fs.readFileSync(path.join(DEV, 'plugin.json'), 'utf8'))
const version = manifest.version
const HOST = path.join(os.homedir(), '.fish-dock', 'host')
const REGISTRY = path.join(HOST, 'config', 'installed-plugins.json')

if (has('--path')) {
  say(fs.existsSync(ARCHIVE) ? ARCHIVE : path.join(DEV, 'plugin.json'))
  process.exit(0)
}

// ---------- uninstall ----------
if (has('--uninstall')) {
  if (!fs.existsSync(REGISTRY)) die(`注册表不存在：${REGISTRY}\n  看起来这台机器还没装过 FISH Dock 插件。`)
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
  if (!reg.entries || !reg.entries[manifest.id]) {
    say(`${C.y}!${C.r} 注册表里没有 ${manifest.id}，无需卸载`)
    process.exit(0)
  }
  const backup = REGISTRY + '.bak-' + Date.now()
  fs.copyFileSync(REGISTRY, backup)
  delete reg.entries[manifest.id]
  const tmp = REGISTRY + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2))
  fs.renameSync(tmp, REGISTRY)
  say(`${C.g}✓${C.r} 已从注册表移除 ${C.b}${manifest.id}${C.r}`)
  say(`  ${C.dim}注册表备份 ${backup}${C.r}`)
  say(`  ${C.dim}包目录可留可删：${path.join(HOST, 'packages', manifest.id)}${C.r}`)
  say(`  ${C.y}重启 FISH Dock 后生效${C.r}`)
  process.exit(0)
}

// ---------- 校验 ----------
const declared = manifest.files || {}
const files = Object.keys(declared)
if (!files.length) die('plugin.json 里没有 files 清单，包不完整')
let bad = 0
for (const name of files) {
  const abs = path.join(DEV, name)
  if (!fs.existsSync(abs)) { console.error(`${C.red}缺失${C.r} ${name}`); bad++; continue }
  const got = sha256(fs.readFileSync(abs))
  if (got !== String(declared[name]).toLowerCase()) { console.error(`${C.red}哈希不符${C.r} ${name}\n  期望 ${declared[name]}\n  实际 ${got}`); bad++ }
}
if (bad) die(`包内文件校验失败（${bad} 个异常），已中止，未写入任何文件`)

const digest = sha256(fs.readFileSync(ARCHIVE))
say(`${C.dim}插件${C.r}   ${C.b}${manifest.id}${C.r}  ${C.cyan}v${version}${C.r}`)
say(`${C.dim}文件${C.r}   ${files.length} 个全部校验通过`)
say(`${C.dim}整包${C.r}   sha256 ${digest.slice(0, 16)}…`)

if (has('--dry-run')) { say(`\n${C.y}= dry-run，未写入磁盘 =${C.r}`); process.exit(0) }

// ---------- 拷文件 ----------
const target = path.join(HOST, 'packages', manifest.id, version, digest)
fs.mkdirSync(target, { recursive: true })
for (const name of files) {
  const dst = path.join(target, name)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(path.join(DEV, name), dst)
}
fs.copyFileSync(path.join(DEV, 'plugin.json'), path.join(target, 'plugin.json'))
say(`${C.dim}落盘${C.r}   ${target}`)

// ---------- 写注册表 ----------
// 宿主 Manifest::parse 用 serde(deny_unknown_fields) + camelCase，且 backend.args / locksSettings
// 有 serde(default)——注册表里存的是解析后的 to_value 结果，所以这两个字段要显式补上。
const full = {
  ...manifest,
  backend: { ...manifest.backend, args: manifest.backend?.args ?? [] },
  locksSettings: manifest.locksSettings ?? false,
}

const registry = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : { schema: 1, entries: {} }
registry.entries = registry.entries || {}
const previous = registry.entries[manifest.id] || null
registry.entries[manifest.id] = {
  manifest: full,
  digest,
  official: false,
  enabled: previous ? previous.enabled !== false : true,
  autostart: previous ? previous.autostart !== false : true,
}

if (fs.existsSync(REGISTRY)) {
  const backup = REGISTRY + '.bak-' + Date.now()
  fs.copyFileSync(REGISTRY, backup)
  say(`${C.dim}备份${C.r}   ${backup}`)
}
const tmp = REGISTRY + '.tmp-' + process.pid
fs.writeFileSync(tmp, JSON.stringify(registry, null, 2))
fs.renameSync(tmp, REGISTRY)

say('')
say(`${C.g}✓ 已安装${C.r} ${C.b}${manifest.id}${C.r} v${version}${previous ? '（覆盖旧版）' : ''}`)

// ---------- 提示重启 ----------
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DSH-FISH.exe', '/NH'], { encoding: 'utf8' })
if ((running.stdout || '').includes('DSH-FISH.exe')) {
  say(`${C.y}${C.b}FISH Dock 正在运行${C.r} —— 需要重启它才会加载新版本：`)
  say(`  ${C.dim}右下角托盘图标退出，或任务管理器结束 DSH-FISH.exe，然后重新打开${C.r}`)
} else {
  say(`${C.dim}打开 FISH Dock 即可在插件页看到「文件管理」${C.r}`)
}
