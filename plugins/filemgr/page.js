// 文件预览插件页面。所有内容用 DOM API 渲染，不拼 HTML 字符串。
(() => {
  'use strict'

  const $ = id => document.getElementById(id)
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key.startsWith('on')) node[key] = value
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }
  const clear = node => { while (node.firstChild) node.removeChild(node.firstChild); return node }
  const bytes = n => {
    if (!Number.isFinite(n) || n < 0) return ''
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
    return `${(n / 1073741824).toFixed(2)} GB`
  }
  const when = ms => {
    if (!ms) return ''
    const d = new Date(ms)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const extOf = name => {
    const i = String(name).lastIndexOf('.')
    return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''
  }

  const state = {
    roots: [], recent: [], layout: 'single', home: '',
    path: null, parent: null, entries: [],
    file: null, kind: '', busy: false,
    // 左栏宽度（px）。拖动分栏分隔条时改它，松手才上报给后端持久化。
    sideW: 240,
    // 常用文件夹
    favorites: [], pinned: [],
    // —— 文件暂存（filemgr 合并后新增）——
    items: [], groups: [], selected: new Set(), view: 'all', dragCache: new Map(), busy: false,
    // 外层暂存栏宽度（px），由 #fmsplit 拖动控制，持久化到 localStorage。
    stashW: 300,
    // 文件夹列表的排序与「隐藏文件」开关
    sortKey: 'name', sortDir: 1, showHidden: false,
    // 文件夹列表的多选集合（存绝对路径）。点击单行与框选都往这里写，
    // 它是临时状态，不进 prefs.json：换目录就清空。
    browseSel: new Set(),
  }

  // 默认隐藏的目录名：这些目录只会在文件浏览器里制造噪声。
  const HIDDEN_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.idea', '.vscode', 'target', 'dist', '.next', '.cache'])
  const isHiddenEntry = e => (e.name || '').startsWith('.') || (e.isDir && HIDDEN_DIRS.has(e.name))

  // 上栏高度边界，与 backend.mjs 的 SIDE_MIN / SIDE_MAX 保持一致。
  const SIDE_MIN = 140
  const SIDE_MAX = 600
  const SIDE_DEFAULT = 420

  // 把后端/宿主返回的错误规整成一句人话。后端约定返回 {ok:false,error:"文案"}，
  // 但宿主协议层错误是 {code,message} 对象（例如后端版本旧、方法不存在），
  // 直接 new Error(对象) 会退化成 "[object Object]"，用户完全看不懂。
  const text = error => {
    if (!error) return ''
    if (typeof error === 'string') return error
    if (typeof error.message === 'string' && error.message) return error.message
    if (typeof error.code === 'string') {
      if (error.code === 'UNKNOWN_METHOD') return '插件后台版本过旧，请重启 FISH Dock 让新版本代码生效'
      if (error.code === 'NOT_ACTIVE') return '插件尚未启用，请到设置页开启'
      return error.code
    }
    try { return JSON.stringify(error) } catch { return String(error) }
  }

  const call = async (method, params = {}) => {
    let row
    try {
      row = await FishDock.call(method, params)
    } catch (error) {
      // 宿主 IPC 本身失败（页面票据失效、宿主拒绝等）也统一成人话
      throw new Error(text(error) || '与插件后台通信失败')
    }
    if (!row || row.ok !== true) throw new Error(text(row && row.error) || '读取失败')
    return row
  }

  const say = message => { $('state').textContent = message || '' }
  const bad = message => { $('error').textContent = message || '' }

  // 头部标题右侧的文件元信息：有选中/预览文件时显示「名 · 修改时间」。
  // 用户要求：文件类型与大小在列表列显示，此处不再重复。
  // 仅浏览目录时清空（.fm-meta:empty 会隐藏）。
  function updateFileMeta() {
    const box = $('file-meta')
    if (!box) return
    const file = state.file
    if (!file || !file.path) { box.textContent = ''; box.removeAttribute('title'); return }
    const parts = [file.name]
    const mtime = when(file.mtime)
    if (mtime) parts.push(mtime)
    const text = parts.filter(Boolean).join(' · ')
    box.textContent = text
    if (text) box.title = file.path
    else box.removeAttribute('title')
  }

  const guard = fn => async (...args) => {
    if (state.busy) return
    state.busy = true
    bad('')
    try { await fn(...args) }
    catch (error) { bad(error && error.message ? error.message : String(error)) }
    finally { state.busy = false }
  }

  // ---------------------------------------------------------------- 侧栏

  // 文件的类型文字：目录 → 文件夹，文件 → 大写扩展名（没有扩展名就叫"文件"）。
  const typeOf = entry => {
    if (entry.isDir) return '文件夹'
    const m = /\.([^.\\/]+)$/.exec(entry.name || '')
    return m ? m[1].toUpperCase().slice(0, 8) : '文件'
  }

  // 表头：显示当前排序键与方向（▲/▼）。列宽与 .filelist .row 的 6 列保持一致。
  function drawHead() {
    const head = $('browse-head')
    if (!head) return
    head.hidden = !state.path
    for (const btn of head.querySelectorAll('button[data-sort]')) {
      const on = btn.dataset.sort === state.sortKey
      btn.classList.toggle('on', on)
      btn.dataset.dir = on ? (state.sortDir > 0 ? 'asc' : 'desc') : ''
    }
    const hb = $('browse-hidden')
    if (hb) {
      hb.classList.toggle('on', state.showHidden)
      hb.title = state.showHidden ? '当前显示隐藏项，点击回到只显示常规文件' : '隐藏以 . 开头的文件和 node_modules、dist 等目录'
    }
  }

  // 左栏 = 文件夹浏览器（双栏时）。渲染当前目录的条目，点目录进目录、点文件在右栏预览。
  function drawBrowse() {
    const crumbs = clear($('browse-crumbs'))
    if (state.path) {
      const root = state.roots.find(r => state.path.toLowerCase().startsWith(r.path.toLowerCase()))
      const base = root ? root.path : state.path
      crumbs.append(el('button', { type: 'button', onclick: guard(() => openDir(base)) }, root ? (root.label || base) : base))
      let walk = base
      for (const part of state.path.slice(base.length).split(/[\\/]/).filter(Boolean)) {
        walk = walk.replace(/[\\/]+$/, '') + '\\' + part
        crumbs.append(el('span', { text: '/' }))
        const target = walk
        crumbs.append(el('button', { type: 'button', onclick: guard(() => openDir(target)) }, part))
      }
    } else {
      crumbs.append(el('span', { text: '选择一个位置' }))
    }

    const list = clear($('browse-list'))
    // 先按「隐藏项」过滤，再按当前排序键排。目录永远排在最前面。
    const rows = state.entries.filter(e => state.showHidden || !isHiddenEntry(e)).slice()
    const dir = state.sortDir
    const key = state.sortKey
    rows.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let r = 0
      if (key === 'name') r = String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
      else if (key === 'type') r = typeOf(a).localeCompare(typeOf(b), 'zh-Hans-CN')
      else if (key === 'size') r = (a.size || 0) - (b.size || 0)
      else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0)
      if (r === 0) r = String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
      return r * dir
    })
    drawHead()
    if (!state.path) {
      list.append(el('p', { class: 'empty', text: '还没有打开文件夹' }))
    } else if (!rows.length) {
      list.append(el('p', {
        class: 'empty',
        text: state.entries.length ? '这个目录里的项都被隐藏了，点「隐藏项」查看' : '这个目录是空的',
      }))
    } else {
      if (state.parent) {
        list.append(el('button', {
          type: 'button', class: 'row dir',
          onclick: guard(() => openDir(state.parent)),
        }, [el('span', { class: 'add' }), el('span', { class: 'ni' }), el('span', { class: 'nm', text: '..' }), el('span', { class: 'st', text: '文件夹' }), el('span', { class: 'sz' }), el('span', { class: 'dt' })]))
      }
      for (const entry of rows) {
        // 当前正在预览的文件高亮，让"选中态"一眼可见
        const active = !entry.isDir && state.file && state.file.path === entry.path
        // 已在暂存区/某分组里的文件：打上归属标记，方便识别"加过没加过"。
        // 注意：暂存项里存的是 posix 斜杠（F:/x/y），目录枚举回来是反斜杠（F:\x\y），必须归一化再比。
        const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase()
        const entryKey = entry.isDir ? '' : norm(entry.path)
        const stashed = entryKey ? state.items.find(i => norm(i.path) === entryKey) : null
        {
          const stashBtn = el('span', {
            class: 'add', role: 'button', tabindex: '0',
            title: '加入暂存区', 'aria-label': '加入暂存',
            onclick: ev => { ev.stopPropagation(); guard(() => addToStash(entry.path))() },
            onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); guard(() => addToStash(entry.path))() } },
          }, '＋')
          list.append(el('button', {
            type: 'button',
            class: 'row' + (entry.isDir ? ' dir' : '') + (active ? ' active' : '') + (stashed ? ' stashed' : '') + (state.browseSel.has(entry.path) ? ' sel' : ''),
            // 框选用：把绝对路径挂在行上，框选/拖动时按 path 匹配，重绘也不会丢选择。
            dataset: { path: entry.path },
            'aria-current': active ? 'true' : 'false',
            'aria-stashed': stashed ? 'true' : 'false',
            'aria-selected': state.browseSel.has(entry.path) ? 'true' : 'false',
            title: stashed ? `${entry.path}\n已在暂存区${stashed.group ? `（分组：${stashed.group}）` : '（未分组）'}` : entry.path,
            onclick: guard(() => entry.isDir ? openDir(entry.path) : pickFile(entry.path)),
          }, [
            stashBtn,
            el('span', { class: 'ni' }),
            el('span', { class: 'nm' }, [
              el('span', { class: 'nmt', text: entry.name }),
              stashed ? el('span', { class: 'stash-badge', text: stashed.group ? `已暂存·${stashed.group}` : '已暂存' }) : null,
            ].filter(Boolean)),
            el('span', { class: 'st', text: typeOf(entry) }),
            el('span', { class: 'sz', text: entry.isDir ? '' : bytes(entry.size) }),
            el('span', { class: 'dt', text: when(entry.mtime) }),
          ].filter(Boolean)))
        }
      }
    }
    $('browse-up').disabled = !state.parent && !state.file
  }

  // 把上栏高度写进 CSS 变量 --side-h。只有双栏时 .workspace 会用它，
  // 单栏时那条规则不生效，所以这里无条件写也无害。
  function applySideHeight() {
    const height = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(state.sideW) || SIDE_DEFAULT))
    document.documentElement.style.setProperty('--side-h', `${height}px`)
    const split = $('split')
    if (split) split.setAttribute('aria-valuenow', String(height))
  }

  function drawSide() {
    document.body.dataset.layout = state.layout
    applySideHeight()
    // 必须告诉宿主当前是单栏还是双栏：宿主按 layout==='double' 才把面板放宽
    // （settings.js 里 WIDE_W），否则一律按 extension-compact 的 620px 走。
    // 高度不用管，宿主注入的 bridge 会 ResizeObserver 盯 main 自动上报。
    if (typeof FishDock !== 'undefined' && typeof FishDock.setLayout === 'function') {
      try { FishDock.setLayout(state.layout) } catch { /* 宿主注入的 bridge 不可用时忽略 */ }
    }

    const roots = clear($('roots'))
    if (!state.roots.length) roots.append(el('p', { class: 'note', text: '没有可用的根目录' }))
    for (const root of state.roots) {
      const active = state.path && state.path.toLowerCase().startsWith(root.path.toLowerCase())
      roots.append(el('button', {
        type: 'button',
        title: root.path,
        'aria-current': active ? 'true' : 'false',
        onclick: guard(() => openDir(root.path)),
      }, root.label || root.path))
    }

    const recent = clear($('recent'))
    if (!state.recent.length) recent.append(el('p', { class: 'note', text: '暂无记录' }))
    for (const item of state.recent) {
      recent.append(el('button', {
        type: 'button',
        title: item,
        onclick: guard(() => openPath(item)),
      }, item.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || item))
    }
    $('recent-clear').hidden = !state.recent.length
    $('path-line').textContent = state.file ? state.file.path : (state.path || '')
    $('path-line').title = $('path-line').textContent
    drawBrowse()
    updateFileMeta()
    updatePinBtn()
  }

  // ---------------------------------------------------------------- 面包屑

  function drawCrumbs() {
    const box = clear($('crumbs'))
    if (state.file) {
      box.append(el('button', { type: 'button', onclick: guard(() => openDir(dirOf(state.file.path))) }, '← 返回目录'))
      box.append(el('span', { text: state.file.path }))
      return
    }
    if (!state.path) {
      box.append(el('span', { text: '选择一个位置开始' }))
      return
    }
    const root = state.roots.find(r => state.path.toLowerCase().startsWith(r.path.toLowerCase()))
    const base = root ? root.path : state.path
    const parts = state.path.slice(base.length).split(/[\\/]/).filter(Boolean)
    box.append(el('button', { type: 'button', onclick: guard(() => openDir(base)) }, root ? (root.label || base) : base))
    let walk = base
    for (const part of parts) {
      walk = walk.replace(/[\\/]+$/, '') + '\\' + part
      box.append(el('span', { text: '/' }))
      const target = walk
      box.append(el('button', { type: 'button', onclick: guard(() => openDir(target)) }, part))
    }
  }

  const dirOf = p => String(p).replace(/[\\/][^\\/]*$/, '') || String(p)

  // ---------------------------------------------------------------- 常用文件夹浮层

  function drawFavPop() {
    const pinnedBox = clear($('fav-pinned'))
    const recentBox = clear($('fav-recent'))
    // 这两段默认是 hidden（HTML 里写死的），有内容时必须显式打开，
    // 否则 fixed 项渲染进去了却一直看不见。
    pinnedBox.hidden = !state.pinned.length
    recentBox.hidden = false
    // pinned 段
    if (state.pinned.length) {
      const label = el('div', { class: 'fav-label', text: '固定' })
      pinnedBox.append(label)
      for (const f of state.pinned) {
        pinnedBox.append(favItem(f, true))
      }
    }
    // 「最近」段：数据源必须是 state.recent（浏览过的目录，字符串数组），
    // 不是 state.favorites（手动固定的收藏，对象数组）——用错数据源会让
    // 从没固定过任何东西的人永远只看到一句「浏览过的文件夹会出现在这里」。
    const pinnedPaths = new Set(state.pinned.map(p => p.path))
    const recentOnly = state.recent
      .filter(p => !pinnedPaths.has(p))
      .map(p => ({ path: p, name: String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p }))
    if (recentOnly.length) {
      const label = el('div', { class: 'fav-label', text: '最近' })
      recentBox.append(label)
      for (const f of recentOnly) {
        recentBox.append(favItem(f, false))
      }
    }
    if (!state.pinned.length && !recentOnly.length) {
      recentBox.append(el('div', { class: 'fav-label', text: '浏览过的文件夹会出现在这里' }))
    }
  }

  function favItem(f, isPinned) {
    // 注意：el 只接受 (tag, props, children) 三个参数，多传的会被静默丢弃。
    // 这里必须把所有子节点包成一个数组，否则整行只剩一个空按钮（名字/删除键全没）。
    return el('button', { type: 'button', class: 'fav-item', title: f.path,
      onclick: guard(async () => { $('fav-pop').hidden = true; await openDir(f.path) }) },
      [
        isPinned ? el('span', { class: 'fav-pin', text: '📌' }) : null,
        el('span', { class: 'fav-name', text: f.name || f.path }),
        el('span', { class: 'fav-del', text: '✕', title: '从列表中移除',
          onclick(event) { event.stopPropagation(); guard(() => removeFav(f.path))() } }),
      ].filter(Boolean))
  }

  async function removeFav(target) {
    await call('preview.favRemove', { path: target })
    state.favorites = state.favorites.filter(f => f.path !== target)
    state.pinned = state.pinned.filter(f => f.path !== target)
    drawFavPop()
    updatePinBtn()
  }

  function updatePinBtn() {
    const btn = $('fav-pin-btn')
    if (!btn) return
    const curPath = state.path
    if (!curPath) { btn.hidden = true; return }
    const isPinned = state.pinned.some(p => p.path === curPath)
    btn.textContent = isPinned ? '📌' : '📌'
    btn.style.opacity = isPinned ? '1' : '.4'
    btn.title = isPinned ? '取消固定' : '固定当前文件夹'
    btn.hidden = false
  }

  async function togglePin() {
    const curPath = state.path
    if (!curPath) return
    // backend 的 preview.favPin 自动确保该目录在 favorites 里
    const name = curPath.split(/[\\/]/).pop() || curPath
    await call('preview.favPin', { path: curPath, name })
    const row = await call('preview.favorites')
    state.favorites = row.favorites
    state.pinned = row.pinned
    drawFavPop()
    updatePinBtn()
  }

  // ---------------------------------------------------------------- 目录视图

  // 单栏时目录列表画在右栏（无左栏可用）；双栏时左栏已经是文件夹浏览器，
  // 右栏专做预览窗口 —— 这时目录列表不再重复渲染，只提示去左栏选文件。
  function drawDir() {
    const view = clear($('view'))
    if (state.layout === 'double') {
      view.append(el('div', { class: 'hint' }, [
        el('h3', { text: state.path || '已打开文件夹' }),
        el('p', { text: `${state.entries.filter(e => e.isDir).length} 个目录，${state.entries.filter(e => !e.isDir).length} 个文件` }),
        el('p', { text: state.dirTrunc ? `目录太大，只列出前 ${state.entries.length} 项（共 ${state.dirTotal} 项）。` : '在左侧列表里点一个文件，这里就会显示它的预览。' }),
      ]))
      return
    }
    if (!state.entries.length) {
      view.append(el('p', { class: 'empty', text: '这个目录是空的' }))
      return
    }
    const list = el('div', { class: 'filelist' })
    if (state.parent) {
      list.append(el('button', {
        type: 'button', class: 'row dir',
        onclick: guard(() => openDir(state.parent)),
      }, [el('span', { class: 'nm', text: '..' }), el('span', { class: 'sz' }), el('span', { class: 'dt' })]))
    }
    for (const entry of state.entries) {
      const stashBtn = el('span', {
        class: 'stash-add', role: 'button', tabindex: '0',
        title: '加入暂存区', 'aria-label': '加入暂存',
        onclick: ev => { ev.stopPropagation(); guard(() => addToStash(entry.path))() },
        onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); guard(() => addToStash(entry.path))() } },
      }, '＋暂存')
      const row = el('button', {
        type: 'button',
        class: 'row' + (entry.isDir ? ' dir' : ''),
        title: entry.path,
        onclick: guard(() => entry.isDir ? openDir(entry.path) : openFile(entry.path)),
      }, [
        el('span', { class: 'nm', text: entry.name }),
        el('span', { class: 'sz', text: entry.isDir ? '' : bytes(entry.size) }),
        el('span', { class: 'dt', text: when(entry.mtime) }),
        stashBtn,
      ])
      list.append(row)
    }
    view.append(list)
    view.append(el('p', {
      class: 'note',
      text: `${state.entries.filter(e => e.isDir).length} 个目录，${state.entries.filter(e => !e.isDir).length} 个文件`,
    }))
    updateFileMeta()
  }

  // ---------------------------------------------------------------- 预览分发

  function head(title, badge, extra = []) {
    return el('div', { class: 'preview-head' }, [
      el('h2', { text: title }),
      badge ? el('span', { class: 'badge', text: badge }) : null,
      ...extra,
    ])
  }

  function fallback(title, badge, lines, path) {
    const box = el('div', { class: 'hint' }, [
      el('h3', { text: title }),
      ...lines.map(text => el('p', { text })),
      el('p', { text: path }),
    ])
    return box
  }

  // ---------------------------------------------------------------- 布局

  // 切到双栏：左栏文件夹浏览器 + 右栏预览窗口。layout 持久化由后端负责。
  async function gotoDouble() {
    if (state.layout === 'double') return
    state.layout = 'double'
    document.body.dataset.layout = 'double'
    await call('preview.layout', { layout: 'double' }).catch(() => null)
    drawSide()
  }

  // 用户主动点「打开文件夹」后：自动进双栏，并把左栏定位到该文件夹、
  // 右栏清空等待选文件。这是「打开文件夹 → 自动双栏」的核心。
  async function openFolderAuto(target) {
    // 先切布局再进目录：这样 openDir 内的 drawDir 一次就画成双栏形态，
    // 不会先渲染一版单栏目录列表再被覆盖。
    if (state.layout !== 'double') {
      state.layout = 'double'
      document.body.dataset.layout = 'double'
      await call('preview.layout', { layout: 'double' }).catch(() => null)
    }
    await openDir(target)
    say('已打开文件夹，在左侧点文件即可预览')
  }

  async function openDir(target) {
    const row = await call('preview.tree', { path: target })
    state.path = row.path
    state.parent = row.parent
    state.entries = row.entries
    state.dirTotal = row.total || row.entries.length
    state.dirTrunc = !!row.truncated
    state.file = null
    state.kind = ''
    // 换目录就清空多选：框选的是「这一屏的若干项」，跨目录保留会让人误以为
    // 上一次选中的还在（而且路径已经不在列表里，后续批量操作会很难解释）。
    state.browseSel.clear()
    say(row.truncated ? `${row.entries.length} 项（共 ${row.total} 项，已截断）` : `${row.entries.length} 项`)
    // 打开目录也要写进「最近」——原来只有 openFile() 记，导致只浏览文件夹、
    // 从不打开文件的人点 ★ 永远是空的（这正是「常用文件夹不生效」的主因）。
    const recentRow = await call('preview.remember', { path: row.path }).catch(() => null)
    if (recentRow) state.recent = recentRow.recent || state.recent
    drawSide(); drawCrumbs(); drawDir()
    // 刷新常用文件夹浮层 + pin 按钮状态
    if ($('fav-pop') && !$('fav-pop').hidden) drawFavPop()
    updatePinBtn()
  }

  // 左栏点文件：双栏时只换右侧预览，左栏目录纹丝不动；单栏走整页切换。
  async function pickFile(target) {
    if (state.layout !== 'double') return openFile(target)
    const row = await call('preview.meta', { path: target })
    if (row.isDir) return openDir(row.path)
    return openFile(row.path)
  }

  async function openPath(target) {
    const row = await call('preview.meta', { path: target })
    if (row.isDir) return openDir(row.path)
    return openFile(row.path)
  }

  async function openFile(target) {
    const row = await call('preview.meta', { path: target })
    if (row.isDir) return openDir(row.path)
    state.file = row
    // 双栏：左栏是文件夹浏览器，预览文件时不能把它的目录列表清掉。
    // 单栏没有左栏，保持原来「目录视图 → 文件视图」的整页切换。
    if (state.layout === 'double' && state.entries.length &&
        dirOf(state.path || '').toLowerCase() === dirOf(row.path).toLowerCase()) {
      // 同一个目录里换文件：只高亮 + 换右栏，不动左栏
    } else {
      state.path = dirOf(row.path)
      state.entries = []
      // 双栏时左栏必须始终有内容，否则从「最近」跳到别处的文件后左栏会变空。
      if (state.layout === 'double') {
        const treeRow = await call('preview.tree', { path: state.path }).catch(() => null)
        if (treeRow) { state.parent = treeRow.parent; state.entries = treeRow.entries }
      }
    }
    state.kind = row.kind
    say(`${row.ext || '未知'} · ${bytes(row.size)}`)
    drawSide(); drawCrumbs(); updateFileMeta()
    const recentRow = await call('preview.remember', { path: row.path }).catch(() => null)
    if (recentRow) { state.recent = recentRow.recent; drawSide() }
    const view = clear($('view'))
    view.append(el('p', { role: 'status', text: `正在读取 ${row.name}…` }))
    const badge = `${row.ext || '未知'} · ${bytes(row.size)} · ${when(row.mtime)}`
    try {
      await render(row, view, badge)
    } catch (error) {
      clear(view).append(head(row.name, badge), fallback(
        '无法预览这个文件',
        '',
        [error && error.message ? error.message : String(error), '文件本身可能损坏，或格式暂不支持。'],
        row.path,
      ))
    }
  }

  async function render(row, view, badge) {
    switch (row.kind) {
      case 'markdown': return renderText(row, view, badge, true)
      case 'code':
      case 'json':
      case 'text':
      case 'html': return renderText(row, view, badge, false)
      case 'image': return renderImage(row, view, badge)
      case 'office': return renderOffice(row, view, badge)
      case 'pdf': return renderPdf(row, view, badge)
      case 'video':
      case 'audio': return renderMedia(row, view, badge)
      default: return renderBinary(row, view, badge)
    }
  }

  // ---------------------------------------------------------------- 文本 / 代码 / markdown

  async function renderText(row, view, badge, markdown) {
    const data = await call('preview.text', { path: row.path })
    clear(view)
    view.append(head(row.name, badge + (data.truncated ? ' · 已截断' : '')))
    if (markdown) {
      const box = el('div', { class: 'md' })
      renderMarkdown(data.content, box, dirOf(row.path))
      view.append(box)
    } else {
      view.append(codeBlock(data.content))
    }
    if (data.truncated) view.append(el('p', { class: 'note', text: `文件较大，只显示前 ${Math.round((data.limit || 819200) / 1024)} KB 内容。` }))
    view.append(footer(row.path))
  }

  function codeBlock(source) {
    const lines = String(source).split('\n')
    const pre = el('pre', { class: 'body' })
    const limit = Math.min(lines.length, 8000)
    const frag = document.createDocumentFragment()
    for (let i = 0; i < limit; i++) {
      frag.append(el('span', { class: 'ln', text: String(i + 1) }))
      frag.append(document.createTextNode(lines[i] + '\n'))
    }
    pre.append(frag)
    const wrap = el('div')
    wrap.append(pre)
    if (lines.length > limit) wrap.append(el('p', { class: 'note', text: `共 ${lines.length} 行，只显示前 ${limit} 行。` }))
    return wrap
  }

  // ---------------------------------------------------------------- markdown

  function renderMarkdown(source, box, baseDir) {
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
    let i = 0
    const pendingImages = []
    while (i < lines.length) {
      const line = lines[i]
      const fence = /^\s*(```+|~~~+)\s*([\w+#-]*)\s*$/.exec(line)
      if (fence) {
        const marker = fence[1][0].repeat(3)
        const body = []
        i++
        while (i < lines.length && !new RegExp('^\\s*' + marker).test(lines[i])) { body.push(lines[i]); i++ }
        i++
        const pre = el('pre')
        pre.append(el('code', { text: body.join('\n') }))
        box.append(pre)
        continue
      }
      const atx = /^(#{1,6})\s+(.*)$/.exec(line)
      if (atx) {
        box.append(el('h' + atx[1].length, {}, inline(atx[2].trim())))
        i++; continue
      }
      if (/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*$/.test(line)) { box.append(el('hr')); i++; continue }
      if (/^\s*>/.test(line)) {
        const body = []
        while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
        const quote = el('blockquote')
        renderMarkdown(body.join('\n'), quote, baseDir)
        box.append(quote); continue
      }
      if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
        const cell = t => t.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim())
        const head = cell(lines[i])
        i += 2
        const table = el('table')
        const thead = el('thead')
        const tr = el('tr')
        for (const h of head) tr.append(el('th', {}, inline(h)))
        thead.append(tr); table.append(thead)
        const tbody = el('tbody')
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          const row = el('tr')
          for (const c of cell(lines[i])) row.append(el('td', {}, inline(c)))
          tbody.append(row); i++
        }
        table.append(tbody); box.append(table)
        continue
      }
      const ul = /^\s*([-*+])\s+(.*)$/.exec(line)
      const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
      if (ul || ol) {
        const ordered = Boolean(ol)
        const list = el(ordered ? 'ol' : 'ul')
        while (i < lines.length) {
          const m = ordered ? /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i]) : /^\s*([-*+])\s+(.*)$/.exec(lines[i])
          if (!m) break
          let body = m[2]
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(body)
          let item
          if (task) {
            item = el('li', { class: 'task' }, [task[1].toLowerCase() === 'x' ? '☑ ' : '☐ ', ...inline(task[2])])
          } else {
            item = el('li', {}, inline(body))
          }
          list.append(item)
          i++
        }
        box.append(list)
        continue
      }
      if (!line.trim()) { i++; continue }
      const para = []
      while (i < lines.length && lines[i].trim() && !/^(\s*(```+|~~~+)|#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) {
        para.push(lines[i]); i++
      }
      if (!para.length) para.push(lines[i++])
      box.append(el('p', {}, inline(para.join('\n'))))
    }
    // 异步补齐相对路径图片
    for (const job of pendingImages) void job()
    return box

    function inline(text) {
      const nodes = []
      const pattern = /(`[^`]+`)|(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))|(\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)/g
      let last = 0, m
      while ((m = pattern.exec(text))) {
        if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)))
        const token = m[0]
        if (m[1]) nodes.push(el('code', { text: token.slice(1, -1) }))
        else if (m[2]) {
          const alt = /^!\[([^\]]*)\]/.exec(token)[1]
          const src = /\(([^)\s]+)/.exec(token)[1]
          const img = el('img', { alt, src: '', title: src })
          nodes.push(img)
          const resolve = async () => {
            const rel = src.replace(/^\.\//, '')
            if (/^[a-z]+:/i.test(rel) || rel.startsWith('//') || rel.startsWith('#')) {
              if (/^data:/i.test(rel)) img.src = rel
              return
            }
            const target = joinPath(baseDir, decodeURI(rel))
            try {
              const data = await loadDataUrl(target)
              img.src = data
            } catch { /* 图片缺失时保留 alt 文本 */ }
          }
          pendingImages.push(resolve)
          if (alt) nodes.push(document.createTextNode(alt))
        } else if (m[3]) {
          const label = /^\[([^\]]*)\]/.exec(token)[1]
          const href = /\(([^)\s]+)/.exec(token)[1]
          const a = el('a', { href: '#', title: href }, label || href)
          a.onclick = event => { event.preventDefault() }
          nodes.push(a)
        } else if (m[4]) nodes.push(el('strong', { text: token.slice(2, -2) }))
        else if (m[5]) nodes.push(el('em', { text: token.slice(1, -1) }))
        else if (m[6]) nodes.push(el('s', { text: token.slice(2, -2) }))
        last = m.index + token.length
      }
      if (last < text.length) nodes.push(document.createTextNode(text.slice(last)))
      return nodes
    }
  }

  function joinPath(dir, name) {
    const parts = String(name).split(/[\\/]/)
    let base = String(dir).replace(/[\\/]+$/, '')
    for (const part of parts) {
      if (!part || part === '.') continue
      if (part === '..') base = dirOf(base)
      else base = base + '\\' + part
    }
    return base
  }

  // ---------------------------------------------------------------- 二进制 → data URL

  const CHUNK = 360 * 1024

  async function loadDataUrl(target) {
    const meta = await call('preview.meta', { path: target })
    if (meta.size > 24 * 1024 * 1024) throw new Error('图片超过 24 MB，不做内联预览')
    const chunks = []
    let offset = 0
    for (let guardCount = 0; guardCount < 200; guardCount++) {
      const row = await call('preview.raw', { path: target, offset, limit: CHUNK })
      chunks.push(row.base64)
      offset += row.length
      if (row.done || !row.length) break
    }
    const base64 = chunks.join('')
    return `data:${meta.mime || 'application/octet-stream'};base64,${base64}`
  }

  // ---------------------------------------------------------------- 各类预览

  async function renderImage(row, view, badge) {
    const url = await loadDataUrl(row.path)
    clear(view)
    view.append(head(row.name, badge))
    const figure = el('div', { class: 'figure' })
    const img = el('img', {
      alt: row.name, src: url, title: '点击放大查看大图',
      class: 'zoomable',
      onclick: () => openLightbox(url, row.name),
    })
    figure.append(img)
    figure.append(el('span', { class: 'meta', text: `${row.ext.toUpperCase()} · ${bytes(row.size)} · 点击图片可放大查看` }))
    view.append(figure)
    view.append(footer(row.path))
  }

  // ---------------------------------------------------------------- 图片放大查看（灯箱）
  // 点击预览区图片 → 全屏灯箱：滚轮缩放、拖动平移、双击 1:1/适应切换、Esc 或点背景关闭。
  let lb = null // { root, img, scale, fit, tx, ty, dragging, sx, sy, ox, oy }
  function ensureLightbox() {
    if (lb) return lb
    const img = el('img', { class: 'lb-img', alt: '' })
    const tip = el('span', { class: 'lb-tip', text: '滚轮缩放 · 拖动平移 · 双击 1:1/适应 · Esc 关闭' })
    const zoomOut = el('button', { class: 'lb-btn', type: 'button', title: '缩小', text: '−' })
    const zoomIn = el('button', { class: 'lb-btn', type: 'button', title: '放大', text: '＋' })
    const fitBtn = el('button', { class: 'lb-btn wide', type: 'button', title: '适应窗口', text: '适应' })
    const realBtn = el('button', { class: 'lb-btn wide', type: 'button', title: '原始大小(1:1)', text: '1:1' })
    const closeBtn = el('button', { class: 'lb-btn wide close', type: 'button', title: '关闭(Esc)', text: '关闭' })
    const bar = el('div', { class: 'lb-bar' }, [zoomOut, zoomIn, fitBtn, realBtn, closeBtn])
    const stage = el('div', { class: 'lb-stage' }, [img])
    const root = el('div', { class: 'lb-overlay', hidden: true }, [stage, bar, tip])
    document.body.append(root)
    const state = { root, img, scale: 1, fit: true, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 }

    const apply = () => {
      if (state.fit) { img.style.transform = ''; img.style.maxWidth = '96vw'; img.style.maxHeight = '86vh'; img.style.cursor = 'zoom-in' }
      else {
        img.style.maxWidth = 'none'; img.style.maxHeight = 'none'
        img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`
        img.style.cursor = state.dragging ? 'grabbing' : 'grab'
      }
    }
    const setFit = () => { state.fit = true; state.scale = 1; state.tx = 0; state.ty = 0; apply() }
    const zoomAt = (factor, cx, cy) => {
      if (state.fit) { state.fit = false; state.scale = 1 }
      const next = Math.min(16, Math.max(0.05, state.scale * factor))
      // 以光标为中心缩放：调整平移让命中点保持不动
      const k = next / state.scale
      state.tx = cx - k * (cx - state.tx)
      state.ty = cy - k * (cy - state.ty)
      state.scale = next
      apply()
    }
    const close = () => { root.hidden = true; state.dragging = false }
    state.close = close
    state.setFit = setFit
    state.setReal = () => { state.fit = false; state.scale = 1; state.tx = 0; state.ty = 0; apply() }

    closeBtn.onclick = close
    fitBtn.onclick = setFit
    realBtn.onclick = state.setReal
    zoomIn.onclick = () => zoomAt(1.25, stage.clientWidth / 2, stage.clientHeight / 2)
    zoomOut.onclick = () => zoomAt(0.8, stage.clientWidth / 2, stage.clientHeight / 2)
    root.addEventListener('click', ev => { if (ev.target === root || ev.target === stage) close() })
    img.addEventListener('dblclick', ev => { ev.preventDefault(); if (state.fit) state.setReal(); else setFit() })
    img.addEventListener('mousedown', ev => {
      if (state.fit) return
      ev.preventDefault(); state.dragging = true; state.sx = ev.clientX; state.sy = ev.clientY; state.ox = state.tx; state.oy = state.ty; apply()
    })
    window.addEventListener('mousemove', ev => {
      if (!state.dragging) return
      state.tx = state.ox + (ev.clientX - state.sx); state.ty = state.oy + (ev.clientY - state.sy); apply()
    })
    window.addEventListener('mouseup', () => { if (state.dragging) { state.dragging = false; apply() } })
    stage.addEventListener('wheel', ev => {
      ev.preventDefault(); const r = stage.getBoundingClientRect()
      zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top)
    }, { passive: false })
    window.addEventListener('keydown', ev => {
      if (root.hidden) return
      if (ev.key === 'Escape') { close() }
      else if (ev.key === '+' || ev.key === '=') { zoomAt(1.25, stage.clientWidth / 2, stage.clientHeight / 2) }
      else if (ev.key === '-') { zoomAt(0.8, stage.clientWidth / 2, stage.clientHeight / 2) }
      else if (ev.key === '0') { setFit() }
    })
    lb = state
    return state
  }
  function openLightbox(url, name) {
    const state = ensureLightbox()
    state.img.src = url
    state.img.alt = name || ''
    state.root.hidden = false
    state.setFit()
  }

  async function renderOffice(row, view, badge) {
    const data = await call('preview.office', { path: row.path })
    clear(view)
    view.append(head(row.name, badge))
    if (data.kind === 'docx') {
      const doc = el('div', { class: 'doc' })
      let empty = true
      for (const block of data.blocks || []) {
        if (block.type === 'heading') {
          empty = false
          const level = Math.min(6, Math.max(1, Number(block.level) || 3))
          doc.append(el('h4', { class: `dh h${level}`, text: block.text }))
        } else if (block.type === 'para') {
          empty = false
          doc.append(el('p', { class: 'para', text: block.text }))
        } else {
          doc.append(el('div', { class: 'gap' }))
        }
      }
      view.append(empty ? el('p', { class: 'note', text: '这个 Word 文档没有可提取的文字（可能全是图片）。' }) : doc)
    } else if (data.kind === 'pptx') {
      const slides = el('div', { class: 'slides' })
      for (const slide of data.slides || []) {
        const box = el('div', { class: 'slide' }, [el('h3', { text: `第 ${slide.index} 页` })])
        if (!slide.lines.length) box.append(el('p', { class: 'note', text: '（本页无文字）' }))
        for (const line of slide.lines) box.append(el('p', { text: line }))
        slides.append(box)
      }
      view.append((data.slides || []).length ? slides : el('p', { class: 'note', text: '这个演示文稿没有可提取的文字。' }))
    } else if (data.kind === 'xlsx') {
      for (const sheet of data.sheets || []) {
        const box = el('div', { class: 'sheet' }, [el('h3', { text: sheet.name })])
        const grid = el('div', { class: 'grid' })
        const table = el('table')
        const rows = sheet.rows || []
        if (rows.length) {
          const width = Math.max(...rows.map(r => r.length))
          const thead = el('thead')
          const tr = el('tr')
          for (let c = 0; c < width; c++) tr.append(el('th', { text: columnName(c) }))
          thead.append(tr); table.append(thead)
          const tbody = el('tbody')
          rows.slice(0, 1200).forEach((cells, index) => {
            const row = el('tr')
            row.append(el('th', { text: String(index + 1) }))
            for (let c = 0; c < width; c++) row.append(el('td', { title: cells[c] ?? '', text: cells[c] ?? '' }))
            tbody.append(row)
          })
          table.append(tbody); grid.append(table); box.append(grid)
          if (rows.length > 1200) box.append(el('p', { class: 'note', text: `共 ${rows.length} 行，只显示前 1200 行。` }))
        } else box.append(el('p', { class: 'note', text: '空工作表' }))
        view.append(box)
      }
      if (!(data.sheets || []).length) view.append(el('p', { class: 'note', text: '没有读到工作表。' }))
    } else if (data.kind === 'zip') {
      view.append(el('p', { class: 'note', text: `压缩包共 ${data.total} 项。` }))
      const pre = el('pre', { class: 'body' })
      pre.append(document.createTextNode((data.names || []).join('\n')))
      view.append(pre)
    }
    view.append(footer(row.path))
  }

  function columnName(index) {
    let n = index, name = ''
    do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1 } while (n >= 0)
    return name
  }

  function renderPdf(row, view, badge) {
    clear(view)
    view.append(head(row.name, badge))
    view.append(fallback('PDF 暂不支持内联预览', '', [
      '插件页面运行在沙箱里，没有 PDF 渲染器，也不允许加载外部对象。',
      '请在系统的文件管理器里双击打开这个 PDF。',
    ], row.path))
    view.append(footer(row.path))
  }

  function renderMedia(row, view, badge) {
    clear(view)
    view.append(head(row.name, badge))
    view.append(fallback(
      row.kind === 'video' ? '视频暂不支持内联播放' : '音频暂不支持内联播放',
      '',
      ['插件页面不允许加载媒体资源。', '请在系统的文件管理器里双击打开。'],
      row.path,
    ))
    view.append(footer(row.path))
  }

  function renderBinary(row, view, badge) {
    clear(view)
    view.append(head(row.name, badge))
    view.append(fallback('这是一个二进制文件', '', [
      `无法按文本预览，大小 ${bytes(row.size)}。`,
      '如果需要查看原始字节，可以先用十六进制工具打开。',
    ], row.path))
    view.append(footer(row.path))
  }

  function footer(path) {
    const box = el('div', { class: 'foot' })
    const copy = el('button', { type: 'button' }, '复制路径')
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(path)
        copy.textContent = '已复制'
        setTimeout(() => { copy.textContent = '复制路径' }, 1200)
      } catch { copy.textContent = '复制失败' }
    }
    box.append(copy)
    return box
  }

  // ---------------------------------------------------------------- 文件夹选择器

  // 「打开文件夹」= 直接弹 Windows 系统原生选择文件夹对话框（后端 pick-folder.ps1），
  // 用户选完就跳过去。宿主单次调用有 15s 超时，所以后端先返回 pending，这里轮询。
  let nativeBusy = false
  // ---------------------------------------------------------- 插件内目录选择器
  // 宿主没有 FishDock.hold 时（官方 v1.2.3 及更早）不能弹原生对话框：它会抢走焦点，
  // 宿主 onBlur 判定用户走开就把设置面板收掉，用户选完回来页面已经没了。
  // 这里改用插件自己画的目录树（走 preview.tree），全程不出窗口，焦点不丢。
  const dirPick = { path: '', sel: '', up: null }

  async function drawDirPick(target) {
    const box = $('dirpick')
    if (!box) return
    box.hidden = false
    // 依次回落到已知路径。启动还没走完时这些可能全空，先补拉一次 roots，
    // 否则会拿空串去问后端（只会得到「缺少路径参数」）。
    let start = target || dirPick.path || state.path || state.home || state.roots[0]?.path || ''
    if (!start) { await ensureRoots(); start = state.path || state.home || state.roots[0]?.path || '' }
    dirPick.path = start
    dirPick.sel = start
    $('dirpick-path').value = start
    if (!start) {
      const note = $('dirpick-note')
      if (note) note.textContent = '没有可用的根目录，请先在「位置」里添加文件夹'
      return
    }
    await loadDirPick(start)
  }

  // 拉一次根目录/最近记录；启动未完成时由 drawDirPick 兜底调用。
  async function ensureRoots() {
    if (state.roots.length) return true
    try {
      const row = await call('preview.roots')
      state.roots = row.roots || []
      state.recent = row.recent || []
      state.home = row.home || ''
      if (row.favorites) state.favorites = row.favorites
      if (row.pinned) state.pinned = row.pinned
    } catch {}
    return state.roots.length > 0
  }

  async function loadDirPick(target) {
    const list = $('dirpick-list')
    const note = $('dirpick-note')
    if (!list) return
    list.replaceChildren()
    let row
    try {
      row = await call('preview.tree', { path: target })
    } catch (error) {
      if (note) note.textContent = '读不到这个目录：' + (error.message || error)
      return
    }
    if (!row || row.error) {
      if (note) note.textContent = (row && row.error) || '读不到这个目录'
      return
    }
    dirPick.path = row.path
    dirPick.up = row.parent || null
    $('dirpick-path').value = row.path
    $('dirpick-title').textContent = '选择文件夹 · ' + row.path
    const crumbs = $('dirpick-crumbs')
    if (crumbs) {
      crumbs.replaceChildren()
      const parts = row.path.split(/[\\/]/).filter(Boolean)
      let acc = /^[A-Za-z]:/.test(row.path) ? '' : '/'
      parts.forEach((part, index) => {
        acc = index === 0 && /^[A-Za-z]:$/.test(part) ? part + '\\' : (acc.endsWith('\\') || acc.endsWith('/') ? acc + part : acc + '\\' + part)
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ghost tiny'
        button.textContent = part
        button.onclick = () => guard(loadDirPick(acc))()
        crumbs.append(button)
      })
    }
    const dirs = (row.entries || []).filter(entry => entry.isDir)
    if (!dirs.length) {
      const empty = document.createElement('p')
      empty.className = 'note'
      empty.textContent = '这个目录下没有子文件夹'
      list.append(empty)
    }
    for (const entry of dirs) {
      const line = document.createElement('div')
      line.className = 'row'
      line.dataset.path = entry.path
      line.setAttribute('role', 'option')
      const name = document.createElement('span')
      name.className = 'nm'
      name.textContent = entry.name
      const into = document.createElement('button')
      into.type = 'button'
      into.className = 'ghost tiny'
      into.textContent = '进入'
      into.onclick = event => { event.stopPropagation(); guard(loadDirPick(entry.path))() }
      line.append(name, into)
      line.onclick = () => {
        dirPick.sel = entry.path
        for (const other of list.querySelectorAll('.row')) other.classList.toggle('sel', other === line)
        $('dirpick-path').value = entry.path
      }
      list.append(line)
    }
    if (note) note.textContent = row.truncated ? '目录条目过多，只显示前一部分' : ''
  }

  function closeDirPick() {
    const box = $('dirpick')
    if (box) box.hidden = true
  }

  function wireDirPick() {
    const box = $('dirpick')
    if (!box) return
    $('dirpick-close').onclick = () => closeDirPick()
    $('dirpick-up').onclick = guard(async () => { if (dirPick.up) await loadDirPick(dirPick.up) })
    $('dirpick-ok').onclick = guard(async () => {
      const typed = ($('dirpick-path').value || '').trim()
      const target = typed || dirPick.sel || dirPick.path
      closeDirPick()
      if (target) await openFolderAuto(target)
    })
    $('dirpick-path').onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); guard(loadDirPick(($('dirpick-path').value || '').trim()))() }
    }
    box.onclick = event => { if (event.target === box) closeDirPick() }
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !box.hidden) closeDirPick() })
  }

  // 有宿主 hold 就走原生对话框（体验好），没有就走自绘选择器（不失焦）
  function canHold() { return typeof FishDock !== 'undefined' && typeof FishDock.hold === 'function' }
  function setHold(on) { try { FishDock.hold?.(!!on) } catch { /* 宿主没注入 hold 时忽略 */ } }
  async function openNativeFolder() {
    if (nativeBusy) return
    if (!canHold()) {
      await drawDirPick(state.path || state.home || '')
      return
    }
    nativeBusy = true
    // 只有这一刻才临时锁面板：原生对话框会抢走焦点，宿主 onBlur 会把设置面板收掉，
    // 用户选完文件夹回来页面就没了。所以先 hold(true)，选完在 finally 里放开。
    // 平时浏览、拖放都不锁，用户仍能照常点外面关闭面板。
    FishDock.hold?.(true)
    // 弹系统对话框之前先把当前页面尺寸报给宿主锁定一次，避免对话框关掉后
    // 宿主按旧高度重排、把刚打开的文件夹列表挤变形。这里只锁尺寸，
    // 不动「固定文件夹」那一侧的显示优先级。
    reportHeight()
    const start = state.file ? dirOf(state.file.path) : (state.path || state.home || '')
    try {
      say('请在弹出的系统窗口里选择文件夹…')
      const first = await call('preview.pickFolder', { initial: start, title: '选择要预览的文件夹' })
      if (first && first.error) throw new Error(first.error)
      let done = null
      for (let i = 0; i < 900; i++) {           // 最长等 ~10 分钟，够用户慢慢翻
        await new Promise(r => setTimeout(r, 700))
        const row = await call('preview.pickResult')
        if (row && row.error) throw new Error(row.error)
        if (!row || row.pending) continue
        done = row
        break
      }
      if (!done) { say('选择超时'); return }
      if (done.cancelled) { say('已取消'); return }
      if (done.roots) state.roots = done.roots
      const target = done.picked || (done.roots && done.roots[0] && done.roots[0].path)
      if (target) {
        $('jump').hidden = true
        await openFolderAuto(target)
      }
    } catch (error) {
      say('')                      // 别把「请在弹出的…」留在状态行，错误由 #error 显示
      throw error
    } finally {
      nativeBusy = false
      // 选完（或取消/报错）立刻放开临时锁，恢复「点外面能关面板」的正常行为。
      setHold(false)
    }
  }

  // ---------------------------------------------------------------- 分栏宽度

  // 拖动分隔条改左栏宽度。拖动过程只改 CSS 变量（不打 IPC，避免每帧一次调用），
  // 松手才把最终值报给后端存进 prefs.json。
  function wireSplitter() {
    const split = $('split')
    if (!split) return
    const workspace = document.querySelector('.workspace')
    let dragging = false
    let pointerId = null
    let frame = 0
    // 用「起点 + 位移」算高度，不去反推分隔条相对容器的偏移：
    // .workspace 有 gap，分隔条并不紧贴上栏下边缘，按坐标换算会固定差几像素。
    let startY = 0
    let startH = SIDE_DEFAULT

    const paint = () => {
      frame = 0
      applySideHeight()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }

    const save = () => {
      const height = Math.round(state.sideW) || SIDE_DEFAULT
      call('preview.sideWidth', { width: height }).catch(() => null)
    }

    split.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      dragging = true
      pointerId = event.pointerId
      startY = event.clientY
      startH = state.sideW
      document.body.dataset.resizing = 'true'
      split.dataset.dragging = 'true'
      try { split.setPointerCapture(pointerId) } catch { /* 指针已释放时忽略 */ }
      event.preventDefault()
    })

    split.addEventListener('pointermove', event => {
      if (!dragging) return
      const next = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(startH + (event.clientY - startY))))
      if (next === state.sideW) return
      state.sideW = next
      schedule()
    })

    const stop = () => {
      if (!dragging) return
      dragging = false
      delete document.body.dataset.resizing
      delete split.dataset.dragging
      if (pointerId !== null) { try { split.releasePointerCapture(pointerId) } catch { /* 已释放 */ } }
      pointerId = null
      if (frame) { cancelAnimationFrame(frame); frame = 0 }
      applySideHeight()
      // pointercancel 是拖到一半被打断（比如切窗口），也照样存下当前高度。
      save()
    }
    split.addEventListener('pointerup', stop)
    split.addEventListener('pointercancel', stop)
    split.addEventListener('lostpointercapture', stop)

    // 双击恢复默认高度。
    split.addEventListener('dblclick', () => {
      state.sideW = SIDE_DEFAULT
      applySideHeight()
      save()
    })

    // 键盘：聚焦分隔条后上下方向键微调（每次 16px），Home 恢复默认。
    split.addEventListener('keydown', event => {
      const step = event.shiftKey ? 48 : 16
      let next = null
      if (event.key === 'ArrowUp') next = state.sideW - step
      else if (event.key === 'ArrowDown') next = state.sideW + step
      else if (event.key === 'Home') next = SIDE_DEFAULT
      if (next === null) return
      event.preventDefault()
      state.sideW = Math.min(SIDE_MAX, Math.max(SIDE_MIN, next))
      applySideHeight()
      save()
    })
  }


  // ---------------------------------------------------------------- 事件绑定

  $('refresh').onclick = guard(() => state.file ? openFile(state.file.path) : (state.path ? openDir(state.path) : boot()))
  $('browse-refresh').onclick = guard(() => state.path ? openDir(state.path) : null)
  $('browse-up').onclick = guard(() => state.parent ? openDir(state.parent) : null)
  // 隐藏项开关 + 表头排序（点同一列切换升降序）
  $('browse-hidden').onclick = () => { state.showHidden = !state.showHidden; drawBrowse() }
  for (const btn of $('browse-head').querySelectorAll('button[data-sort]')) {
    btn.onclick = () => {
      const k = btn.dataset.sort
      if (state.sortKey === k) state.sortDir = -state.sortDir
      else { state.sortKey = k; state.sortDir = 1 }
      drawBrowse()
    }
  }
  // 「上一级」：双栏时左栏才是目录浏览的主体，应该以左栏当前位置为准；
  // 单栏时页面已经被文件视图占据，只能用文件所在目录回退。
  $('up').onclick = guard(() => {
    if (state.layout === 'double') return state.parent ? openDir(state.parent) : null
    return state.file ? openDir(dirOf(state.file.path)) : (state.parent ? openDir(state.parent) : null)
  })
  $('recent-clear').onclick = guard(async () => { const row = await call('preview.forget'); state.recent = row.recent; drawSide() })
  $('open').onclick = guard(() => openNativeFolder(false))
  $('pick-native').onclick = guard(async () => { await openNativeFolder(true); drawSide() })
  $('jump-cancel').onclick = () => { $('jump').hidden = true }
  $('fav-open').onclick = guard(async () => {
    const pop = $('fav-pop')
    if (pop.hidden) {
      // 每次打开前从后端刷新最新列表
      const row = await call('preview.favorites')
      state.favorites = row.favorites
      state.pinned = row.pinned
      drawFavPop()
      pop.hidden = false
    } else {
      pop.hidden = true
    }
  })
  $('fav-pin-btn').onclick = guard(togglePin)
  // 点击浮层外关闭
  document.addEventListener('click', event => {
    const pop = $('fav-pop')
    if (pop && !pop.hidden && !pop.contains(event.target) && event.target !== $('fav-open')) {
      pop.hidden = true
    }
  })
  $('jump-form').onsubmit = event => {
    event.preventDefault()
    const value = $('jump-input').value.trim()
    if (!value) return
    $('jump').hidden = true
    guard(() => openPath(value))()
  }

  // ---------------------------------------------------------------- 启动

  async function bootPreview() {
    wireDirPick()
    const row = await call('preview.roots')
    state.roots = row.roots || []
    state.recent = row.recent || []
    state.home = row.home || ''
    state.favorites = row.favorites || []
    state.pinned = row.pinned || []
    // 合并页：预览区固定双栏（左文件夹树 + 右预览），不接受后端 single。
    state.layout = 'double'
    document.body.dataset.layout = 'double'
    if (Number.isFinite(row.sideW)) state.sideW = row.sideW
    drawSide()
    updatePinBtn()
    // 固定落到默认文件夹（F:\AI REP），最近记录只留在侧栏，不抢占启动视图。
    const home = state.home || state.roots[0]?.path || ''
    if (home) await openDir(home)
    else { clear($('view')).append(el('p', { class: 'note', text: '没有可访问的根目录。' })); say('就绪') }
  }


  const fail = message => { const n = $('error'); if (n) n.textContent = message }

  // ================================================================ 文件暂存（原 stash.js 逻辑）


  // 简易文件类型图标：目录 / 图片 / 音视频 / 压缩包 / 文本代码 / 兜底
  const ICONS = [
    [/^(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/, '🖼️'],
    [/^(mp3|wav|flac|ogg|m4a)$/, '🎵'],
    [/^(mp4|mkv|avi|mov|webm)$/, '🎬'],
    [/^(zip|7z|rar|tar|gz)$/, '🗜️'],
    [/^(js|mjs|ts|py|json|md|txt|html|css|c|cpp|h|rs|go|java|sh|yml|yaml|toml)$/, '📄'],
  ]
  const iconOf = item => {
    if (item.kind === 'dir' || item.kind === 'folder') return '📁'
    const ext = extOf(item.name)
    for (const [re, ico] of ICONS) if (re.test(ext)) return ico
    return '📃'
  }
  // DownloadURL 的 mime：按扩展名给个粗略值，宿主资源管理器主要消费文件名与 URL。
  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
    mp3: 'audio/mpeg', mp4: 'video/mp4', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', html: 'text/html',
  }
  const mimeOf = item => MIME[extOf(item.name)] || 'application/octet-stream'


  // ---------------------------------------------------------------- 桥封装（照抄 page/page.js 的 call()）


  // 允许失败的业务调用（拖入合并时逐条容错用）
  const callSoft = async (method, params = {}) => {
    try { return await call(method, params) } catch (error) { return { ok: false, error: error.message } }
  }

  const toast = message => {
    // 轻量提示：复用页脚，2.6s 后自动恢复
    const foot = $('foot')
    foot.textContent = message
    clearTimeout(toast.t)
    toast.t = setTimeout(() => { foot.textContent = footerText() }, 2600)
  }
  const footerText = () => {
    const n = state.items.length
    const s = state.selected.size
    return n ? `共 ${n} 项${s ? `，已选 ${s} 项` : ''}` : ''
  }

  const reportHeight = () => {
    // 必须按真实布局上报：宿主 onLayout 只有在 layout==='double' 时才会把扩展页
    // 放宽（EXT_WIDE_W=1280）。原来写死 'single'，导致无论页面怎么排都按窄宽度渲染。
    const layout = state.layout === 'double' ? 'double' : 'single'
    try { parent.postMessage({ type: 'fish:layout', height: document.documentElement.scrollHeight, layout }, '*') } catch { /* 宿主不可用时忽略 */ }
  }

  // ---------------------------------------------------------------- 数据

  const refresh = async () => {
    const row = await call('stash.list')
    state.items = row.items || []
    state.groups = row.groups || []
    // 选中项里已不存在的去掉
    const alive = new Set(state.items.map(i => i.id))
    for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id)
    // 当前视图被删组时回到全部
    if (state.view !== 'all' && state.view !== '' && !state.groups.includes(state.view)) state.view = 'all'
    draw()
  }
  const redraw = () => { draw() }

  const visibleItems = () => state.items.filter(item => {
    if (state.view === 'all') { /* 全部 */ }
    else if (state.view === '') { if (item.group) return false }
    else if (item.group !== state.view) return false
    return true
  })

  const selectedItems = () => state.items.filter(i => state.selected.has(i.id))

  // ---------------------------------------------------------------- 渲染

  const draw = () => {
    drawList()
    drawMoveSelect()
    updateToolbar()
    // 右侧文件列表也要跟着暂存项变化重绘：这样「已暂存」高亮/badge 才能即时反映
    try { drawBrowse() } catch { /* browse 尚未初始化时忽略 */ }
    const foot = $('foot')
    if (!foot.textContent || foot.textContent.startsWith('共 ')) foot.textContent = footerText()
    reportHeight()
  }

  // 折叠状态记忆：key = 分组名（未分组用 ''），收起时记 false。默认展开。
  const collapsed = new Map()
  const isCollapsed = key => collapsed.get(key) === true

  // 把「移动到组」下拉同步成当前分组列表
  const drawMoveSelect = () => {
    const sel = $('move-to'); if (!sel) return
    clear(sel)
    sel.append(el('option', { value: '', text: '（未分组）' }))
    for (const g of state.groups) sel.append(el('option', { value: g, text: g }))
    sel.value = state.view !== 'all' && state.groups.includes(state.view) ? state.view : ''
  }

  // 渲染整张列表：按分组拆成若干个可折叠的 <details>（参考 cost-meter 的「今日」标签）。
  // 每个分组头就是一条标签，带条目计数；点标签收起/展开该组。
  // state.view === 'all' 时显示全部分组；否则只显示选中的那一组（选中组强制展开）。
  const drawList = () => {
    const list = clear($('list'))
    const buckets = []
    const push = (key, label) => {
      if (state.view !== 'all' && String(state.view) !== key) return
      const items = state.items.filter(i => (key === '' ? !i.group : i.group === key))
      buckets.push({ key, label, items })
    }
    if (state.view === 'all' || state.view === '') push('', '未分组')
    for (const g of state.groups) push(g, g)

    const totalShown = buckets.reduce((n, b) => n + b.items.length, 0)
    $('empty').hidden = totalShown > 0 || buckets.length > 0

    const last = { idx: -1 }   // Shift 连选锚点（跨组按全局顺序）
    const flat = []            // 所有可见项顺序，供 Shift 连选
    buckets.forEach(b => b.items.forEach(i => flat.push(i)))

    for (const bucket of buckets) {
      const active = state.view !== 'all' && String(state.view) === bucket.key
      const det = el('details', { class: 'stash-group' + (active ? ' active' : '') })
      det.open = !isCollapsed(bucket.key)
      det.addEventListener('toggle', () => {
        collapsed.set(bucket.key, !det.open)
      })

      const summary = el('summary', {
        class: 'stash-tag' + (active ? ' active' : ''),
        title: `${bucket.label} · ${bucket.items.length} 项（点箭头/整条折叠；点右侧漏斗图标只在看本组与全部间切换）`,
      })
      // 单击整条标签 = 折叠/展开（summary 默认行为，不拦截）。
      // 切换视图交给独立的漏斗按钮，避免和折叠抢点击。
      const switchView = ev => {
        ev.preventDefault(); ev.stopPropagation()
        if (active) { state.view = 'all' }                    // 已是当前组 → 回到全部
        else { state.view = bucket.key === '' ? '' : bucket.key }  // 切到本组
        guard(draw)()
        drawMoveSelect()
      }
      summary.append(el('span', { class: 'stash-tag-dot' }))
      summary.append(el('span', { class: 'stash-tag-name', text: bucket.label }))
      summary.append(el('span', { class: 'stash-tag-count', text: `(${bucket.items.length})` }))
      // 组内「全选 / 取消」：只作用于本组条目；多组叠加互不影响（不 clear 其它组的选中）。
      // drawList 每次都重建，按钮状态直接从 state.selected 现算，天然同步。
      if (bucket.items.length) {
        const ids = bucket.items.map(i => i.id)
        const allOn = ids.every(id => state.selected.has(id))
        const toggleBucket = ev => {
          ev.preventDefault(); ev.stopPropagation()
          if (allOn) { for (const id of ids) state.selected.delete(id) }
          else { for (const id of ids) state.selected.add(id) }
          guard(draw)()
        }
        summary.append(el('span', {
          class: 'stash-tag-select' + (allOn ? ' all' : ''), role: 'button', tabindex: '0',
          'aria-pressed': String(allOn),
          title: allOn
            ? `取消全选「${bucket.label}」（${bucket.items.length} 项）`
            : `全选「${bucket.label}」（${bucket.items.length} 项，不影响其它分组已选）`,
          onclick: toggleBucket,
          onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') toggleBucket(ev) },
        }, allOn ? '取消' : '全选'))
      }
      // 筛选按钮：切换「只看本组 / 全部」。用文字而不是 ⌕/◉ 图标——
      // 图标在这个尺寸下根本认不出是干什么的（可读优先）。
      summary.append(el('span', {
        class: 'stash-tag-filter' + (active ? ' on' : ''), role: 'button', tabindex: '0',
        title: active ? `正在只看「${bucket.label}」，点击回到全部` : `只看「${bucket.label}」`,
        onclick: switchView,
        onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') switchView(ev) },
      }, active ? '看全部' : '只看'))
      if (bucket.key !== '') {
        summary.append(el('span', {
          class: 'stash-tag-del', role: 'button', tabindex: '0', title: `删除分组「${bucket.label}」（条目回到未分组）`,
          onclick: ev => { ev.preventDefault(); ev.stopPropagation(); guard(() => removeGroup(bucket.key))() },
          onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); guard(() => removeGroup(bucket.key))() } },
        }, '×'))
      }
      det.append(summary)

      if (!bucket.items.length) {
        det.append(el('p', { class: 'stash-group-empty', text: '这个分组还没有文件。' }))
      } else {
        for (const item of bucket.items) det.append(buildRow(item, flat.indexOf(item), flat, last))
      }
      list.append(det)
    }
  }

  // 构造单个暂存条目行
  const buildRow = (item, idx, flat, last) => {
    const row = el('div', {
      class: 'row' + (state.selected.has(item.id) ? ' selected' : '') + (item.missing ? ' missing' : ''),
      role: 'option', 'aria-selected': String(state.selected.has(item.id)), draggable: 'true',
      dataset: { id: item.id }, title: item.path,
    })
    row.append(el('span', { class: 'ico', text: iconOf(item) }))
    row.append(el('span', { class: 'nm', text: item.name + (item.kind === 'dir' || item.kind === 'folder' ? '/' : '') }))
    if (item.missing) row.append(el('span', { class: 'miss', text: '文件缺失' }))
    row.append(el('span', { class: 'note', text: bytes(item.size) }))
    row.append(el('span', {
      class: 'stash-preview-btn', role: 'button', tabindex: '0',
      title: '在右侧预览区打开', 'aria-label': '预览',
      onclick: ev => { ev.stopPropagation(); guard(() => previewStashItem(item))() },
      onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); guard(() => previewStashItem(item))() } },
    }, '预览'))

    row.onclick = event => {
      if (event.shiftKey && last.idx >= 0) {
        const [a, b] = [Math.min(last.idx, idx), Math.max(last.idx, idx)]
        state.selected.clear()
        for (let i = a; i <= b; i++) state.selected.add(flat[i].id)
      } else if (event.ctrlKey || event.metaKey) {
        state.selected.has(item.id) ? state.selected.delete(item.id) : state.selected.add(item.id)
        last.idx = idx
      } else {
        state.selected.clear()
        state.selected.add(item.id)
        last.idx = idx
      }
      draw()
    }
    row.ondblclick = guard(() => previewStashItem(item))
    row.addEventListener('mousedown', () => prefetchDragOut(item))
    row.addEventListener('pointerdown', () => prefetchDragOut(item))
    row.addEventListener('dragstart', event => startDragOut(event, item))
    row.addEventListener('dragend', () => endDragOut(item))
    return row
  }

  // 删除一个分组（条目回到未分组）
  const removeGroup = async name => {
    // 宿主 WebView2 里 window.confirm 会被拦掉（永远返回 false），
    // 导致点分组标签右侧的 × 完全没反应。这里不再确认：
    // 删除只是把条目放回「未分组」，不会丢文件，可以重新建组。
    await call('stash.group.remove', { name })
    collapsed.delete(name)
    if (state.view === name) state.view = 'all'
    say(`已删除分组「${name}」`)
    await refresh()
  }

  const updateToolbar = () => {
    const has = state.selected.size > 0
    for (const id of ['btn-copy-path', 'btn-copy-file', 'btn-remove']) $(id).disabled = !has
  }

  // ---------------------------------------------------------------- 拖出（DownloadURL 必须同步 setData）

  const prefetchDragOut = item => {
    if (state.dragCache.has(item.id)) return
    callSoft('stash.dragOut', { id: item.id }).then(row => {
      if (row && row.ok && row.url) state.dragCache.set(item.id, { url: row.url, name: row.name || item.name, mime: row.mime || mimeOf(item) })
      else toast('拖出失败：' + ((row && row.error) || '无法生成下载链接'))
    })
  }
  const startDragOut = (event, item) => {
    const cached = state.dragCache.get(item.id)
    event.dataTransfer.effectAllowed = 'copy'
    if (cached) {
      // 硬要求：dragstart 里同步 setData，URL 必须来自 mousedown 阶段预取的缓存
      event.dataTransfer.setData('DownloadURL', `${cached.mime}:${cached.name}:${cached.url}`)
      event.dataTransfer.setData('text/plain', item.path)
      event.dataTransfer.setData('text/uri-list', cached.url)
    } else {
      // 缓存没来得及：退化为只带纯文本路径
      event.dataTransfer.setData('text/plain', item.path)
      toast('正在准备拖出，请重新拖一次')
    }
  }
  const endDragOut = item => {
    state.dragCache.delete(item.id)
    callSoft('stash.closeDragOut', { id: item.id })
  }

  // ---------------------------------------------------------------- 拖入（宿主转发 fish:drag）

  window.addEventListener('message', event => {
    const data = event.data
    if (!data || data.type !== 'fish:drag') return
    const stash = $('stash')
    if (data.phase === 'enter' || data.phase === 'over') {
      stash.classList.add('drag-over')
      $('drop-overlay').hidden = false
      return
    }
    if (data.phase === 'leave') {
      stash.classList.remove('drag-over')
      $('drop-overlay').hidden = true
      return
    }
    if (data.phase === 'drop') {
      stash.classList.remove('drag-over')
      $('drop-overlay').hidden = true
      const paths = Array.isArray(data.paths) ? data.paths : []
      if (!paths.length) return
      guard(async () => {
        const group = state.view === 'all' ? '' : state.view
        // 逐条加入，方便把失败的单独进 toast
        const results = await Promise.all(paths.map(p => callSoft('stash.add', { paths: [p], group })))
        let added = 0
        for (const r of results) {
          if (r && r.ok) added++
          else toast('加入暂存失败：' + ((r && r.error) || '未知错误'))
        }
        if (added) { say(`已加入 ${added} 项`); await refresh() }
        else fail('没有文件被加入暂存')
      })()
    }
  })

  // ---------------------------------------------------------------- 工具条动作

  const addPaths = async paths => {
    const group = state.view === 'all' ? '' : state.view
    const results = await Promise.all(paths.map(p => callSoft('stash.add', { paths: [p], group })))
    let added = 0
    for (const r of results) {
      if (r && r.ok) added++
      else toast('加入暂存失败：' + ((r && r.error) || '未知错误'))
    }
    if (added) { say(`已加入 ${added} 项`); await refresh() }
  }

  $('btn-copy-path').onclick = guard(async () => {
    const items = selectedItems()
    await call('stash.copy', { mode: 'path', ids: items.map(i => i.id) })
    toast(`已复制 ${items.length} 条路径`)
  })
  $('btn-copy-file').onclick = guard(async () => {
    const items = selectedItems()
    await call('stash.copy', { mode: 'file', ids: items.map(i => i.id) })
    toast(`已复制 ${items.length} 个文件，可到资源管理器粘贴`)
  })
  $('btn-remove').onclick = guard(async () => {
    const items = selectedItems()
    await call('stash.remove', { ids: items.map(i => i.id) })
    state.selected.clear()
    say(`已移除 ${items.length} 项`)
    await refresh()
  })
  $('btn-select-all').onclick = () => {
    // 只切换「当前可见」条目，不再粗暴 clear —— 以免和分组标签上的组内全选互相冲突。
    const ids = visibleItems().map(i => i.id)
    if (!ids.length) return
    const all = ids.every(id => state.selected.has(id))
    if (all) for (const id of ids) state.selected.delete(id)
    else for (const id of ids) state.selected.add(id)
    draw()
  }

  // 分组操作
  // 新建组：不用 window.prompt —— WebView2 内嵌页面可能禁用/屏蔽 prompt（返回 null 或抛异常），
  // 那样 (prompt()||'').trim() 得到空串就会静默什么都不做，用户看到「点了没反应」。
  // 改成在工具条里就地展开一个输入框，回车/点确定创建，Esc/失焦取消。
  const openGroupInput = () => {
    const input = $('group-new-input')
    const okBtn = $('btn-group-new-ok')
    if (!input) return
    input.hidden = false
    if (okBtn) okBtn.hidden = false
    input.value = ''
    input.focus()
  }
  const closeGroupInput = () => {
    const input = $('group-new-input')
    const okBtn = $('btn-group-new-ok')
    if (input) { input.hidden = true; input.value = '' }
    if (okBtn) okBtn.hidden = true
  }
  const commitGroupInput = guard(async () => {
    const input = $('group-new-input')
    if (!input) return
    const name = (input.value || '').trim()
    if (!name) { closeGroupInput(); return }
    if (state.groups.includes(name)) { fail('分组已存在'); closeGroupInput(); return }
    closeGroupInput()
    await call('stash.group.add', { name })
    state.view = 'all'
    say(`已创建分组「${name}」`)
    await refresh()
  })
  $('btn-group-new').onclick = () => openGroupInput()
  if ($('btn-group-new-ok')) $('btn-group-new-ok').onclick = commitGroupInput
  if ($('group-new-input')) {
    const input = $('group-new-input')
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); commitGroupInput() }
      else if (event.key === 'Escape') { event.preventDefault(); closeGroupInput() }
    })
    // 失焦时：如果填了名字就提交，没填就收起（避免点「确定」时先触发 blur 导致重复）
    input.addEventListener('blur', () => {
      if (!(input.value || '').trim()) closeGroupInput()
    })
  }
  $('move-to').onchange = guard(async event => {
    const target = event.target.value
    const items = selectedItems()
    if (!items.length) { toast('先选中条目再移动'); return }
    await call('stash.move', { ids: items.map(i => i.id), group: target })
    say(`已移动 ${items.length} 项到「${target || '未分组'}」`)
    await refresh()
  })

  // ---------------------------------------------------------------- 启动

  // 互关联①：文件列表项 → 加入暂存。当前分组作为落点，加完刷新暂存列表。
  async function addToStash(target) {
    const group = state.view === 'all' ? '' : state.view
    const row = await callSoft('stash.add', { paths: [target], group })
    if (row && row.ok) {
      const added = Array.isArray(row.items) ? row.items.length : 1
      if (added) { say('已加入暂存'); await refresh() } else { toast('已在暂存中，或文件无法加入') }
    } else {
      fail('加入暂存失败：' + ((row && row.error) || '未知错误'))
    }
  }

  // 批量加入（框选后拖进暂存区走这一条）。
  // 后端 stash.add 本来就吃 paths 数组，所以只是把多行一次性递过去；
  // 逐个报告"加了几项/几项重复"，比只弹一个含糊的 toast 更好懂。
  async function addManyToStash(paths) {
    const list = (paths || []).filter(Boolean)
    if (!list.length) return
    const group = state.view === 'all' ? '' : state.view
    const row = await callSoft('stash.add', { paths: list, group })
    if (row && row.ok) {
      const added = Array.isArray(row.items) ? row.items.length : 0
      const dup = list.length - added
      const head = added ? `已加入暂存 ${added} 项` : '这些都已经在暂存里了'
      say(dup > 0 && added > 0 ? `${head}，${dup} 项重复已跳过` : head)
      if (added) await refresh()
    } else {
      fail('加入暂存失败：' + ((row && row.error) || '未知错误'))
    }
  }

  // ================================================================ 框选 + 拖到暂存区

  // 指针状态机：idle → pending（按下未移动）→ box（空白处拖出选框）/ drag（从行上拖走）。
  // pending 时原地松手，就交还给原有的 click（打开文件/进入目录），不抢原有交互。
  function wireBrowseSelect() {
    const list = $('browse-list')
    const rubber = $('rubber')
    const stashCol = $('stash-col')
    if (!list || !rubber) return

    const THRESHOLD = 5          // 位移小于它算点击，不算拖动
    let mode = 'idle'
    let startX = 0, startY = 0
    let startRow = null          // 起点落在哪一行（null = 点在空白处）
    let baseSel = []             // 拖动/框选开始时已有的选择，按住 Shift 时参与累加
    let dragPaths = []
    let moved = false
    let suppressClick = false
    let ghost = null

    const rows = () => Array.from(list.querySelectorAll('.row[data-path]'))

    // 只改 class，不整片重绘：框选要跟手，重建 DOM 会闪。
    const paint = () => {
      for (const node of rows()) {
        const on = state.browseSel.has(node.dataset.path)
        node.classList.toggle('sel', on)
        node.setAttribute('aria-selected', on ? 'true' : 'false')
      }
    }

    const boxSelect = (rect, additive) => {
      const picked = new Set(additive ? baseSel : [])
      for (const node of rows()) {
        const b = node.getBoundingClientRect()
        // 相交即选中，符合"拖框扫过去就中"的直觉
        if (!(b.right < rect.left || b.left > rect.right || b.bottom < rect.top || b.top > rect.bottom)) {
          picked.add(node.dataset.path)
        }
      }
      state.browseSel = picked
      paint()
    }

    const reset = () => {
      mode = 'idle'
      dragPaths = []
      startRow = null
      rubber.classList.remove('on')
      rubber.style.cssText = ''
      delete document.body.dataset.boxing
      delete document.body.dataset.dragging
      if (ghost) { ghost.remove(); ghost = null }
      for (const node of list.querySelectorAll('.row.drag-src')) node.classList.remove('drag-src')
      if (stashCol) stashCol.classList.remove('drop-target')
    }

    list.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      const target = event.target
      if (target.closest('.add')) return            // ＋ 按钮有自己的 onClick
      if (target.closest('#browse-head')) return    // 表头是排序按钮
      mode = 'pending'
      moved = false
      startX = event.clientX
      startY = event.clientY
      startRow = target.closest('.row[data-path]')
      const additive = event.shiftKey || event.ctrlKey || event.metaKey
      if (startRow) {
        const path = startRow.dataset.path
        if (additive) {
          // 按住 Ctrl/Shift：切换这一项的选中状态，其余保留
          if (state.browseSel.has(path)) state.browseSel.delete(path)
          else state.browseSel.add(path)
        } else if (!state.browseSel.has(path)) {
          // 普通左键：只留这一项（保持"选中=当前行"的直觉，也让单击后能直接拖走）
          state.browseSel = new Set([path])
        }
        paint()
      } else if (!additive) {
        state.browseSel = new Set()
        paint()
      }
      baseSel = Array.from(state.browseSel)
      // 注意：这里【不能】立刻 setPointerCapture。行是 <button>，指针被祖先列表捕获后
      // WebView2 不再派发行的 click → 真机鼠标点文件夹"没反应"（UIA 的 Invoke 直接派
      // DOM click，所以测试看着正常）。只有确认是拖动（moved 之后）才捕获，纯点击交还原生 click。
    })

    list.addEventListener('pointermove', event => {
      if (mode === 'idle') return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      if (!moved) {
        if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return
        moved = true
        // 起手先一律进框选：列表里行是铺满的，几乎找不到空白区，
        // 若一按行就判成"拖到暂存区"，用户就永远框不到东西。
        // 只有指针真的离开列表、且手里拿着选中项时，下一条 pointermove 才升级成拖拽。
        mode = 'box'
        document.body.dataset.boxing = 'true'
        rubber.classList.add('on')
        // 确认是拖动后才捕获指针：保证拖到暂存区上方松手时 pointerup 仍回到列表，
        // 同时不影响"纯点击不捕获"，让行的 click 正常触发打开/预览。
        try { list.setPointerCapture(event.pointerId) } catch { /* 老 WebView 不支持就靠冒泡 */ }
      }
      // 指针已经拖出列表、且起手处有选中项 → 这一趟是想搬去暂存区，切成拖拽态。
      const inside = !!document.elementFromPoint(event.clientX, event.clientY)?.closest('#browse-list')
      if (mode === 'box' && !inside && startRow && state.browseSel.size) {
        mode = 'drag'
        // 框选过程改动过 browseSel，升级成拖拽时恢复成"起手那一刻选中的项"，
        // 否则拖走的会是半路被框到的东西，不是用户按住的那几个。
        state.browseSel = new Set(baseSel)
        paint()
        dragPaths = Array.from(state.browseSel)
        delete document.body.dataset.boxing
        rubber.classList.remove('on')
        rubber.style.cssText = ''
        document.body.dataset.dragging = 'true'
        for (const node of rows()) {
          if (state.browseSel.has(node.dataset.path)) node.classList.add('drag-src')
        }
        ghost = el('div', { class: 'drag-ghost', text: dragPaths.length > 1 ? `搬运 ${dragPaths.length} 项` : '搬运到暂存区' })
        document.body.append(ghost)
      }
      if (mode === 'box') {
        const left = Math.min(startX, event.clientX)
        const top = Math.min(startY, event.clientY)
        const width = Math.abs(dx)
        const height = Math.abs(dy)
        rubber.style.left = `${left}px`
        rubber.style.top = `${top}px`
        rubber.style.width = `${width}px`
        rubber.style.height = `${height}px`
        boxSelect({ left, top, right: left + width, bottom: top + height },
          event.shiftKey || event.ctrlKey || event.metaKey)
      } else if (mode === 'drag' && ghost) {
        ghost.style.left = `${event.clientX + 14}px`
        ghost.style.top = `${event.clientY + 14}px`
        const over = stashCol && document.elementFromPoint(event.clientX, event.clientY)?.closest('#stash-col')
        if (stashCol) stashCol.classList.toggle('drop-target', !!over)
      }
      event.preventDefault()
    })

    const finish = async event => {
      if (mode === 'idle') return
      const was = mode
      const paths = dragPaths.slice()
      const dropped = was === 'drag' && !!(
        stashCol && document.elementFromPoint(event.clientX, event.clientY)?.closest('#stash-col')
      )
      // 拖动/框选结束后浏览器还会补一个 click，必须吃掉它，
      // 否则把文件拖进暂存区的同时会在预览区把它打开一遍。
      if (moved) {
        suppressClick = true
        setTimeout(() => { suppressClick = false }, 0)
      }
      reset()
      if (dropped && paths.length) await addManyToStash(paths)
    }

    list.addEventListener('pointerup', event => { finish(event) })
    list.addEventListener('pointercancel', () => { reset() })

    // 捕获阶段拦截那一次补发的 click（行是 button，click 会冒泡到列表）
    list.addEventListener('click', event => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }, true)
  }
  // 互关联②：暂存项 → 在右侧预览区打开。目录则打开该目录，文件则预览。
  async function previewStashItem(item) {
    if (item.missing) { toast('文件缺失，无法预览'); return }
    try {
      await openPath(item.path)
    } catch (error) {
      fail('预览失败：' + (error && error.message ? error.message : String(error)))
    }
  }

  async function bootStash() {
    say('正在加载…')
    await refresh()
    say('就绪')
  }


  // ================================================================ 外层分隔条（暂存栏 | 预览区）
  // 与内层 #split 同一套「起点 + 位移」算法：宽度 = 起点宽 + (当前X - 起点X)。
  // 用 --stash-w 控制左栏宽度并持久化到 localStorage（外层不做后端命令，简单可靠）。

  const FM_MIN = 200, FM_MAX = 640, FM_DEFAULT = 300
  const clampFm = n => (!Number.isFinite(n) ? FM_DEFAULT : Math.min(FM_MAX, Math.max(FM_MIN, n)))
  const applyFmWidth = () => {
    document.documentElement.style.setProperty('--stash-w', state.stashW + 'px')
    const sp = $('fmsplit'); if (sp) sp.setAttribute('aria-valuenow', String(state.stashW))
  }
  const saveFm = () => { try { localStorage.setItem('fm.stashW', String(state.stashW)) } catch { /* 存储不可用时忽略 */ } }

  function wireFmSplit() {
    try {
      const saved = Number(localStorage.getItem('fm.stashW'))
      if (Number.isFinite(saved) && saved > 0) state.stashW = clampFm(saved)
    } catch { /* 忽略 */ }
    applyFmWidth()
    const split = $('fmsplit')
    if (!split) return
    let dragging = false, startX = 0, startW = 0
    const down = event => {
      if (event.button !== undefined && event.button !== 0) return
      dragging = true; startX = event.clientX; startW = state.stashW
      split.setPointerCapture?.(event.pointerId)
      split.dataset.dragging = 'true'; document.body.dataset.resizing = 'true'
      event.preventDefault()
    }
    const move = event => {
      if (!dragging) return
      state.stashW = clampFm(startW + (event.clientX - startX))
      applyFmWidth()
    }
    const stop = () => {
      if (!dragging) return
      dragging = false; delete split.dataset.dragging; delete document.body.dataset.resizing
      saveFm()
    }
    split.addEventListener('pointerdown', down)
    split.addEventListener('pointermove', move)
    split.addEventListener('pointerup', stop)
    split.addEventListener('pointercancel', stop)
    split.addEventListener('lostpointercapture', stop)
    split.addEventListener('dblclick', () => { state.stashW = FM_DEFAULT; applyFmWidth(); saveFm() })
    split.addEventListener('keydown', event => {
      const step = event.shiftKey ? 48 : 16
      let next = null
      if (event.key === 'ArrowLeft') next = state.stashW - step
      else if (event.key === 'ArrowRight') next = state.stashW + step
      else if (event.key === 'Home') next = FM_DEFAULT
      if (next === null) return
      event.preventDefault()
      state.stashW = clampFm(next); applyFmWidth(); saveFm()
    })
  }

  // ================================================================ 启动（两套都启动）

  try { parent.postMessage({ type: 'fish:ready' }, '*') } catch { /* 宿主不可用时忽略 */ }
  new ResizeObserver(reportHeight).observe(document.documentElement)
  wireFmSplit()
  wireSplitter()
  wireBrowseSelect()
  drawSide()
  // 两套 boot 只读数据、不互斥；不能用 guard（它会因共享 state.busy 把第二个启动挡掉）。
  const bootSafe = fn => Promise.resolve().then(fn).catch(error => bad(error && error.message ? error.message : String(error)))
  bootSafe(bootPreview)
  bootSafe(bootStash)
})()
