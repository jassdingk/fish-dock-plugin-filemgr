// 文件暂存的「岛子面板」页：单窗口多形态（球↔条）。窗口几何由宿主补间，
// 这里让 #pill 铺满窗口并按当前宽度连续改圆角 —— 视觉上小球平滑长成长条，
// 不会出现“大透明框里一个小球”。
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

  const pill = $('#pill')
  // 球↔条的连续过渡：宽度从 36 到 100 之间，圆角由 18(正圆) 连续降到 12(圆角条)；
  // 100 以上完全按条渲染（chips）。阈值 100 让“计数球 → chips”切换发生在已经比较宽的阶段。
  const BALL_MAX = 180, BALL_MIN = 36, R_BALL = 18, R_BAR = 12
  function shape() {
    const w = window.innerWidth || 1
    const t = Math.max(0, Math.min(1, (BALL_MAX - w) / (BALL_MAX - BALL_MIN)))
    pill.style.borderRadius = (R_BAR + t * (R_BALL - R_BAR)) + 'px'
    document.body.classList.toggle('ball', w < BALL_MAX)
  }

  async function refresh() {
    try { const r = await call('stash.list', {}); items = (r && r.items) || [] } catch (_) { items = [] }
    paint(); measure()
  }

  let lastH = 0, measureTimer = 0
  function measure() {
    clearTimeout(measureTimer)
    measureTimer = setTimeout(() => {
      if (document.body.classList.contains('ball')) return      // 球态/过渡态不报高度
      const chips = $('#chips'), head = $('#head')
      if (!chips) return
      let chipsH = 0
      if (chips.children.length) {
        let minT = Infinity, maxB = -Infinity
        for (const c of chips.children) {
          const r = c.getBoundingClientRect()
          if (r.top < minT) minT = r.top
          if (r.bottom > maxB) maxB = r.bottom
        }
        chipsH = maxB - minT
      }
      const headH = head ? head.offsetHeight : 24
      const h = Math.ceil(headH + 4 + chipsH + 20)
      if (Math.abs(h - lastH) >= 6) { lastH = h; call('stash.resize', { height: h }).catch(() => {}) }
    }, 80)
  }

  function paint() {
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
    shape()
  }

  function closeWin() { try { if (FD && typeof FD.call === 'function') FD.call('stash.hideBar', {}) } catch (_) {} }

  // 球态点整块 → 展开长条；条态点击空白不触发（只按钮响应）。
  pill.addEventListener('click', e => {
    if (!document.body.classList.contains('ball')) return
    if (e.target.closest('button')) return
    try { if (FD && typeof FD.call === 'function') FD.call('stash.showBar', {}) } catch (_) {}
  })
  const moreBtn = $('#more'); if (moreBtn) moreBtn.addEventListener('click', e => {
    e.stopPropagation()
    try { if (FD && typeof FD.call === 'function') FD.call('stash.openManager', {}) } catch (_) {}
  })
  const closeBtn = $('#close'); if (closeBtn) closeBtn.addEventListener('click', e => { e.stopPropagation(); closeWin() })
  const clearBtn = $('#clear'); if (clearBtn) clearBtn.addEventListener('click', async e => {
    e.stopPropagation()
    try { const ids = items.map(i => i.id); if (ids.length) await call('stash.remove', { ids }); await refresh() } catch (_) {}
  })

  // 宿主补间会连续触发 resize：形状每帧即时更新（radius 连续），重排内容稍防抖。
  let paintTimer = 0
  window.addEventListener('resize', () => {
    shape()
    clearTimeout(paintTimer)
    paintTimer = setTimeout(() => { paint(); measure() }, 120)
  })
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeWin() })
  window.addEventListener('dragenter', () => document.body.classList.add('dragover'))
  window.addEventListener('dragleave', () => document.body.classList.remove('dragover'))
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => e.preventDefault())
  if (FD && FD.fileDrop && typeof FD.fileDrop.onEvent === 'function') {
    try {
      FD.fileDrop.onEvent(ev => {
        if (!ev) return
        if (ev.phase === 'enter') document.body.classList.add('dragover')
        else if (ev.phase === 'leave') document.body.classList.remove('dragover')
        else if (ev.phase === 'drop') { document.body.classList.remove('dragover'); refresh() }
      })
    } catch (_) {}
  }
  shape()
  refresh()
  setInterval(refresh, 1500)
})()
