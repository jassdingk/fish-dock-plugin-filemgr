// 文件暂存的「岛子面板」页：由插件自己渲染子岛 UI，经 bridge 独立窗口模式与宿主通信。
// 数据走 FishDock.call('stash.*')；窗口由插件后端在收到 fileDrop 时 FishDock.windows.open 打开。
;(function () {
  const $ = s => document.querySelector(s)
  const FD = window.FishDock
  const call = (m, p) => (FD && typeof FD.call === 'function') ? FD.call(m, p) : Promise.reject(new Error('no bridge'))
  const ICON = it => {
    const name = (it.name || String(it.path || '').split(/[\\/]/).pop() || '').toLowerCase()
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
    const k = it.kind || ''
    if (k === 'dir' || it.isDir) return '📁'
    if (k === 'image') return '🖼️'
    if (k === 'video') return '🎬'
    if (k === 'audio') return '🎵'
    if (k === 'pdf') return '📕'
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return '🗜️'
    if (k === 'office' || ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt'].includes(ext)) return '📄'
    if (k === 'code' || ['js', 'ts', 'py', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'css', 'html', 'json'].includes(ext)) return '💻'
    if (k === 'text' || k === 'markdown' || ext === 'md') return '📝'
    return '📎'
  }
  const nameOf = it => it.name || String(it.path || '').split(/[\\/]/).pop() || '文件'
  let items = []

  async function refresh() {
    try { const r = await call('stash.list', {}); items = (r && r.items) || [] } catch (_) { items = [] }
    paint()
  }
  function paint() {
    const ballMode = window.innerWidth < 70
    document.body.classList.toggle('ball', ballMode)
    const bn = $('#balln'); if (bn) bn.textContent = items.length > 99 ? '99+' : (items.length ? String(items.length) : '')
    const chips = $('#chips'); chips.replaceChildren()
    for (const it of items) {
      const chip = document.createElement('div'); chip.className = 'chip' + (it.missing ? ' missing' : '')
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = ICON(it)
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = nameOf(it); nm.title = it.path || ''
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = '移除'
      x.addEventListener('click', async e => { e.stopPropagation(); try { await call('stash.remove', { ids: [it.id] }); await refresh() } catch (_) {} })
      chip.append(ic, nm, x); chips.append(chip)
    }
    const em = $('#empty'); if (em) em.style.display = items.length ? 'none' : 'block'
  }

  // 收起/关闭：走规范 windows.close（句柄由宿主经 ?wkey= 注入到 FishDock.windowSelf）。
  function closeWin() {
    try {
      const h = (FD && FD.windowSelf) || null
      if (FD && FD.windows && typeof FD.windows.close === 'function') FD.windows.close(h || 'stash')
    } catch (_) {}
  }
  const ball = $('#ball'); if (ball) ball.addEventListener('click', () => document.body.classList.remove('ball'))
  const closeBtn = $('#close'); if (closeBtn) closeBtn.addEventListener('click', e => { e.stopPropagation(); closeWin() })
  const clearBtn = $('#clear'); if (clearBtn) clearBtn.addEventListener('click', async e => {
    e.stopPropagation()
    try { const ids = items.map(i => i.id); if (ids.length) await call('stash.remove', { ids }); await refresh() } catch (_) {}
  })
  window.addEventListener('resize', paint)
  // Esc 关闭窗口（规范：原生关闭出口之一）。
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeWin() })
  window.addEventListener('dragenter', () => document.body.classList.add('dragover'))
  window.addEventListener('dragleave', () => document.body.classList.remove('dragover'))
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => e.preventDefault())
  refresh()
  setInterval(refresh, 5000)
})()
