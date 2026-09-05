/**
 * 传输列表 —— 右上角下载图标 + 弹出面板
 * 记录每次导出（成功/失败/取消），点击条目可打开文件所在目录。
 */
;(function () {
  /** @type {{name:string,path:string,time:string,status:'done'|'error'|'cancel',size?:string}[]} */
  const items = []
  let open = false

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  // 注入样式
  const style = document.createElement('style')
  style.textContent = `
  #mgTransferBtn { position: fixed; top: 12px; right: 14px; z-index: 9999; width: 36px; height: 36px;
    border-radius: 50%; background: #fff; border: 1px solid #ddd; cursor: pointer; display: flex;
    align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
  #mgTransferBtn:hover { background: #f0f7ff; }
  #mgTransferBtn .badge { position: absolute; top: -4px; right: -4px; background: #e53935; color: #fff;
    font-size: 10px; min-width: 16px; height: 16px; line-height: 16px; border-radius: 8px; text-align: center; display: none; }
  #mgTransferPanel { position: fixed; top: 54px; right: 14px; z-index: 9999; width: 320px; max-height: 320px;
    overflow: auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.18); display: none; }
  #mgTransferPanel h4 { margin: 0; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #eee; }
  .mg-tx-item { padding: 8px 12px; border-bottom: 1px solid #f2f2f2; font-size: 12px; cursor: pointer; }
  .mg-tx-item:hover { background: #f5f7fa; }
  .mg-tx-item .t-name { font-weight: 600; word-break: break-all; }
  .mg-tx-item .t-meta { color: #888; margin-top: 2px; }
  .mg-tx-item.done .t-status { color: #2e7d32; } .mg-tx-item.error .t-status { color: #c62828; }
  .mg-tx-empty { padding: 16px 12px; color: #999; font-size: 12px; text-align: center; }
  `
  document.head.appendChild(style)

  // 传输图标（SVG 下载箭头）
  const btn = el('div', '', '')
  btn.id = 'mgTransferBtn'
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    '<span class="badge"></span>'
  const panel = el('div', '', '')
  panel.id = 'mgTransferPanel'
  panel.appendChild(el('h4', '', '传输列表'))
  const list = el('div', '', '')
  panel.appendChild(list)
  document.body.appendChild(btn)
  document.body.appendChild(panel)

  function render() {
    list.innerHTML = ''
    if (!items.length) {
      list.appendChild(el('div', 'mg-tx-empty', '暂无传输记录'))
    }
    items.forEach((it) => {
      const row = el('div', 'mg-tx-item ' + it.status)
      row.appendChild(el('div', 't-name', it.name))
      const meta = el('div', 't-meta', '')
      meta.textContent = `${it.time}  ${it.status === 'done' ? '完成' + (it.size ? ' · ' + it.size : '') : it.status === 'error' ? '失败' : '已取消'}${it.path ? ' · ' + it.path : ''}`
      row.appendChild(meta)
      if (it.status === 'done' && it.path && window.mgApi?.showInFolder) {
        row.title = '点击打开所在文件夹'
        row.onclick = () => window.mgApi.showInFolder(it.path)
      }
      list.appendChild(row)
    })
    const badge = btn.querySelector('.badge')
    const unfinished = items.filter((i) => i.status === 'error').length
    badge.style.display = items.length ? 'block' : 'none'
    badge.textContent = String(items.length)
    badge.style.background = unfinished ? '#e53935' : '#4caf50'
  }

  btn.onclick = () => {
    open = !open
    panel.style.display = open ? 'block' : 'none'
    if (open) render()
  }

  /** 供导出流程调用：addTransfer({name, path, status, size}) */
  window.mgTransfer = {
    add(entry) {
      items.unshift({
        name: entry.name || '未命名',
        path: entry.path || '',
        status: entry.status || 'done',
        size: entry.size || '',
        time: new Date().toLocaleTimeString(),
      })
      if (items.length > 50) items.pop()
      render()
    },
  }
  render()
})()
