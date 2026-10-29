// 插件后端：把预览读取能力暴露给插件页面。
// 所有业务方法都返回 {ok:true,...} 或 {ok:false,error}，便于页面显示真实原因。
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPlugin } from './sdk.mjs'
import { roots, tree, meta, text, office, rawChunk, kindOf } from './preview.mjs'
import * as stash from './stash.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 插件进程一退出，页面就永久显示“插件尚未运行”，只能靠用户手动重新启用才能恢复。
// 所以任何漏网异常都只记日志、不让进程退出。
function logCrash(where, error) {
  try {
    const dir = process.env.FISH_PLUGIN_DATA
    if (dir) fs.appendFileSync(path.join(dir, 'crash.log'), `${new Date().toISOString()} [${where}] ${(error && error.stack) || error}\n`)
  } catch { /* 写日志失败不影响主流程 */ }
}
process.on('uncaughtException', error => logCrash('uncaughtException', error))
process.on('unhandledRejection', error => logCrash('unhandledRejection', error))

// [诊断探针] 宿主每次 spawn 本后端都会留下这行痕迹，用于判定"宿主到底有没有拉起插件"。
try {
  const fs = await import('node:fs')
  fs.appendFileSync(path.join(HERE, '_spawn-probe.log'),
    `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()} node=${process.execPath}\n`)
} catch { /* 探针失败不影响业务 */ }

// 宿主对插件方法的单次调用有 15 秒硬超时（plugin_runtime.rs:42），
// 而用户挑文件夹可能盯着一分钟。所以选择操作拆成两步：
//   preview.pickFolder  -> 立刻返回 {pending:true}，后台把对话框弹出来
//   preview.pickResult  -> 页面每 700ms 轮询一次，拿到 picked / cancelled
const picking = { active: false, picked: null, done: false, error: null, startedAt: 0 }
const stashPicking = { active: false, picked: null, done: false, error: null, startedAt: 0, paths: null }

// 弹出 Windows 原生"选择文件夹"对话框，返回选中的绝对路径；用户取消返回 null。
// 走 pick-folder.ps1 -> FolderPicker.cs（IFileOpenDialog + FOS_PICKFOLDERS），
// 与 FISH Dock 宿主 paper.rs:588 是同一个系统对话框，不是自绘的目录树。
function spawnPickFolder(initial, title) {
  if (process.platform !== 'win32') { picking.active = false; picking.done = true; picking.error = '当前系统不支持文件夹选择对话框'; return }
  const script = path.join(HERE, 'pick-folder.ps1')
  const child = spawn('powershell', [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Initial', String(initial || ''), '-Title', String(title || '选择文件夹'),
  ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  let err = ''
  const settle = (picked, error) => {
    picking.active = false
    picking.done = true
    picking.picked = picked || null
    picking.error = error || null
  }
  child.stdout.on('data', b => { out += b.toString() })
  child.stderr.on('data', b => { err += b.toString() })
  child.on('error', e => settle(null, '无法启动文件夹选择器：' + e.message))
  child.on('close', code => {
    const picked = out.trim()
    if (code === 0 && picked) settle(picked, null)
    else if (code === 0 || code === 2) settle(null, null) // 用户取消
    else settle(null, '文件夹选择器失败：' + (err.trim() || ('退出码 ' + code)))
  })
}

// stash 专用：弹出多选文件对话框
function spawnStashPickFiles(title) {
  if (process.platform !== 'win32') { stashPicking.active = false; stashPicking.done = true; stashPicking.error = '当前系统不支持文件选择对话框'; return }
  const script = path.join(HERE, 'pick-files.ps1')
  const child = spawn('powershell', [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', String(title || '选择文件'),
  ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  let err = ''
  const settle = (paths, error) => {
    stashPicking.active = false
    stashPicking.done = true
    stashPicking.paths = paths || null
    stashPicking.error = error || null
  }
  child.stdout.on('data', b => { out += b.toString() })
  child.stderr.on('data', b => { err += b.toString() })
  child.on('error', e => settle(null, '无法启动文件选择器：' + e.message))
  child.on('close', code => {
    const lines = out.trim().split(/\r?\n/).filter(Boolean)
    if (code === 0 && lines.length > 0) settle(lines, null)
    else if (code === 0 || code === 2) settle(null, null) // 用户取消
    else settle(null, '文件选择器失败：' + (err.trim() || ('退出码 ' + code)))
  })
}

// stash 专用：复用 pick-folder.ps1 弹选择文件夹对话框
function spawnStashPickFolder(initial, title) {
  if (process.platform !== 'win32') { stashPicking.active = false; stashPicking.done = true; stashPicking.error = '当前系统不支持文件夹选择对话框'; return }
  const script = path.join(HERE, 'pick-folder.ps1')
  const child = spawn('powershell', [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Initial', String(initial || ''), '-Title', String(title || '选择文件夹'),
  ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  let err = ''
  const settle = (picked, error) => {
    stashPicking.active = false
    stashPicking.done = true
    stashPicking.paths = picked ? [picked] : null
    stashPicking.error = error || null
  }
  child.stdout.on('data', b => { out += b.toString() })
  child.stderr.on('data', b => { err += b.toString() })
  child.on('error', e => settle(null, '无法启动文件夹选择器：' + e.message))
  child.on('close', code => {
    const picked = out.trim()
    if (code === 0 && picked) settle(picked, null)
    else if (code === 0 || code === 2) settle(null, null) // 用户取消
    else settle(null, '文件夹选择器失败：' + (err.trim() || ('退出码 ' + code)))
  })
}

const MAX_RECENT = 12
const MAX_FAVORITES = 12
const MAX_PINNED = 8
let context = null
let extraRoots = []
let layout = 'single'
// 上栏（文件夹窗口）高度，单位像素。拖动上下分隔条时改它，存在 prefs.json 里，下次打开还是这个高度。
let sideW = 360
const SIDE_MIN = 140
const SIDE_MAX = 600
const SIDE_DEFAULT = 360
// 非法值（NaN / 空 / 负数）一律回默认 360，只有合法数字才夹到 [140,600]。
// 注意别写成 `Number(v) || 0` —— 那样 NaN 会变 0，再被 max 抬成 140，
// 用户明明没拖过却被记成最窄。
const clampSide = value => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return SIDE_DEFAULT
  return Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, n)))
}
let recent = []
let favorites = []
let pinned = []

function ok(value) { return { ok: true, ...value } }
function fail(error) { return { ok: false, error: String((error && error.message) || error || '未知错误') } }
const FRAME_BUDGET = 900 * 1024 // 协议单帧上限 1024 KB，留出 JSON 包装余量
function guard(fn) {
  return async params => {
    try {
      const value = await fn(params || {})
      // 超限的回复会被 SDK 拒发；旧版 SDK 会随之 close()，整个插件进程退出，
      // 页面就显示“插件尚未运行”。这里统一兜底成一条普通错误，保证进程存活。
      const frame = JSON.stringify({ ok: true, ...value })
      const bytes = frame ? Buffer.byteLength(frame) : 0
      if (bytes > FRAME_BUDGET) {
        return fail(new Error(`返回内容过大（${Math.round(bytes / 1024)} KB，上限 ${Math.round(FRAME_BUDGET / 1024)} KB），已阻止发送`))
      }
      return ok(value)
    } catch (error) { return fail(error) }
  }
}

function activeRoots() { return roots(extraRoots) }

async function loadConfig() {
  const raw = await context.storage.read('config', 'prefs.json').catch(() => null)
  if (!raw) return { roots: [], layout, sideW, recent, favorites, pinned, stash: undefined }
  try {
    const row = JSON.parse(raw)
    if (Array.isArray(row.roots)) extraRoots = row.roots.filter(r => typeof r === 'string' && r.trim()).slice(0, 24)
    if (row.layout === 'double' || row.layout === 'single') layout = row.layout
    if (Number.isFinite(row.sideW)) sideW = clampSide(row.sideW)
    if (Array.isArray(row.recent)) recent = row.recent.filter(r => typeof r === 'string').slice(0, MAX_RECENT)
    if (Array.isArray(row.favorites)) favorites = row.favorites.filter(f => f && typeof f.path === 'string').slice(0, MAX_FAVORITES)
    if (Array.isArray(row.pinned)) pinned = row.pinned.filter(f => f && typeof f.path === 'string').slice(0, MAX_PINNED)
    return { roots: extraRoots, layout, sideW, recent, favorites, pinned, stash: row.stash }
  } catch { return { roots: extraRoots, layout, sideW, recent, favorites, pinned, stash: undefined } }
}

async function saveConfig() {
  try {
    const raw = await context.storage.read('config', 'prefs.json').catch(() => null)
    const prev = raw ? JSON.parse(raw) : {}
    // 合并写入：旧的 roots/layout/sideW/recent/favorites/pinned 恒定覆盖，其他字段（如 stash）保留不变
    await context.storage.write('config', 'prefs.json', JSON.stringify({
      ...prev,
      roots: extraRoots,
      layout,
      sideW,
      recent,
      favorites,
      pinned,
    })).catch(() => {})
  } catch {
    // JSON 解析失败时退化写入（丢弃损坏数据）
    await context.storage.write('config', 'prefs.json', JSON.stringify({ roots: extraRoots, layout, sideW, recent, favorites, pinned })).catch(() => {})
  }
}

async function saveStashConfig() {
  try {
    const raw = await context.storage.read('config', 'prefs.json').catch(() => null)
    const prev = raw ? JSON.parse(raw) : {}
    prev.stash = stash.dumpStash()
    await context.storage.write('config', 'prefs.json', JSON.stringify(prev)).catch(() => {})
  } catch { /* 损坏时静默跳过 */ }
}

createPlugin({
  // 宿主通过 FISH_PLUGIN_ID 传入当前包声明的 id；缺省时与 plugin.json 保持一致。
  id: process.env.FISH_PLUGIN_ID || 'jassdingk.filemgr',
  activate: async ctx => {
    context = ctx
    const config = await loadConfig()
    stash.init(() => { setImmediate(() => saveStashConfig()) })
    stash.loadFrom(config.stash)
  },
  deactivate: async () => { await saveConfig() },
  // 协议层出错只记日志，绝不设置退出码：exitCode 非 0 会让宿主直接判定插件异常退出，
  // 而 close() 之后事件循环本来就空，插件就再也起不来（页面显示“插件尚未运行”）。
  onError: error => logCrash('onError', error),
  commands: {
    // 根目录与偏好
    'preview.roots': guard(async () => ({ roots: activeRoots(), layout, sideW, recent, favorites, pinned, home: activeRoots()[0]?.path || '' })),
    'preview.layout': guard(async params => {
      if (params.layout === 'single' || params.layout === 'double') { layout = params.layout; await saveConfig() }
      return { layout }
    }),
    // 左栏宽度：拖动分隔条结束时上报一次（拖动过程只在本地改 CSS 变量，不打 IPC）。
    'preview.sideWidth': guard(async params => {
      const next = clampSide(params.width)
      if (next !== sideW) { sideW = next; await saveConfig() }
      return { sideW }
    }),
    'preview.addRoot': guard(async params => {
      const value = String(params.path || '').trim()
      if (!value) throw new Error('请填写目录路径')
      if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) throw new Error('请填写绝对路径')
      if (!extraRoots.includes(value)) extraRoots = [value, ...extraRoots].slice(0, 24)
      await saveConfig()
      return { roots: activeRoots() }
    }),
    // 弹系统原生"选择文件夹"对话框：立刻返回，后台弹窗，页面轮询 pickResult 拿结果。
    'preview.pickFolder': guard(async params => {
      if (picking.active) return { pending: true, already: true }
      picking.active = true
      picking.picked = null
      picking.done = false
      picking.error = null
      picking.startedAt = Date.now()
      spawnPickFolder(params.initial || params.path || '', params.title || '选择文件夹')
      return { pending: true }
    }),
    // 轮询选择结果：{pending:true} 仍在选；{picked} 选好了；{cancelled:true} 点了取消。
    // 注意：picking.done 为 false 而 picking.active 也为 false，说明对话框还没真正起来
    // （powershell 冷启动要 1~3 秒），这时必须继续报 pending，不能误报成 cancelled —
    // 否则页面会立刻显示"已取消"，用户以为按钮没反应，而对话框几秒后才蹦出来。
    'preview.pickResult': guard(async () => {
      if (picking.active) return { pending: true }
      if (!picking.done && picking.startedAt && Date.now() - picking.startedAt < 8000) return { pending: true }
      if (!picking.done) return { pending: false, cancelled: true }
      const row = { pending: false, error: picking.error || null }
      picking.done = false
      if (picking.error) return row
      const picked = picking.picked
      picking.picked = null
      if (!picked) return { ...row, cancelled: true }
      if (!extraRoots.includes(picked)) extraRoots = [picked, ...extraRoots].slice(0, 24)
      await saveConfig()
      return { ...row, picked, roots: activeRoots() }
    }),
    'preview.removeRoot': guard(async params => {
      const value = String(params.path || '').trim()
      extraRoots = extraRoots.filter(r => r !== value)
      await saveConfig()
      return { roots: activeRoots() }
    }),
    'preview.remember': guard(async params => {
      const value = String(params.path || '').trim()
      if (value) {
        recent = [value, ...recent.filter(r => r !== value)].slice(0, MAX_RECENT)
        await saveConfig()
      }
      return { recent }
    }),
    'preview.forget': guard(async () => { recent = []; await saveConfig(); return { recent } }),

    // 读取
    'preview.tree': guard(async params => {
      const result = await tree(params.path, activeRoots())
      // 自动记录到 favorites
      if (result && result.dir && typeof result.dir === 'string') {
        const p = result.dir
        const name = path.basename(p) || p
        const entry = { path: p, name, ts: Date.now() }
        favorites = [entry, ...favorites.filter(f => f.path !== p)].slice(0, MAX_FAVORITES)
        await saveConfig()
      }
      return result
    }),
    'preview.favorites': guard(async () => ({ favorites, pinned })),
    'preview.favRemove': guard(async params => {
      if (!params.path || typeof params.path !== 'string') throw new Error('path is required')
      favorites = favorites.filter(f => f.path !== params.path)
      pinned = pinned.filter(f => f.path !== params.path)
      await saveConfig()
      return { favorites, pinned }
    }),
    'preview.favPin': guard(async params => {
      if (!params.path || typeof params.path !== 'string') throw new Error('path is required')
      if (!params.name || typeof params.name !== 'string') throw new Error('name is required')
      const idx = pinned.findIndex(f => f.path === params.path)
      if (idx >= 0) {
        pinned.splice(idx, 1)
      } else {
        const entry = { path: params.path, name: params.name, ts: Date.now() }
        pinned = [entry, ...pinned].slice(0, MAX_PINNED)
        // 同时确保该目录在 favorites 里
        favorites = [entry, ...favorites.filter(f => f.path !== params.path)].slice(0, MAX_FAVORITES)
      }
      await saveConfig()
      return { favorites, pinned }
    }),
    'preview.meta': guard(async params => {
      const row = await meta(params.path, activeRoots())
      return { ...row, kind: row.kind }
    }),
    'preview.text': guard(async params => text(params.path, activeRoots())),
    'preview.office': guard(async params => office(params.path, activeRoots())),
    'preview.raw': guard(async params => rawChunk(params.path, activeRoots(), params.offset, params.limit)),

    // 供页面判断预览方式，不需要读文件内容
    'preview.kind': guard(async params => {
      const row = await meta(params.path, activeRoots())
      return { name: row.name, ext: row.ext, kind: row.isDir ? 'dir' : kindOf(row.ext), size: row.size, mtime: row.mtime }
    }),

    // ── stash 命令 ──────────────────────────────────────────────

    'stash.list': guard(async () => stash.list()),

    'stash.add': guard(async params => {
      if (!Array.isArray(params.paths) || params.paths.length === 0) throw new Error('paths is required')
      return stash.add(params.paths, params.group)
    }),

    'stash.remove': guard(async params => {
      if (!Array.isArray(params.ids) || params.ids.length === 0) throw new Error('ids is required')
      return stash.remove(params.ids)
    }),

    'stash.clear': guard(async params => stash.clear(params.group)),

    'stash.move': guard(async params => {
      if (!Array.isArray(params.ids) || params.ids.length === 0) throw new Error('ids is required')
      return stash.move(params.ids, params.group)
    }),

    'stash.tag': guard(async params => {
      if (!Array.isArray(params.ids) || params.ids.length === 0) throw new Error('ids is required')
      return stash.tag(params.ids, params.add, params.remove)
    }),

    'stash.group.add': guard(async params => {
      if (!params.name || typeof params.name !== 'string') throw new Error('name is required')
      return stash.groupAdd(params.name)
    }),

    'stash.group.remove': guard(async params => {
      if (!params.name || typeof params.name !== 'string') throw new Error('name is required')
      return stash.groupRemove(params.name)
    }),

    'stash.reveal': guard(async params => {
      if (!params.id) throw new Error('id is required')
      return stash.reveal(params.id)
    }),

    'stash.copy': guard(async params => {
      if (!Array.isArray(params.ids) || params.ids.length === 0) throw new Error('ids is required')
      // 前端可能传 {mode:'path'|'file'} 或 {as:'text'|'files'}，统一映射
      let asType = params.as
      if (!asType) {
        if (params.mode === 'path') asType = 'text'
        else if (params.mode === 'file') asType = 'files'
      }
      if (asType !== 'text' && asType !== 'files') throw new Error('as must be "text" or "files", or mode "path" or "file"')
      return stash.copy(params.ids, asType)
    }),

    'stash.dragOut': guard(async params => {
      // 前端可能传 {id:单个} 或 {ids:[...]}
      const ids = params.ids || (params.id ? [params.id] : [])
      if (ids.length === 0) throw new Error('ids or id is required')
      const result = await stash.dragOut(ids)
      // 单 id 时额外平铺 url/name/mime，前端 page/stash.js:266 按单数读
      if (ids.length === 1 && result.files && result.files.length === 1) {
        result.url = result.files[0].url
        result.name = result.files[0].name
        result.mime = result.files[0].mime
      }
      return result
    }),

    'stash.closeDragOut': guard(async () => stash.closeDragOut()),

    // stash 专用：弹出多选文件对话框（两步式，同 preview.pickFolder 模式）
    'stash.pickFiles': guard(async params => {
      if (stashPicking.active) return { pending: true, already: true }
      stashPicking.active = true
      stashPicking.paths = null
      stashPicking.done = false
      stashPicking.error = null
      stashPicking.startedAt = Date.now()
      spawnStashPickFiles(params.title || '选择文件')
      return { pending: true }
    }),

    // stash 专用：弹出选择文件夹对话框（两步式）
    'stash.pickFolder': guard(async params => {
      if (stashPicking.active) return { pending: true, already: true }
      stashPicking.active = true
      stashPicking.paths = null
      stashPicking.done = false
      stashPicking.error = null
      stashPicking.startedAt = Date.now()
      spawnStashPickFolder(params.path || params.initial || '', params.title || '选择文件夹')
      return { pending: true }
    }),

    // stash 专用：轮询文件/文件夹选择结果
    'stash.pickResult': guard(async () => {
      if (stashPicking.active) return { pending: true }
      if (!stashPicking.done && stashPicking.startedAt && Date.now() - stashPicking.startedAt < 8000) return { pending: true }
      if (!stashPicking.done) return { pending: false, cancelled: true }
      const row = { pending: false, error: stashPicking.error || null }
      stashPicking.done = false
      if (stashPicking.error) return row
      const paths = stashPicking.paths
      stashPicking.paths = null
      if (!paths) return { ...row, cancelled: true }
      return { ...row, paths }
    }),
  },
})
