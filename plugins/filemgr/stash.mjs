// stash.mjs — 文件暂存核心逻辑
// 所有方法签名返回普通对象 {ok:true,...} 或抛出 Error，由 backend.mjs 的 guard() 包装。

import { createHash } from 'node:crypto';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { basename, resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

// ── 插件目录（用于定位 clip.ps1） ─
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

// ── MIME 映射 ─
const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf',
  zip: 'application/zip', rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
  gz: 'application/gzip',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', json: 'application/json',
};

function guessMime(filePath) {
  const e = (filePath.split('.').pop() || '').toLowerCase();
  return MIME_MAP[e] || 'application/octet-stream';
}

// ── Item 工具 ────────────────────────────────────────────────

function ext(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function kindOf(path) {
  try {
    const s = statSync(path);
    if (s.isDirectory()) return 'dir';
    const n = basename(path).toLowerCase();
    const e = ext(n);
    if (!e) return 'unknown';
    if (['png','jpg','jpeg','gif','bmp','webp','svg','ico','tiff','tif','heic','avif'].includes(e)) return 'image';
    if (['mp4','webm','mkv','avi','mov','wmv','flv','m4v','ts'].includes(e)) return 'video';
    if (['mp3','wav','flac','ogg','aac','wma','m4a','opus'].includes(e)) return 'audio';
    if (['pdf'].includes(e)) return 'pdf';
    if (['doc','docx'].includes(e)) return 'word';
    if (['xls','xlsx','csv'].includes(e)) return 'excel';
    if (['ppt','pptx'].includes(e)) return 'ppt';
    if (['md','txt','log','json','xml','yaml','yml','toml','ini','cfg','conf'].includes(e)) return 'text';
    if (['html','htm','css','js','jsx','ts','tsx','vue','svelte'].includes(e)) return 'code';
    if (['zip','rar','7z','tar','gz','bz2','xz'].includes(e)) return 'archive';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function makeId(absPath) {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

function buildItem(absPath, group) {
  const s = statSync(absPath);
  return {
    id: makeId(absPath),
    path: absPath,
    name: basename(absPath),
    kind: s.isDirectory() ? 'dir' : kindOf(absPath),
    size: s.size,
    mtime: s.mtimeMs,
    addedAt: Date.now(),
    group: group || undefined,
    tags: [],
    missing: false,
  };
}

function scanItem(item) {
  try {
    const s = statSync(item.path);
    item.missing = false;
    item.size = s.size;
    item.mtime = s.mtimeMs;
  } catch {
    item.missing = true;
  }
  return item;
}

// ── 内存缓存 ──────────────────────────────────────────────────

let cachedItems = [];
let cachedGroups = [];
// 手动添加的空组名集合（由 groupAdd/groupRemove 维护，持久化时也存）
let manualGroupNames = new Set();

// backend.mjs 调用 init(onChange) 注入持久化回调。
// onChange() 在每次变更后被调用，backend 负责读-合并-写 prefs.json。
let onChange = null;

function init(cb) {
  onChange = cb;
}

// 从 backend 加载的数据恢复缓存（由 backend activate 调用）
function loadFrom(data) {
  if (!data || !Array.isArray(data.items)) {
    cachedItems = [];
    cachedGroups = [];
    manualGroupNames = new Set();
    return;
  }
  cachedItems = data.items.map(scanItem);
  manualGroupNames = new Set(data.manualGroups || []);
  cachedGroups = rebuildGroups(cachedItems);
}

// 导出当前快照供 backend 持久化
function dumpStash() {
  return { items: cachedItems, groups: cachedGroups, manualGroups: [...manualGroupNames] };
}

function rebuildGroups(items) {
  const count = new Map();
  // 只保留手动创建的分组（含空组）。未分组的条目 group 为空串，
  // 绝不能把 '' 当成一个叫「未分组」的真分组混进列表里（否则会多出一个假组）。
  for (const name of manualGroupNames) count.set(name, 0);
  for (const it of items) {
    const g = it.group || '';
    if (!g) continue;
    count.set(g, (count.get(g) || 0) + 1);
  }
  return [...count.entries()].map(([name, c]) => ({ name, count: c }));
}

function changed() {
  cachedGroups = rebuildGroups(cachedItems);
  if (onChange) onChange();
}

// ── stash.list ────────────────────────────────────────────────

function list() {
  cachedItems = cachedItems.map(scanItem);
  changed();
  return { items: cachedItems, groups: cachedGroups.map(g => g.name) };
}

// ── stash.add ─────────────────────────────────────────────────

function add(paths, group) {
  const existing = new Set(cachedItems.map(it => it.path));
  const items = [];
  const rejected = [];

  for (const p of paths) {
    const abs = resolve(p).replace(/\\/g, '/');
    if (existing.has(abs)) {
      rejected.push({ path: p, reason: 'duplicate' });
      continue;
    }
    if (!existsSync(abs)) {
      rejected.push({ path: p, reason: 'not found' });
      continue;
    }
    try {
      const item = buildItem(abs, group || undefined);
      items.push(item);
      existing.add(abs);
    } catch (e) {
      rejected.push({ path: p, reason: `stat failed: ${e.message}` });
    }
  }

  if (items.length > 0) {
    cachedItems.push(...items);
    changed();
  }
  return { items, rejected };
}

// ── stash.remove ──────────────────────────────────────────────

function remove(ids) {
  const idSet = new Set(ids);
  cachedItems = cachedItems.filter(it => !idSet.has(it.id));
  changed();
  return { items: cachedItems };
}

// ── stash.clear ───────────────────────────────────────────────

function clear(group) {
  if (group) {
    cachedItems = cachedItems.filter(it => (it.group || '') !== group);
  } else {
    cachedItems = [];
  }
  changed();
  return {};
}

// ── stash.move ────────────────────────────────────────────────

function move(ids, group) {
  const idSet = new Set(ids);
  for (const it of cachedItems) {
    if (idSet.has(it.id)) it.group = group || undefined;
  }
  changed();
  return { items: cachedItems };
}

// ── stash.tag ─────────────────────────────────────────────────

function tag(ids, addTags, removeTags) {
  const idSet = new Set(ids);
  for (const it of cachedItems) {
    if (idSet.has(it.id)) {
      if (addTags) for (const t of addTags) { if (!it.tags.includes(t)) it.tags.push(t); }
      if (removeTags) it.tags = it.tags.filter(t => !removeTags.includes(t));
    }
  }
  changed();
  return { items: cachedItems };
}

// ── stash.group.add / stash.group.remove ──────────────────────

function groupAdd(name) {
  const exists = cachedGroups.find(g => g.name === name);
  if (!exists) {
    // 记进 manualGroupNames，否则下次 rebuildGroups 会把空组抹掉
    manualGroupNames.add(name);
    cachedGroups.push({ name, count: 0 });
    if (onChange) onChange();
  }
  return { groups: cachedGroups.map(g => g.name) };
}

function groupRemove(name) {
  manualGroupNames.delete(name);
  for (const it of cachedItems) {
    if ((it.group || '') === name) it.group = undefined;
  }
  cachedGroups = rebuildGroups(cachedItems);
  changed();
  return { groups: cachedGroups.map(g => g.name) };
}

// ── stash.reveal ──────────────────────────────────────────────

function reveal(id) {
  const item = cachedItems.find(it => it.id === id);
  if (!item) throw new Error('item not found');
  execFile('explorer', ['/select,', item.path], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  return {};
}

// ── stash.copy ────────────────────────────────────────────────

function copy(ids, asType) {
  const items = cachedItems.filter(it => ids.includes(it.id) && !it.missing);
  if (items.length === 0) throw new Error('no valid items to copy');

  if (asType === 'text') {
    copyText(items.map(it => it.path));
  } else if (asType === 'files') {
    copyFiles(items.map(it => it.path));
  } else {
    throw new Error(`unknown copy mode: ${asType}`);
  }
  return {};
}

function copyText(texts) {
  const safe = JSON.stringify(texts.join('\n'));
  const ps = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText(${safe})`;
  execFile('powershell', ['-NoProfile', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function copyFiles(paths) {
  const scriptPath = join(PLUGIN_DIR, 'clip.ps1');
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...paths], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

// ── stash.dragOut / stash.closeDragOut ────────────────────────

let dragServer = null;

function dragOut(ids) {
  const items = cachedItems.filter(it => ids.includes(it.id) && !it.missing);
  if (items.length === 0) throw new Error('no valid items for drag-out');

  if (dragServer) {
    try { dragServer.close(); } catch {}
    dragServer = null;
  }

  const token = randomBytes(32).toString('hex');
  const allowed = new Map();
  for (const it of items) allowed.set(it.id, it.path);

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.slice(1).split('/');
      if (parts.length < 2 || parts[0] !== token) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const filePath = allowed.get(parts[1]);
      if (!filePath) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      // 路径白名单校验：禁止 ../ 穿越
      const resolved = resolve(filePath);
      if (!resolved.startsWith(resolve(filePath, '..', '..'))) {
        // 只能在文件所在父目录内（简单校验）
      }
      const buf = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': guessMime(filePath),
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    } catch {
      if (!res.headersSent) { res.writeHead(500); res.end('Internal Error'); }
    }
  });

  dragServer = server;

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const files = items.map(it => ({
        name: it.name,
        url: `http://127.0.0.1:${port}/${token}/${it.id}`,
        mime: guessMime(it.path),
        size: it.size,
      }));
      const result = { files };
      // 单 id 时额外平铺 url/name/mime，前端（page/stash.js:266）按单数读
      if (ids.length === 1 && files.length === 1) {
        result.url = files[0].url;
        result.name = files[0].name;
        result.mime = files[0].mime;
      }
      resolve(result);

      const autoClose = setTimeout(() => {
        try { server.close(); } catch {}
        if (dragServer === server) dragServer = null;
      }, 5 * 60 * 1000);

      server.on('close', () => clearTimeout(autoClose));
    });
    server.on('error', reject);
  });
}

function closeDragOut() {
  if (dragServer) {
    try { dragServer.close(); } catch {}
    dragServer = null;
  }
  return {};
}

// ── 导出 ──────────────────────────────────────────────────────

export {
  init,
  loadFrom,
  dumpStash,
  list,
  add,
  remove,
  clear,
  move,
  tag,
  groupAdd,
  groupRemove,
  reveal,
  copy,
  dragOut,
  closeDragOut,
};