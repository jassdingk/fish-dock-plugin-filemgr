// 文件读取与解析：所有路径先过白名单，再交给宿主页面渲染。
// 不发起任何网络请求，不启动子进程；纯 fs + zlib。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

// 协议单帧上限 1 MB，这里留出 JSON 包装与转义的余量：1 MB 正文编码后必然超帧，
// 会导致 SDK 拒绝发送（旧版本甚至因此 close() 自杀）。900 KB 是安全值。
export const MAX_TEXT = 800 * 1024
export const MAX_ENTRIES = 2000 // 目录列表条目上限，防止超大目录把结果撑爆协议帧
export const MAX_OFFICE = 200 * 1024 * 1024 // office/zip 是整文件读入内存，超过 200 MB 直接拒绝
export const MAX_RAW = 360 * 1024 // 单帧 base64 后约 480KB，留在 1MB 协议帧以内

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.mdown': 'text/markdown',
  '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.jsonc': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.xml': 'application/xml', '.yml': 'application/yaml', '.yaml': 'application/yaml',
  '.toml': 'application/toml', '.ini': 'text/plain', '.svg': 'image/svg+xml',
}

const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd'])
const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'htm',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat',
  'cmd', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift',
  'lua', 'pl', 'r', 'dart', 'sql', 'graphql', 'vue', 'svelte', 'diff', 'patch',
])
const TEXT_EXT = new Set(['txt', 'text', 'csv', 'tsv', 'rtf', 'srt', 'vtt', 'nfo', 'readme', 'license', 'log'])

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

export function kindOf(ext) {
  const e = String(ext || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg'].includes(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  if (['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(e)) return 'video'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(e)) return 'audio'
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(e)) return 'office'
  if (MD_EXT.has(e)) return 'markdown'
  if (e === 'html' || e === 'htm') return 'html'
  if (e === 'json') return 'json'
  if (CODE_EXT.has(e)) return 'code'
  if (TEXT_EXT.has(e)) return 'text'
  return 'unsupported'
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  if (!n) return false
  let bad = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 7 || (b > 13 && b < 32)) bad++
  }
  return bad / n > 0.3
}

function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' }
  }
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\ufffd')) return { text: utf8, encoding: 'utf8' }
  return { text: buf.toString('latin1'), encoding: 'latin1' }
}

// ---------------------------------------------------------------- 根目录白名单

function windowsDrives() {
  const out = []
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\'
    try { fs.accessSync(d); out.push({ label: d.slice(0, 1) + ':', path: d }) } catch {}
  }
  return out
}

// 打开文件夹时的默认起始位置；存在的排在最前，成为首页默认目录。
const PREFERRED = ['F:\\AI REP']

export function roots(extra = []) {
  const list = []
  const seen = new Set()
  const push = (label, p) => {
    if (!p) return
    let abs
    try { abs = path.resolve(p) } catch { return }
    const key = abs.toLowerCase()
    if (seen.has(key)) return
    try { if (!fs.statSync(abs).isDirectory()) return } catch { return }
    seen.add(key)
    list.push({ label, path: abs })
  }
  for (const dir of PREFERRED) push(dir, dir)
  for (const d of windowsDrives()) push(d.label, d.path)
  push('用户目录', os.homedir())
  push('桌面', path.join(os.homedir(), 'Desktop'))
  push('文档', path.join(os.homedir(), 'Documents'))
  push('下载', path.join(os.homedir(), 'Downloads'))
  for (const dir of extra) push(dir, dir)
  return list
}

function insideRoot(abs, list) {
  const low = abs.toLowerCase()
  return list.some(r => {
    const rl = r.path.toLowerCase()
    if (low === rl) return true
    return low.startsWith(rl.endsWith('\\') ? rl : rl + '\\')
  })
}

export function resolveSafe(input, list) {
  if (!input || typeof input !== 'string') throw new Error('缺少路径参数')
  const raw = input.trim()
  if (!raw) throw new Error('路径为空')
  if (raw.startsWith('\\\\')) throw new Error('不支持 UNC 路径')
  const abs = path.resolve(raw)
  if (!insideRoot(abs, list)) throw new Error('该路径不在允许的根目录内：' + abs)
  return abs
}

// ---------------------------------------------------------------- zip（docx/xlsx/pptx）

export function readZip(abs) {
  const buf = fs.readFileSync(abs)
  let eocd = -1
  const from = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 容器')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  function read(name) {
    const e = entries.get(name)
    if (!e) return null
    const lh = e.localOff
    if (buf.readUInt32LE(lh) !== 0x04034b50) return null
    const nameLen = buf.readUInt16LE(lh + 26)
    const extraLen = buf.readUInt16LE(lh + 28)
    const start = lh + 30 + nameLen + extraLen
    const raw = buf.subarray(start, start + e.compSize)
    if (e.method === 0) return raw
    if (e.method === 8) { try { return zlib.inflateRawSync(raw) } catch { return null } }
    return null
  }
  return { names: [...entries.keys()], read }
}

const unxml = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

function docxToBlocks(zip) {
  const xml = zip.read('word/document.xml')
  if (!xml) throw new Error('docx 里没有 word/document.xml')
  const text = xml.toString('utf8')
  const blocks = []
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  let m
  while ((m = paraRe.exec(text))) {
    const inner = m[1]
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(inner)
    let line = ''
    const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g
    let r
    while ((r = runRe.exec(inner))) {
      if (r[0] === '<w:tab/>') line += '\t'
      else if (r[0] === '<w:br/>') line += '\n'
      else line += unxml(r[1])
    }
    const s = style ? style[1] : ''
    const level = /^Heading([1-6])$/i.exec(s) || /^([1-6])$/.exec(s)
    if (level) blocks.push({ type: 'heading', level: Number(level[1]), text: line.trim() })
    else if (line.trim()) blocks.push({ type: 'para', text: line })
    else blocks.push({ type: 'gap' })
  }
  return blocks
}

function pptxToBlocks(zip) {
  const slides = zip.names
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
  const out = []
  for (const name of slides) {
    const xml = zip.read(name)
    if (!xml) continue
    const lines = []
    const re = /<a:t>([\s\S]*?)<\/a:t>/g
    let m
    while ((m = re.exec(xml.toString('utf8')))) {
      const t = unxml(m[1]).trim()
      if (t) lines.push(t)
    }
    out.push({ index: Number(/(\d+)/.exec(name)[1]), lines })
  }
  return out
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function xlsxToSheets(zip) {
  const shared = []
  const ss = zip.read('xl/sharedStrings.xml')
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>/g
    let m
    while ((m = re.exec(ss.toString('utf8')))) {
      let line = ''
      const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
      let r
      while ((r = tr.exec(m[1]))) line += unxml(r[1])
      shared.push(line)
    }
  }
  const wb = zip.read('xl/workbook.xml')
  const rels = zip.read('xl/_rels/workbook.xml.rels')
  const relMap = new Map()
  if (rels) {
    const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g
    let m
    while ((m = re.exec(rels.toString('utf8')))) relMap.set(m[1], m[2])
  }
  const meta = []
  if (wb) {
    const re = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g
    let m
    while ((m = re.exec(wb.toString('utf8')))) {
      let target = relMap.get(m[2]) || ''
      if (target.startsWith('/')) target = target.slice(1)
      else if (target && !target.startsWith('xl/')) target = 'xl/' + target
      meta.push({ name: unxml(m[1]), file: target })
    }
  }
  const valid = meta.filter(s => s.file && zip.read(s.file))
  let sheetsMeta
  if (valid.length) sheetsMeta = valid
  else {
    sheetsMeta = zip.names
      .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()
      .map(n => ({ name: n.replace(/^.*\/|\.xml$/g, ''), file: n }))
  }
  const sheets = []
  for (const m of sheetsMeta) {
    const xml = zip.read(m.file)
    if (!xml) continue
    const t = xml.toString('utf8')
    const rows = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rowRe.exec(t))) {
      const cells = []
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
      let cm
      while ((cm = cellRe.exec(rm[1]))) {
        if (cm[3] !== undefined) {
          const ref = /\br="([^"]+)"/.exec(cm[3])
          if (ref) cells[colToIndex(ref[1])] = ''
          continue
        }
        const attrs = cm[1], body = cm[2] || ''
        const ref = /\br="([^"]+)"/.exec(attrs)
        const type = /\bt="([^"]+)"/.exec(attrs)
        const idx = ref ? colToIndex(ref[1]) : cells.length
        let value = ''
        if (type && type[1] === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          if (v) value = shared[Number(v[1])] ?? ''
        } else if (type && type[1] === 'inlineStr') {
          const is = /<is>([\s\S]*?)<\/is>/.exec(body)
          if (is) {
            const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
            let r
            while ((r = tr.exec(is[1]))) value += unxml(r[1])
          }
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          if (v) value = unxml(v[1])
        }
        cells[idx] = value
      }
      if (cells.length) rows.push(Array.from(cells, c => c ?? ''))
    }
    sheets.push({ name: m.name, rows })
  }
  return sheets
}

// ---------------------------------------------------------------- 对外读取接口

async function readRange(abs, start, end) {
  const fh = await fsp.open(abs, 'r')
  try {
    const len = end - start + 1
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    return buf
  } finally { await fh.close() }
}

export async function tree(input, list) {
  const abs = resolveSafe(input, list)
  const st = await fsp.stat(abs)
  if (!st.isDirectory()) throw new Error('不是目录：' + abs)
  const dirents = await fsp.readdir(abs, { withFileTypes: true })
  const limited = dirents.length > MAX_ENTRIES
  const entries = []
  for (const d of dirents) {
    if (entries.length >= MAX_ENTRIES) break
    let isDir = d.isDirectory(), size = 0, mtime = 0
    try {
      const s = await fsp.stat(path.join(abs, d.name))
      isDir = s.isDirectory(); size = isDir ? 0 : s.size; mtime = s.mtimeMs
    } catch { continue }
    const full = path.join(abs, d.name)
    entries.push({
      name: d.name, path: full, isDir, size, mtime,
      ext: isDir ? '' : path.extname(d.name).slice(1).toLowerCase(),
    })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
  })
  const parent = path.dirname(abs)
  const atRoot = list.some(r => path.resolve(r.path).toLowerCase() === abs.toLowerCase())
  return { path: abs, parent: parent === abs || atRoot ? null : parent, entries, truncated: limited, total: dirents.length }
}

export async function meta(input, list) {
  const abs = resolveSafe(input, list)
  const s = await fsp.stat(abs)
  const isDir = s.isDirectory()
  const ext = isDir ? '' : path.extname(abs).slice(1).toLowerCase()
  return {
    name: path.basename(abs), path: abs, isDir,
    size: isDir ? 0 : s.size, mtime: s.mtimeMs, ext,
    kind: isDir ? 'dir' : kindOf(ext), mime: isDir ? '' : mimeOf(abs),
  }
}

export async function text(input, list) {
  const abs = resolveSafe(input, list)
  const st = await fsp.stat(abs)
  if (st.isDirectory()) throw new Error('这是目录，不是文件')
  const ext = path.extname(abs).slice(1).toLowerCase()
  let kind = kindOf(ext)
  const head = await readRange(abs, 0, Math.max(0, Math.min(st.size, 8192) - 1))
  if (kind === 'unsupported' && !looksBinary(head)) kind = 'text'
  if (kind === 'unsupported' || ['image', 'pdf', 'video', 'audio', 'office'].includes(kind)) {
    return { kind: kind === 'unsupported' ? 'binary' : kind, content: '', truncated: false, size: st.size, mtime: st.mtimeMs, encoding: 'binary' }
  }
  const readLen = Math.min(st.size, MAX_TEXT)
  const buf = readLen ? await readRange(abs, 0, readLen - 1) : Buffer.alloc(0)
  const { text: body, encoding } = decode(buf)
  return {
    kind, content: body, truncated: st.size > readLen, limit: MAX_TEXT,
    size: st.size, mtime: st.mtimeMs, lang: ext === 'htm' ? 'html' : ext, encoding,
  }
}

// docx 段落文本没有天然上限，一本厚教材解压后的纯文本可能几 MB。
// 超过协议帧预算前先在段落级截断，页面还能正常显示前文，而不是整条命令失败。
const BLOCK_TEXT_BUDGET = 480 * 1024
function limitBlocks(blocks) {
  let used = 0
  const out = []
  for (const b of blocks) {
    const len = (b && typeof b.text === 'string') ? b.text.length : 0
    if (used + len > BLOCK_TEXT_BUDGET) {
      out.push({ type: 'para', text: `……内容过长，后面 ${blocks.length - out.length} 段已省略（单次最多显示约 ${Math.round(BLOCK_TEXT_BUDGET / 1024)} KB 文字）` })
      return { blocks: out, truncated: true }
    }
    used += len
    out.push(b)
  }
  return { blocks: out, truncated: false }
}

export async function office(input, list) {
  const abs = resolveSafe(input, list)
  const st = await fsp.stat(abs)
  if (st.isDirectory()) throw new Error('这是目录')
  // readZip 是整文件读入内存，超大容器会直接把插件进程 OOM 掉，先挡住。
  if (st.size > MAX_OFFICE) throw new Error(`文件过大（${Math.round(st.size / 1024 / 1024)} MB），暂不支持解析`)
  const ext = path.extname(abs).slice(1).toLowerCase()
  const zip = readZip(abs)
  if (ext === 'docx') { const r = limitBlocks(docxToBlocks(zip)); return { kind: 'docx', size: st.size, mtime: st.mtimeMs, blocks: r.blocks, truncated: r.truncated } }
  if (ext === 'pptx') return { kind: 'pptx', size: st.size, mtime: st.mtimeMs, slides: pptxToBlocks(zip) }
  if (ext === 'xlsx') return { kind: 'xlsx', size: st.size, mtime: st.mtimeMs, sheets: xlsxToSheets(zip) }
  const names = zip.names.filter(n => !n.endsWith('/')).slice(0, 3000)
  return { kind: 'zip', size: st.size, mtime: st.mtimeMs, total: zip.names.length, names }
}

// 二进制分块：offset/limit 由页面控制，单块不超过 MAX_RAW
export async function rawChunk(input, list, offset = 0, limit = MAX_RAW) {
  const abs = resolveSafe(input, list)
  const st = await fsp.stat(abs)
  if (st.isDirectory()) throw new Error('这是目录，不是文件')
  const start = Math.max(0, Math.min(Number(offset) || 0, st.size))
  const len = Math.max(1, Math.min(Number(limit) || MAX_RAW, MAX_RAW, st.size - start))
  const buf = start < st.size ? await readRange(abs, start, start + len - 1) : Buffer.alloc(0)
  return {
    offset: start, size: st.size, length: buf.length,
    done: start + buf.length >= st.size,
    mime: mimeOf(abs),
    base64: buf.toString('base64'),
  }
}
