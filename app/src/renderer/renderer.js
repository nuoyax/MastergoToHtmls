// 渲染进程 UI 逻辑
const $ = (id) => document.getElementById(id)
const api = window.mgApi

const log = (msg) => {
  $('log').textContent += `\n[${new Date().toLocaleTimeString()}] ${msg}`
  $('log').scrollTop = $('log').scrollHeight
}

// webview 注入脚本的诊断日志 → 主进程落盘 download/debug-render.log
window.addEventListener('message', (ev) => {
  const d = ev.data
  if (d && d.__mg_diag_log__ && window.mgApi?.logFile) {
    window.mgApi.logFile('[webview] ' + d.__mg_diag_log__)
  }
})

let resolvedUrl = null

// 1. 解析链接
$('btnParse').onclick = async () => {
  const text = $('input').value.trim()
  if (!text) return log('请先粘贴内容')
  try {
    const link = await api.resolveLink(text)
    resolvedUrl = link.url
    $('linkInfo').textContent = `fileId: ${link.fileId}\nlayerId: ${link.layerId ?? '(用pageId)'} ${
      link.pageId ?? ''
    }\n短链: ${link.isShortLink ? '是→已重定向' : '否'}\n${link.url}`
    $('btnOpen').disabled = false
    log('解析成功')
  } catch (err) {
    log('解析失败：' + err.message)
  }
}

// 2. 加载设计稿
$('btnOpen').onclick = () => {
  if (!resolvedUrl) return
  api.openDesign(resolvedUrl)
  $('btnExtract').disabled = false
  log('已请求 webview 加载：' + resolvedUrl)
}

// 刷新登录：清除 MasterGo 全部登录态（Cookie/本地存储）后回到首页。
// 500 "reading 'avatar'" 是会话 Cookie 残缺（gfsessionid 丢失）导致，
// 仅重载页面无法恢复，必须清掉残缺登录态让用户重新登录。
$('btnReLogin').onclick = async () => {
  log('刷新登录：清除登录态（Cookie/本地存储）…')
  try {
    const ok = await api.clearCookies()
    log(ok ? '登录态已清除，重新加载 mastergo.com…' : '清除失败（见主进程日志），尝试直接重载…')
  } catch (e) {
    log('清除异常：' + (e?.message ?? e))
  }
  try {
    wv.loadURL('https://mastergo.com')
  } catch (e) {
    log('刷新失败：' + (e?.message ?? e))
  }
}

// 注入逻辑在脚本加载时就把监听挂到 webview 上（不放在 onLoadUrl 里，
let lastUrl = null
const wv = $('webview')
let injecting = false
async function injectScript() {
  if (injecting) return
  injecting = true
  try {
    const src = await api.getInjectScript()
    await wv.executeJavaScript(src, true)
    log('注入脚本完成 (url=' + (wv.getAttribute?.('src') || '') + ')')
  } catch (e) {
    log('注入失败：' + (e?.message ?? e))
  } finally {
    injecting = false
  }
}
const onNav = (detail) => {
  // 防抖：同一次加载触发多个事件只注入一次
  setTimeout(() => injectScript(), 50)
}
wv.addEventListener('dom-ready', onNav)
wv.addEventListener('did-navigate', onNav)
wv.addEventListener('did-navigate-in-page', onNav)

api.onLoadUrl(async (url) => {
  lastUrl = url
  wv.loadURL(url)
  $('btnExtract').disabled = false
  log('已请求 webview 加载（导航后自动注入）')
  // 挂 CDP 调试器抓 /data/ XHR 响应体（页面用 XHR 而非 fetch，注入钩不到）
  try {
    const ids = await api.attachDebugger()
    log('CDP 调试器已挂载到 webContents: ' + JSON.stringify(ids))
  } catch (e) {
    log('调试器挂载失败：' + (e?.message ?? e))
  }
})

// 3. 提取 DSL（直接在 webview 内执行 —— 主进程 e.sender 是宿主窗口而非 webview，
// 之前走 IPC 提取永远查的是宿主页面，所以一直 NO_INJECT）
$('btnExtract').onclick = async () => {
  log('尝试提取图层树…')
  const wv = $('webview')
  // 兜底：若注入丢失，先补注入再提取
  const probe = await wv
    .executeJavaScript('(window.__MG_EXTRACT__ ? 1 : 0)', true)
    .catch(() => -1)
  if (probe !== 1) {
    log('注入丢失，重新注入…')
    await injectScript()
  }
  try {
    const raw = await wv.executeJavaScript(
      '(window.__MG_EXTRACT__ ? JSON.stringify(window.__MG_EXTRACT__.extractDsl()) : null)',
      true
    )
    if (raw && raw !== 'null' && raw !== 'undefined') {
      const dsl = JSON.parse(raw)
      const size = raw.length
      window.__dsl__ = dsl
      $('btnExport').disabled = false
      const focus = dsl.__focusLayerId
        ? `（图层定位模式：${dsl.__focusLayerId}，仅提取该图层）`
        : ''
      log('提取成功' + focus + '，节点数据：' + size + ' 字节')
      if (dsl.__truncated) log('⚠ 节点数撞提取上限，图层树被截断——导出可能缺块，建议用带 layer_id 的链接按图层提取')
      // 落盘 DSL 原始 JSON（冒烟回归 tests/smoke.mjs 输入）
      window.mgApi?.saveDsl?.(raw)?.then?.((r) => r && String(r).startsWith('D:') && log('DSL已落盘: ' + r))
      // 诊断：SVG 导出统计 + 图标区节点抽样落盘
      window.mgApi?.logFile?.('[extract] bytes=' + size + ' nodeCount=' + (dsl.__nodeCount ?? '?') + ' types=' + JSON.stringify(dsl.__typeCount || {}) + ' svg=' + JSON.stringify(dsl.__svgExport || {}))
    } else {
      const diag = await wv.executeJavaScript(
        '(window.__MG_EXTRACT__ ? JSON.stringify({probe: window.__MG_EXTRACT__.probe(), diag: window.__MG_EXTRACT__.diag()}) : "NO_INJECT")',
        true
      )
      log('未找到图层树。诊断: ' + diag)
      // webpack 桥探测
      try {
        const bdiag = await wv.executeJavaScript(
          '(window.__MG_EXTRACT__ ? JSON.stringify(window.__MG_EXTRACT__.probeBridge()) : "NO_INJECT")',
          true
        )
        log('webpack桥探测: ' + bdiag)
        const raw = await wv.executeJavaScript(
          '(window.__MG_EXTRACT__ ? JSON.stringify(window.__MG_EXTRACT__.extractDsl()) : null)',
          true
        )
        if (raw && raw !== 'null' && raw !== 'undefined') {
          const dsl = JSON.parse(raw)
          window.__dsl__ = dsl
          $('btnExport').disabled = false
          log('✅ webpack桥提取成功，节点数: ' + (dsl.__nodeCount ?? '?') + '，数据 ' + raw.length + ' 字节')
          window.mgApi?.saveDsl?.(raw)
          return
        }
      } catch (e) {
        log('webpack桥异常: ' + (e?.message ?? e))
      }
      await decodeViaPage()
    }
  } catch (e) {
    log('提取异常：' + (e?.message ?? e))
  }
}

// 4. 探测/重放解码（临时按钮逻辑并入按钮3：抓到二进制后用页面内 masterkit 解码）
async function decodeViaPage() {
  const wv = $('webview')
  // 1) 先看 CDP 抓到的响应
  const caps = await api.getCaptured()
  if (!caps.length) return log('CDP 尚未捕获到 /data/ 响应')
  log('CDP 已捕获 ' + caps.length + ' 个响应: ' + JSON.stringify(caps.map(c=>({size:c.size,url:c.url.slice(0,60)}))))
  // 2) 在页面里探测 masterkit 入口
  const probe = await wv.executeJavaScript(
    `(function(){const out={};` +
    `for (const k of ['masterkit','__masterkit__','Masterkit','wasmBundle']) out[k]=typeof window[k];` +
    `out.webpack = typeof window.webpackChunk_N_E !== 'undefined' ? window.webpackChunk_N_E.length : 'no';` +
    `return JSON.stringify(out)})()`,
    true
  )
  log('页面内探测: ' + probe)
}

// 4. 导出：DSL → HTML → ZIP（含切图目录 + 清单），写入传输列表
$('btnExport').onclick = async () => {
  const dsl = window.__dsl__
  if (!dsl) return log('尚未提取 DSL')
  if (!window.mgRender) return log('渲染器未加载（mg-render.js）')
  const mode = $('exportMode') ? $('exportMode').value : 'classic'
  if (mode !== 'classic') return exportMulti(dsl, mode)
  const { html, stats } = window.mgRender.renderDsl(dsl)
  log(`渲染完成：节点 ${stats.nodes}，文本 ${stats.texts}，图片 ${stats.images}`)
  // 切图批量导出（在 webview 内执行，拿到 base64 文件集）
  let slices = [], sliceFailed = []
  try {
    const format = $('sliceFormat').value
    const scales = [...$('sliceScales').selectedOptions].map((o) => +o.value)
    log(`切图导出中：${format} ${scales.length > 1 ? scales.join('/') + 'x' : ''} …`)
    const wv = $('webview')
    const raw = await wv.executeJavaScript(
      'window.__MG_EXTRACT__.exportSlices(' + JSON.stringify({ format, scales }) + ')', true
    )
    if (raw && raw.slices) {
      slices = raw.slices
      sliceFailed = raw.failed || []
      log(`切图：${slices.length} 个（失败 ${sliceFailed.length}）`)
    }
  } catch (e) {
    log('切图导出异常：' + (e?.message ?? e) + '（继续仅导出 HTML）')
  }
  try {
    const p = await api.exportHtml(html, slices)
    if (p) {
      log('✅ 已导出 ZIP：' + p)
      window.mgTransfer?.add({ name: p.split(/[\\/]/).pop(), path: p, status: 'done', size: Math.round(html.length / 1024) + 'KB html' + (slices.length ? ' + ' + slices.length + ' 切图' : '') })
    } else {
      log('已取消')
      window.mgTransfer?.add({ name: 'mastergo-export.zip', status: 'cancel' })
    }
  } catch (e) {
    log('导出失败：' + (e?.message ?? e))
    window.mgTransfer?.add({ name: 'mastergo-export.zip', status: 'error' })
  }
}

// 多页导出：renderDslMulti → 每画板独立页 + css/js 拆分，交主进程打包
async function exportMulti(dsl, mode) {
  if (!window.mgMulti) return log('多页渲染器未加载（mg-multi.js）')
  try {
    const { pages, indexHtml, assets, stats } = window.mgMulti.renderDslMulti(dsl, {
      layout: mode === 'multi-flow' ? 'flow' : 'absolute',
      splitFiles: true,
      js: true
    })
    log(
      `多页渲染完成：画板 ${pages.length}，节点 ${stats.nodes}，class ${stats.classes}` +
        (mode === 'multi-flow' ? `，流式容器 ${stats.flowContainers} / 绝对 ${stats.absContainers}` : '') +
        (stats.byCategory
          ? `，分类 mobile=${stats.byCategory.mobile || 0} / other=${stats.byCategory.other || 0} / icon跳过=${stats.byCategory.icon || 0}`
          : '')
    )
    if (stats.degrade && typeof stats.degradeTop === 'function') {
      const top = stats.degradeTop(3)
      if (top.length) log('流式降级 Top3：' + top.map(([r, n]) => `${r}×${n}`).join('，'))
    }
    // 切图（与 classic 相同链路）
    let slices = [], sliceFailed = []
    try {
      const format = $('sliceFormat').value
      const scales = [...$('sliceScales').selectedOptions].map((o) => +o.value)
      const wv = $('webview')
      const raw = await wv.executeJavaScript(
        'window.__MG_EXTRACT__.exportSlices(' + JSON.stringify({ format, scales }) + ')', true
      )
      if (raw && raw.slices) {
        slices = raw.slices
        sliceFailed = raw.failed || []
        log(`切图：${slices.length} 个（失败 ${sliceFailed.length}）`)
      }
    } catch (e) {
      log('切图导出异常：' + (e?.message ?? e) + '（继续仅导出 HTML）')
    }
    const p = await api.exportMulti({
      pages: pages.map(({ html, ...rest }) => ({ ...rest, html })),
      indexHtml,
      assets,
      slices,
      meta: {
        mode: 'multi',
        layout: mode === 'multi-flow' ? 'flow' : 'absolute',
        exportedAt: new Date().toISOString(),
        boards: pages.map((pg) => ({ slug: pg.slug, name: pg.name, layerId: pg.layerId, category: pg.category, width: pg.width, height: pg.height }))
      }
    })
    if (p) {
      log('✅ 已导出多页 ZIP：' + p)
      window.mgTransfer?.add({
        name: p.split(/[\\/]/).pop(), path: p, status: 'done',
        size: `${pages.length} 页 + ${Object.keys(assets).length} 资产` + (slices.length ? ' + ' + slices.length + ' 切图' : '')
      })
    } else {
      log('已取消')
    }
  } catch (e) {
    log('多页导出失败：' + (e?.message ?? e))
    window.mgTransfer?.add({ name: 'mastergo-multi.zip', status: 'error' })
  }
}

log('就绪。请先在右侧登录 mastergo.com')
