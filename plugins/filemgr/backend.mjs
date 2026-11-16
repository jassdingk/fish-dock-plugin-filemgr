// 插件后端：把预览读取能力暴露给插件页面。
// 所有业务方法都返回 {ok:true,...} 或 {ok:false,error}，便于页面显示真实原因。
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
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
let sideW = 420
const SIDE_MIN = 140
const SIDE_MAX = 600
const SIDE_DEFAULT = 420
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

// ---- 全局文件搜索：遍历「位置」里所有根目录，按文件名匹配关键字 ----
// 宿主对单次插件调用有 15 秒硬超时，这里用 8 秒 deadline + 扫描/命中上限主动收敛，
// 并把系统/缓存等超大类目录跳过，避免全盘扫描拖死页面。
const SEARCH_HIDDEN = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.idea', '.vscode', 'target', 'dist', '.next', '.cache',
  '$RECYCLE.BIN', 'System Volume Information', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)',
  'ProgramData', 'Recovery', 'PerfLogs', '$WinREAgent', 'OneDriveTemp',
])
const MAX_DEPTH = 16
// 每个根目录单独扫描、并发推进：避免某一根（如 C:\Users 用户目录）先把总配额吃光，
// 导致其它盘（D:/E:/...）根本没扫到 —— 这正是「经常检索不到」的主因。
const PER_ROOT_SCAN = 60000
const MAX_RESULTS = 800
const MAX_SCAN_TOTAL = 400000
const SEARCH_DEADLINE_MS = 12000 // 宿主单次调用硬超时 15s，留 3s 余量

async function scanRoot(root, needle, deadline, budget) {
  const results = []
  let scanned = 0
  let truncated = false
  // 广度并发：每一层所有目录并发 readdir（分块限并发），比逐个目录 await 快得多。
  // 命中项只记路径，不在这里 stat（延迟到最终结果，见 searchFiles），避免命中多时成千上万次串行 stat。
  let queue = [{ dir: root.path, depth: 0 }]
  const CHUNK = 256
  while (queue.length) {
    if (scanned >= budget || Date.now() > deadline) { truncated = true; break }
    const next = []
    for (let i = 0; i < queue.length; i += CHUNK) {
      if (scanned >= budget || Date.now() > deadline) { truncated = true; break }
      const chunk = queue.slice(i, i + CHUNK)
      const lists = await Promise.all(chunk.map(c =>
        fs.promises.readdir(c.dir, { withFileTypes: true }).then(es => ({ c, es })).catch(() => null)))
      for (const it of lists) {
        if (!it) continue
        for (const e of it.es) {
          if (scanned >= budget || Date.now() > deadline) { truncated = true; break }
          const name = e.name
          if (!name || name.startsWith('.')) continue
          if (e.isSymbolicLink && e.isSymbolicLink()) continue
          const full = path.join(it.c.dir, name)
          scanned++
          if (e.isDirectory()) {
            if (!SEARCH_HIDDEN.has(name) && it.c.depth < MAX_DEPTH) next.push({ dir: full, depth: it.c.depth + 1 })
          } else if (name.toLowerCase().includes(needle)) {
            results.push({ name, path: full, dir: it.c.dir, root: root.label, size: 0, mtime: 0 })
          }
        }
      }
    }
    queue = next
  }
  return { results, scanned, truncated }
}

async function searchFiles(query, list) {
  const raw = String(query || '').trim()
  const needle = raw.toLowerCase()
  if (!needle) return { query: raw, results: [], scanned: 0, dirs: 0, truncated: false, timedOut: false }
  const deadline = Date.now() + SEARCH_DEADLINE_MS
  // 每个根并发，单根预算 PER_ROOT_SCAN；总体上限 MAX_SCAN_TOTAL 兜底。
  const parts = await Promise.all(list.map(r => scanRoot(r, needle, deadline, PER_ROOT_SCAN)))
  const seen = new Set()
  const all = []
  let scanned = 0
  let truncated = false
  for (const p of parts) {
    scanned += p.scanned
    if (p.truncated) truncated = true
    for (const it of p.results) {
      const key = it.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      all.push(it)
      if (all.length >= MAX_SCAN_TOTAL) { truncated = true; break }
    }
  }
  // 先按"完全匹配优先、名字短优先"排序，取前 MAX_RESULTS 条；只对这些最终结果 stat 取大小/时间（并发），
  // 避免命中成千上万时对每一条都串行 stat（这是原实现最大的慢点）。
  all.sort((a, b) => {
    const ea = a.name.toLowerCase() === needle ? 1 : 0
    const eb = b.name.toLowerCase() === needle ? 1 : 0
    if (ea !== eb) return eb - ea
    return a.name.length - b.name.length
  })
  if (all.length > MAX_RESULTS) { truncated = true }
  const results = all.slice(0, MAX_RESULTS)
  await Promise.all(results.map(async it => {
    try { const s = await fs.promises.stat(it.path); it.size = s.size; it.mtime = s.mtimeMs } catch { /* 0 兜底 */ }
  }))
  results.sort((a, b) => {
    const ea = a.name.toLowerCase() === needle ? 1 : 0
    const eb = b.name.toLowerCase() === needle ? 1 : 0
    if (ea !== eb) return eb - ea
    return (b.mtime || 0) - (a.mtime || 0)
  })
  return { query: raw, results, scanned, dirs: 0, truncated, timedOut: Date.now() > deadline, total: all.length }
}

// ---- Everything 索引搜索（优先）：调用本机 Everything 的 HTTP JSON 接口 ----
// Everything 用 NTFS USN/MFT 索引，全盘搜索是毫秒级；没装/没开则返回 null，让上层回退到 searchFiles 遍历。
// 端口优先 8090（本机已配），再试默认 80 / 8080；命中后缓存端口。
const EVERYTHING_PORTS = [8090, 80, 8080]
let everythingPort = null

function httpGetJson(url, timeoutMs) {
  return new Promise(resolve => {
    let req
    try {
      req = http.get(url, res => {
        let body = ''
        res.on('data', d => { body += d })
        res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
        res.on('error', () => resolve(null))
      })
    } catch { return resolve(null) }
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { try { req.destroy() } catch { /* ignore */ } resolve(null) })
  })
}

async function probeEverything(requireHits) {
  // 缓存端口也必须验证存活：用户可能随时关掉 Everything，不能盲信缓存否则不会触发重新拉起
  if (everythingPort) {
    const j = await httpGetJson(`http://127.0.0.1:${everythingPort}/?json=1&search=&count=1`, 1500)
    if (j && typeof j.totalResults === 'number' && (!requireHits || j.totalResults > 0)) return everythingPort
    everythingPort = null  // 已失效，清缓存，下面重新探测（必要时由 searchViaEverything 拉起）
  }
  for (const p of EVERYTHING_PORTS) {
    const j = await httpGetJson(`http://127.0.0.1:${p}/?json=1&search=&count=1`, 1500)
    if (j && typeof j.totalResults === 'number' && (!requireHits || j.totalResults > 0)) { everythingPort = p; return p }
  }
  return null
}

// 首次启用 / 用户没开 Everything 时：后台拉起主程序，不弹出窗口（-minimized + windowsHide）。
function findEverythingExe() {
  const cands = [
    process.env.EVERYTHING_EXE,
    'D:\\Everything\\Everything.exe',
    'C:\\Program Files\\Everything\\Everything.exe',
    'C:\\Program Files (x86)\\Everything\\Everything.exe',
  ]
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p } catch { /* ignore */ } }
  return null
}

function spawnEverythingBackground() {
  const exe = findEverythingExe()
  if (!exe) return false
  try {
    // -startup：按 ini 的 minimize_to_tray=1 隐藏到托盘（-minimized 只是最小化到任务栏，仍占任务栏）
    const child = spawn(exe, ['-startup'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch { return false }
}

async function waitForEverything(maxWaitMs) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const p = await probeEverything(true)  // 等到索引真的有命中，而不只是 HTTP 通了
    if (p) return p
    await new Promise(r => setTimeout(r, 800))
  }
  return null
}

function filetimeToMs(ft) {
  const n = Number(ft)
  return Number.isFinite(n) && n > 0 ? Math.round(n / 10000 - 11644473600000) : 0
}

async function searchViaEverything(query, maxResults) {
  let port = await probeEverything()
  if (!port) {
    // 首次启用 / 用户没开 Everything：后台拉起（-minimized + windowsHide，不显示窗口），最多等 10 秒索引就绪
    if (spawnEverythingBackground()) port = await waitForEverything(10000)
    if (!port) return null
  }
  // 用双引号包裹用户输入，避免 . * ? 空格等被 Everything 当作搜索语法解析
  const wrapped = '"' + String(query).replace(/"/g, '') + '"'
  const count = Math.max(1, Math.min(maxResults || 300, 1000))
  const url = `http://127.0.0.1:${port}/?json=1&search=${encodeURIComponent(wrapped)}&count=${count}&path_column=1&size_column=1&date_modified_column=1`
  const j = await httpGetJson(url, 8000)
  if (!j || !Array.isArray(j.results)) return null
  const results = j.results.map(x => {
    const parent = x.path || ''
    const full = parent ? path.join(parent, x.name || '') : (x.name || '')
    return {
      name: x.name || '', path: full, dir: parent,
      isDir: x.type === 'folder', size: Number(x.size) || 0, mtime: filetimeToMs(x.date_modified),
    }
  })
  return { query, results, total: j.totalResults || results.length, source: 'everything' }
}

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

// ── 2.3.4 子岛：单窗口多形态（#88 H6 keepAlive）──────────────────────────────
// 小球与长条现在是**同一个外部窗口**的两种形态：切换只 windows.update 几何（带
// duration/easing 补间），不关窗、不重开，所以拖入订阅、页面状态与句柄全程有效。
// 旧双窗方案（球/条各开一窗 + close/open）会闪断，且订阅随旧句柄失效。
// 位置全部声明式交给宿主：anchorBase:'capsule' 贴可见胶囊的**实时**矩形，主岛变宽、
// 收起滑出、唤回都由宿主重排（2.3.4 H7/C3），插件不自己算坐标、不轮询。
let winHandle = null
let winMode = 'ball'              // 'ball' | 'bar'
let dockStateTimer = 0            // 轮询 dock.rect() 的定时器（纯 hook 读快照，不改宿主）
// 长条高度按内容伸缩（BAR_MIN_H–BAR_MAX_H），宽度等宽胶囊、内容多时涨到 BAR_MAX_W。
let barHeight = 72
let lastModeAt = 0
const MORPH_MS = 200
const BAR_MIN_H = 72
const BAR_MAX_H = 320
const BAR_MAX_W = 720
// 球：36×36，右缘贴胶囊左缘（GAP_R=8）、垂直中心与胶囊中心对齐。
// 实测胶囊 #island-row=(694.5,8,531,36) cy=26；球 top=8、h=36 → cy=26 对齐（offsetY:0）。
const BALL_FRAME = { width: 36, height: 36,
  anchor: 'dock-left', anchorBase: 'capsule', align: 'right-center', offsetX: -7, offsetY: 0 }
// 条：等宽胶囊（maxWidth 是内容增长上限），挂胶囊正下方居中，高随内容。
function barFrame() {
  return { width: 'dock', maxWidth: BAR_MAX_W, height: barHeight,
    anchor: 'dock-bottom', anchorBase: 'capsule', align: 'top-center', offsetX: 0, offsetY: 8 }
}
// hitTest:'opaque' + 一块覆盖整窗的矩形：视觉与可点范围不变（整窗仍可点），但宿主
// 据此登记命中规则，才会把「点窗口外」的 dock outside 事件发给本插件（#88 H3）。
// ⚠️ 只在**长条展开**时启用：命中规则只要存在，宿主指针线程就从 1000ms 空闲压到
// TICK_MS=40ms 一直醒（plugin_hit::watching()），会拖慢整个 Dock（含文件管理页）。
// 小球态用 'window'（不登记规则）→ 主循环回到空闲，零开销。
const HIT_FULL = { hitTest: 'opaque', hitRects: [[0, 0, 2400, 2000]] }
const HIT_NONE = { hitTest: 'window' }
const OPEN_OPTS = { key: 'stash', page: 'stash', title: '文件暂存', ...BALL_FRAME,
  transparent: true, zOrder: 'above-dock', ...HIT_NONE }

function logWin(...args) { console.error('[filemgr]', ...args) }

async function openWindow(ctx) {
  const handle = await ctx.windows.open(OPEN_OPTS)
  winHandle = handle
  winMode = 'ball'
  // 拖入订阅跟着句柄走，**只订一次**：单窗多形态下句柄不变，切换形态不需要重订。
  try { await ctx.fileDrop.subscribe({ scope: 'window', handle }); logWin('window drop subscribe ok') }
  catch (e) { logWin('window drop subscribe err', e && e.message) }
  // 初始位置校正：首次开球时主岛胶囊可能刚上报、宽度还没稳定，会先摆到错的 x。
  // 1 秒后按当前胶囊再摆**一次**（一次性对齐，之后不跟随主岛长度变化）。
  setTimeout(() => {
    if (winHandle === handle && winMode === 'ball') {
      ctx.windows.update(handle, { offsetX: BALL_FRAME.offsetX, offsetY: BALL_FRAME.offsetY, duration: 0 }).catch(() => {})
    }
  }, 1000)
  return handle
}
// 球 ↔ 条：只改几何，不关窗。duration 让宿主把尺寸与位置一起补间（#88 H2），
// easing 展开用 ease-out-cubic、收起用 spring（带一点回弹，贴近旧产物的弹簧观感）。
async function morph(ctx, mode) {
  if (!winHandle || winMode === mode) return
  const frame = mode === 'bar' ? barFrame() : BALL_FRAME
  // 展开与收起都用 ease-out-cubic：起步快、收尾稳，没有 spring 的过冲抖动（旧实现收起用
  // spring 会先冲过头再回弹，看着“不规范”）。200ms，比 300ms 利落。
  // hitTest 随形态切换：条=opaque（登记命中规则，才能收 outside 点窗外事件）；
  // 球=window（撤销规则 → 宿主指针线程回到 1000ms 空闲，不再 40ms 常醒拖慢整个 Dock）。
  const opts = { ...frame, ...(mode === 'bar' ? HIT_FULL : HIT_NONE), duration: MORPH_MS, easing: 'ease-out-cubic' }
  try {
    await ctx.windows.update(winHandle, opts)
    winMode = mode
    lastModeAt = Date.now()
    logWin('morph ->', mode)
  } catch (e) { logWin('morph err', mode, e && e.message) }
  await syncReserve(ctx)
}

// H10：长条展开时把自身矩形登记为主岛占位 → 主岛展开高度让出 h+8、命中面并入，
// 避免长条压住主岛内容；收球即释放。rect 用主岛页面的逻辑像素（宿主按 scale 折算）。
async function syncReserve(ctx) {
  try {
    if (winMode !== 'bar') { await ctx.dock.release(); return }
    let snap = null
    try { snap = await ctx.dock.rect() } catch (_) {}
    const sf = snap && Number(snap.scale) > 0 ? Number(snap.scale) : 1
    const win = snap && snap.window, cap = snap && snap.capsule
    const rect = (win && cap)
      ? { x: (cap.x - win.x) / sf, y: (cap.y - win.y) / sf, w: cap.width / sf, h: barHeight }
      : { x: 0, y: 0, w: 1, h: barHeight }
    await ctx.dock.reserve(rect)
  } catch (e) { logWin('reserve err', e && e.message) }
}

// 主岛状态轮询（纯 hook：只读 ctx.dock.rect() 的快照，不改宿主、不依赖场景外的事件广播）。
// 目的：主灵动岛一有变化就把子岛收起——收起/隐藏/全屏避让时**关掉小球窗口**（不再留原地），
// 唤回时重新开球；主岛展开/设置/ask 时把长条收成小球。这就是旧产物 followBar=false 的口径。
// ⚠️ close/open 会销毁并**重建** WebView2（几百 ms），所以加「状态稳定」防抖：
// 同一状态连续 STABLE_TICKS 次（≈600ms）才动作，避免悬停展开/收起反复时反复重建造成卡顿。
const STABLE_TICKS = 3
let lastAwayKey = null
let stableCount = 0
let syncBusy = false      // 防重入：dock.rect/open/close 都比 250ms tick 慢，重叠会重复开窗
let waitCapsuleAt = 0     // 等主岛胶囊上报的起点（超时后不再等）
const CAPSULE_WAIT_MS = 2500
async function syncDockState(ctx) {
  if (syncBusy) return
  syncBusy = true
  try {
    const snap = await ctx.dock.rect()
    const st = snap && snap.state
    if (!st) return
    // 主岛只要不是「compact 且可见」，就把小球收起（close）——收起/唤醒/展开/设置/全屏避让都算。
    const away = !!(st.hidden || st.stowed || st.fullscreen || (st.view && st.view !== 'compact'))
    const key = away ? 'away' : 'here'
    if (key !== lastAwayKey) { lastAwayKey = key; stableCount = 0; return }   // 状态刚变，先等稳定
    if (stableCount < STABLE_TICKS) { stableCount++; return }                 // 未稳定，不动手
    if (away) {
      if (winHandle) {
        try { await ctx.windows.close(winHandle) } catch (_) {}
        winHandle = null; winMode = 'ball'
        logWin('dock-state: closed ball (dock away)')
      }
      return
    }
    if (!winHandle) {
      // 优先等主岛胶囊上报后再开球（首次就贴胶囊左缘）；但主岛可能迟迟没上报 closed_rect
      // （页面 ready 前 pet.stow 还没发），所以最多等 CAPSULE_WAIT_MS，超时就先开，
      // 位置交给 openWindow 里 1s 后的 update 校正——绝不无限等待，否则球永远不出现。
      if (!snap.capsule) {
        if (!waitCapsuleAt) waitCapsuleAt = Date.now()
        if (Date.now() - waitCapsuleAt < CAPSULE_WAIT_MS) return
      } else {
        waitCapsuleAt = 0
      }
      try {
        await openWindow(ctx)
        logWin('dock-state: opened ball' + (snap.capsule ? '' : ' (fallback: no capsule yet)'))
      } catch (_) {}
      return
    }
  } catch (e) { logWin('dock-state err', e && e.message) } finally { syncBusy = false }
}

createPlugin({
  // 宿主通过 FISH_PLUGIN_ID 传入当前包声明的 id；缺省时与 plugin.json 保持一致。
  id: process.env.FISH_PLUGIN_ID || 'jassdingk.filemgr',
  activate: async ctx => {
    context = ctx
    const config = await loadConfig()
    stash.init(() => { setImmediate(() => saveStashConfig()) })
    stash.loadFrom(config.stash)
    console.error('[filemgr] activate start')

    // 2.2.0：订阅主 Dock 拖入（独占）。
    try { await ctx.fileDrop.subscribe({ scope: 'dock' }); logWin('dock drop subscribe ok') } catch (e) { logWin('dock drop subscribe err', e && e.message) }

    // 主岛事件放**后端**：2.3.4 的页面桥只路由 dock.windows./dock.fileDrop.，
    // `FishDock.dock.*` 还走不到 plugin_dock（页面侧调用会掉进插件命令），
    // 而 host.dock.* 后端桥是通的，窗口几何本来也由后端控制。
    try {
      if (ctx.dock && typeof ctx.dock.onEvent === 'function') {
        await ctx.dock.onEvent(ev => {
          if (!ev) return
          if (ev.type === 'pointer' && ev.action === 'enter') {
            // 悬停主岛收球。点小球展开时鼠标会擦过胶囊边界触发一次 enter，用时间窗压掉竞态。
            if (winMode === 'bar' && Date.now() - lastModeAt > 1200) morph(ctx, 'ball')
          } else if (ev.type === 'outside') {
            // 点窗口外（含主岛/桌面）收起长条（#88 H3，来自 hitTest:'opaque' 的命中规则）。
            if (winMode === 'bar') morph(ctx, 'ball')
          }
        })
        logWin('dock.onEvent ok')
      }
    } catch (e) { logWin('dock.onEvent err', e && e.message) }

    // 拖入 drop → 加入暂存并展开长条。goo 吸收动画由宿主在真实落点回放（#88 H9），
    // 插件只负责数据；拖到长条自身时不重复 morph，只同步占位高度。
    try {
      if (ctx.fileDrop && typeof ctx.fileDrop.onEvent === 'function') {
        ctx.fileDrop.onEvent(async ev => {
          if (!ev || ev.phase !== 'drop' || !Array.isArray(ev.paths) || !ev.paths.length) return
          if (ev.scope !== 'dock' && ev.scope !== 'window') return
          try { await stash.add(ev.paths) } catch (_) {}
          if (winMode !== 'bar') await morph(ctx, 'bar')
          else await syncReserve(ctx)
        })
      }
    } catch (e) { logWin('fileDrop.onEvent err', e && e.message) }

    // 常驻小球：交给下面的 dock 状态轮询统一开（等胶囊上报后再开，首次位置就正确）。
    // 每 250ms 读一次主岛快照：收起→关球、唤回→开球、展开→收球（纯 hook dock.rect）
    dockStateTimer = setInterval(() => { syncDockState(ctx) }, 250)
  },
  deactivate: async () => {
    // 宿主停用/退出插件时清理后台资源，避免遗留 HTTP 拖出服务或选择对话框的脏状态。
    try { stash.closeDragOut() } catch { /* 没有活跃拖出服务时忽略 */ }
    picking.active = false
    picking.picked = null
    stashPicking.active = false
    stashPicking.picked = null
    stashPicking.paths = null
    winHandle = null
    winMode = 'ball'
    if (dockStateTimer) { clearInterval(dockStateTimer); dockStateTimer = 0 }
    await saveConfig()
  },
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

    // 全局文件搜索：有 Everything 走它的索引（秒级全盘），没有则回退 searchFiles 遍历
    'preview.search': guard(async params => {
      const q = String(params.query || '').trim()
      if (q) {
        const via = await searchViaEverything(q, 300)
        if (via) return { ...via, scanned: null, dirs: null, truncated: via.total > via.results.length, timedOut: false }
      }
      const r = await searchFiles(q, activeRoots())
      return { ...r, source: 'scan' }
    }),

    // ── stash 命令 ──────────────────────────────────────────────

    'stash.list': guard(async () => stash.list()),

    // 供“子灵动岛/桌面快捷区”使用的精简汇总：只回 count + name 等展示字段，
    // 上限/去重/排序等规则留在插件侧，宿主不用关心。
    'stash.summary': guard(async params => {
      const r = stash.list() || {}
      const all = Array.isArray(r.items) ? r.items : []
      const max = Math.max(1, Math.min(500, (params && params.max) || 200))
      const items = all.slice(0, max).map(it => ({
        id: it.id,
        name: it.name,
        kind: it.kind,
        group: it.group,
        missing: !!it.missing,
      }))
      return { count: all.length, shown: items.length, items }
    }),

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

    // 页面按钮/点击小球 → 展开长条；收起 → 收回小球（同一窗口只改几何，不关不重开）。
    'stash.showBar': guard(async () => {
      if (!winHandle) await openWindow(context)
      await morph(context, 'bar')
      return { shown: true }
    }),
    'stash.hideBar': guard(async () => { await morph(context, 'ball'); return { hidden: true } }),
    // G5：打开本插件的管理页（pages[] 里 id='main'）。
    'stash.openManager': guard(async () => { try { await context.dock.openPage('main'); return { opened: true } } catch (e) { return { opened: false, why: e && e.message } } }),
    // 长条按内容自适应：等宽胶囊（width:'dock'）+ 按换行增高，高度顶到 BAR_MAX_H 才在条内滚动。
    // 只改高度、不补间（内容多一行不需要动效），显式 duration:0 回到瞬时。
    'stash.resize': guard(async params => {
      const wantH = Number(params && params.height)
      if (!Number.isFinite(wantH)) return { resized: false }
      const height = Math.max(BAR_MIN_H, Math.min(BAR_MAX_H, Math.round(wantH)))
      if (!winHandle || winMode !== 'bar' || height === barHeight) return { resized: false }
      barHeight = height
      try { await context.windows.update(winHandle, { height, duration: 0 }) }
      catch (e) { return { resized: false, why: e && e.message } }
      await syncReserve(context)
      return { resized: true, height: barHeight }
    }),
  },
})
