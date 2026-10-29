// 打包「文件管理」插件为 .fish-plugin（zip 容器），并生成可直接加载的开发目录。
// 用法：node tools/build.mjs [输出目录]
// 产物：
//   <out>/jassdingk.filemgr.fish-plugin  整包（FISH Dock「从文件安装」直接用）
//   <out>/filemgr/                       开发加载目录（含 plugin.json，指向本仓文件）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repository, 'dist')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

// 从文件安装走宿主的第三方通道：id 必须 publisher.name，publisher 不能是官方保留的 fish，
// 且 storage.directory 必须严格等于 .plugin.{publisher}.{name}
// （校验见 Wakuwaku/src-tauri/src/storage.rs:76-82）。
const PLUGIN = { key: 'filemgr', id: 'jassdingk.filemgr', name: '文件管理', directory: '.plugin.jassdingk.filemgr', capabilities: ['storage'] }

// 插件目录里除这些之外的文件一律不进包
const SKIP = name => name.includes('.test.') || name.endsWith('.cs') || name === 'stage.mjs'

// 打包清单：插件目录全部文件 + SDK 两个文件（路径 -> 包内路径）
function collect() {
  const files = new Map()
  const pluginDir = path.join(repository, 'plugins', PLUGIN.key)
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isFile() || SKIP(entry.name)) continue
    files.set(`plugins/${PLUGIN.key}/${entry.name}`, path.join(pluginDir, entry.name))
  }
  files.set('bridge.js', path.join(repository, 'sdk', 'browser', 'bridge.js'))
  files.set(`plugins/${PLUGIN.key}/sdk.mjs`, path.join(repository, 'sdk', 'node', 'plugin.mjs'))
  return files
}

function stage(out) {
  const files = collect()
  const versions = new Map()
  const manifestFiles = {}
  for (const [name, source] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bytes = fs.readFileSync(source)
    versions.set(name, bytes)
    manifestFiles[name] = sha256(bytes)
    const target = path.join(out, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  const manifest = {
    schema: 1,
    id: PLUGIN.id,
    name: PLUGIN.name,
    version: '1.0.0',
    hostApi: 1,
    platforms: ['windows-x86_64'],
    storage: { directory: PLUGIN.directory, dataSchema: 1 },
    backend: { runtime: 'node', entry: `plugins/${PLUGIN.key}/backend.mjs` },
    capabilities: PLUGIN.capabilities,
    pages: [{ id: 'main', title: PLUGIN.name, entry: `plugins/${PLUGIN.key}/page.html` }],
    files: manifestFiles,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(out, 'plugin.json'), manifestBytes)
  return { versions, manifest, manifestBytes }
}

// ---------------------------------------------------------------- 最小 zip 写入
const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = zlib.deflateRawSync(bytes, { level: 9 })
    const useDeflate = deflated.length < bytes.length
    const body = useDeflate ? deflated : bytes
    const method = useDeflate ? 8 : 0
    const crc = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

// ---------------------------------------------------------------- 执行
const devDir = path.join(outDir, PLUGIN.key)
fs.rmSync(devDir, { recursive: true, force: true })
fs.mkdirSync(devDir, { recursive: true })
const { versions, manifest, manifestBytes } = stage(devDir)

// 开发目录的 plugin.json 需要把自身也登记进去（自我引用），发行 zip 则不含
const packaged = new Map([['plugin.json', manifestBytes], ...[...versions].sort((a, b) => a[0].localeCompare(b[0]))])
const target = path.join(outDir, `${PLUGIN.id}.fish-plugin`)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(target, zip([...packaged]))

console.log(`产物 ${target}`)
console.log(`大小 ${fs.statSync(target).size} 字节`)
console.log(`整包 sha256 ${sha256(fs.readFileSync(target))}`)
console.log(`版本 ${manifest.version}，页面 ${manifest.pages[0].entry}，${Object.keys(manifest.files).length} 个文件`)
console.log(`开发目录 ${devDir}`)
