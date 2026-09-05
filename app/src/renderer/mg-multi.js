/**
 * 多画板分页导出（里程碑⑤ T3）：renderDslMulti
 * - 每个画板一个独立 HTML 页（pages/<slug>/index.html）
 * - html/css/js 拆分：视觉样式进 class（css/main.css），位置留 inline
 * - layout:'flow' 时容器级流式推断（mg-flow.js），推断不出的子树降级绝对定位
 * - classic renderDsl 保持不动
 */
;(function () {
  'use strict'

  const mgFlow = (typeof require === 'function' && typeof window === 'undefined')
    ? require('./mg-flow.js')
    : (typeof window !== 'undefined' ? window.mgFlow : null)
  const mgRender = (typeof require === 'function' && typeof window === 'undefined')
    ? require('./mg-render.js')
    : (typeof window !== 'undefined' ? window.mgRender : null)

  const round = (v) => Math.round((+v || 0) * 100) / 100

  /** 文件名安全化（与 mg-inject.js sanitizeName 同规则） */
  function sanitizeName(name) {
    const s = String(name || 'board').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').trim()
    return (s || 'board').slice(0, 60)
  }

  /** djb2 hash → 6 位 base36（class 命名去重用） */
  function hash6(str) {
    let h = 5381
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
    return (h >>> 0).toString(36).padStart(6, '0').slice(-6)
  }

  /**
   * style 收集器：整串 style 作为 key 剔除 left/top 后入 Map → class 名。
   * 位置（left/top）留 inline；其余视觉属性进共享 class。
   */
  function createClassCollector() {
    const map = new Map() // styleKey → className
    const classes = [] // [{name, decls}] 保序
    return {
      /** 输入完整 css 串，返回 {inline, class} */
      split(css) {
        if (!css) return { inline: '', cls: '' }
        const decls = css.split(';').map((s) => s.trim()).filter(Boolean)
        const inlineParts = []
        const classParts = []
        for (const d of decls) {
          const k = d.slice(0, d.indexOf(':')).trim().toLowerCase()
          if (k === 'left' || k === 'top') inlineParts.push(d)
          else classParts.push(d)
        }
        if (!classParts.length) return { inline: inlineParts.join(';') + ';', cls: '' }
        const key = classParts.join(';')
        let name = map.get(key)
        if (!name) {
          name = 'mg-' + hash6(key)
          map.set(key, name)
          classes.push({ name, decls: key })
        }
        return { inline: inlineParts.join(';') + ';', cls: name }
      },
      cssText() {
        return classes.map((c) => `.${c.name}{${c.decls}}`).join('\n')
      },
      count() {
        return classes.length
      }
    }
  }

  /** 基础占位脚本：图片失败降级 + data-layer-id 点击高亮 */
  const BASE_JS = `/* MasterGo 导出基础脚本 */
document.addEventListener('error', function (e) {
  var el = e.target
  if (el && el.tagName === 'IMG' && !el.dataset.mgFailed) {
    el.dataset.mgFailed = '1'
    el.style.background = 'repeating-linear-gradient(45deg,#eee 0 8px,#e0e0e0 8px 16px)'
  }
}, true)
if (location.search.indexOf('debug=1') >= 0) {
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-layer-id]')
    if (el) {
      document.querySelectorAll('.__mg_hl').forEach(function (x) { x.classList.remove('__mg_hl') })
      el.classList.add('__mg_hl')
      console.log('[mg] layer', el.dataset.layerId, el.className)
      e.preventDefault()
    }
  }, true)
  var st = document.createElement('style')
  st.textContent = '.__mg_hl{outline:2px solid #f43 !important;outline-offset:-2px}'
  document.head.appendChild(st)
}
`

  const RESET_CSS = `/* MasterGo 导出共享样式 */
div { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
img { display: block; }
.page-wrap { position: relative; background: #fff; margin: 24px auto; box-shadow: 0 2px 12px rgba(0,0,0,.12); overflow: hidden; }
.board-title { padding: 8px 16px; font: 13px/1.5 sans-serif; color: #333; background: #f7f7f7; border-bottom: 1px solid #eee; }
.index-grid { display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; }
.index-card { display: block; width: 220px; text-decoration: none; color: #333; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }
.index-card:hover { border-color: #888; }
.index-card .thumb { display: flex; align-items: center; justify-content: center; height: 140px; background: #fafafa; color: #aaa; font: 28px/1 sans-serif; }
.index-card .meta { padding: 8px 12px; font: 12px/1.6 sans-serif; }
.index-card .meta .name { font-weight: 600; word-break: break-all; }
.index-card .meta .dim { color: #999; }
.__mg_hl { outline: 2px solid #f43 !important; outline-offset: -2px; }
.index-cat { padding: 24px 24px 0; margin: 0; font: 16px/1.4 sans-serif; color: #222; }
.index-cat small { color: #999; font-size: 13px; font-weight: normal; }
`

  /**
   * 顶层图层按尺寸分类：
   * - mobile：手机/桌面屏幕级（宽≥300 且高≥600，或宽≥600 且高≥900）
   * - icon：图标/按钮组件级（最长边≤64，或「小条状」短边≤80 且长边≤250）
   * - other：其余（横幅、组件片段等）
   * icon 级不单独出页（图标走切图 slices/），mobile/other 各生成页面并分组。
   */
  function classifyBoard(w, h) {
    const a = Math.max(w, h), b = Math.min(w, h)
    if ((w >= 300 && h >= 600) || (w >= 600 && h >= 900)) return 'mobile'
    if (a <= 64 || (b <= 80 && a <= 250)) return 'icon'
    return 'other'
  }

  /**
   * 多页导出主入口
   * @param {object} dsl
   * @param {{layout?:'flow'|'absolute', splitFiles?:boolean, js?:boolean}} options
   */
  function renderDslMulti(dsl, options) {
    const opts = Object.assign({ layout: 'flow', splitFiles: true, js: true }, options)
    const stats = { nodes: 0, boards: 0, flowContainers: 0, absContainers: 0, classes: 0, degrade: {}, byCategory: { mobile: 0, icon: 0, other: 0 } }
    const collector = createClassCollector()

    function count(node) {
      if (!node) return
      stats.nodes++
      ;(node.children || []).forEach(count)
    }

    /** 单画板 → 独立 HTML 文档 */
    function renderBoard(l) {
      const m = l.m_relativeMatrix || {}
      const ox = m.transX || 0, oy = m.transY || 0
      const w = round(l.width || 375), h = round(l.height || 812)
      const inner = renderBoardInner(l, ox, oy)
      stats.boards++
      const title = (l.name || '').replace(/</g, '&lt;')
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title || 'Board'}</title>
<link rel="stylesheet" href="${opts.splitFiles ? '../../../css/main.css' : 'data:text/css,'}">
${opts.splitFiles ? pageStyleTag() : ''}
</head>
<body>
<div class="board-title">${title} <small>(${w}×${h})</small></div>
<div class="page-wrap" style="width:${w}px;height:${h}px;" data-layer-id="${l.id || ''}">
${inner}
</div>
${opts.js && opts.splitFiles ? '<script src="../../../js/main.js"></script>' : ''}
</body>
</html>`
    }

    // 每页独立 class 作用域：同一样式串在不同页可复用；splitFiles=false 时内嵌
    let pageCollector = null
    function pageStyleTag() {
      return '<style>\n' + pageCollector.cssText() + '\n</style>'
    }

    /**
     * 画板内递归渲染（ctx.emit 走 class 拆分；flow 模式对可推断容器生成 flex wrapper css）
     * 与 mg-render.renderNode 的差异：顶层节点坐标相对画布，需减画板原点
     */
    function renderBoardInner(board, ox, oy) {
      // 直接复用 mg-render.renderNode：传 ctx（emit 走 collector），顶层 ox/oy
      return mgRender.renderNode(board, 0, ox, oy, makeCtx())
    }

    /**
     * flow 模式的容器级流式化（T7）：
     * renderNode 走到「容器最终返回点」时 emit(css, kids, node) 会带上 node 引用。
     * 此处对带 children 的容器调 mgFlow.inferLayout：
     *   - 成功 → 容器 css 换 flex（保 width/height/视觉属性），子 div 由
     *     mg-flow 给出的 kids map 中的规则改写 inline（去 left/top 主轴偏移）；
     *     但子 div 已由 renderNode 递归生成完毕，位置串在各自 inline 里 ——
     *     简化实现：容器仍然包住子 div，但把容器改为 flex 并对子 div 注入
     *     margin 偏移替代绝对定位（见 rewriteKids）。
     *   - 失败 → 保持绝对定位，记 stats.degrade[reason]。
     * 注意：文本/图标/SVG 剪枝节点不会走到容器返回点（node 无 children），天然跳过。
     */
    function tryFlowize(css, inner, node) {
      if (opts.layout !== 'flow' || !mgFlow || !node || !(node.children || []).length) return null
      const verdict = mgFlow.inferLayout(node)
      if (verdict.flow !== true) {
        const r = String(verdict.reason || 'unknown').replace(/\(.*$/, '')
        stats.degrade[r] = (stats.degrade[r] || 0) + 1
        stats.absContainers++
        return null
      }
      stats.flowContainers++
      // 容器 css：保留 position/left/top（父级往往是绝对定位容器，剥掉后容器会
      // 掉到文档流原点，整体内容错位——Feed 页文本重叠的根因）。display:flex +
      // position:absolute 可以共存：容器仍钉在设计坐标，子元素在内部按 flex 流排。
      // 子 div 由 rewriteKids 去 position/left/top 改 margin 偏移。
      const keep = css
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      // 子 div 改写：把 inline 的 position:absolute;left:X;top:Y 换成 flex 内 margin 偏移
      const rewritten = rewriteKids(inner, verdict, node)
      return { css: keep.join(';') + ';' + verdict.containerCss, inner: rewritten }
    }

    /** 把容器内层 HTML 的顶层子 div 的 position/left/top 改写为 flex 流内 margin */
    function rewriteKids(inner, verdict, node) {
      // 只匹配「顶层直接子 div」：emit 产出的每个孩子是一段完整的顶层 HTML，
      // 不能用全局 /<div/g —— 那会把嵌套后代的 div 也消费掉，kidCss 错位注入
      // 到深层节点上，导致布局错乱（Feed 页文本重叠的根因）。
      // 做法：按顶层切分（深度计数），逐段处理。
      const kids = (verdict && verdict.kids) || new Map()
      const parts = []
      let depth = 0, segStart = 0, kidIdx = 0
      const re = /<div\b[^>]*>|<\/div>/g
      let m
      while ((m = re.exec(inner)) !== null) {
        if (m[0] === '</div>') {
          depth--
          if (depth === 0) { parts.push(inner.slice(segStart, m.index + 6)); segStart = m.index + 6 }
        } else {
          if (depth === 0 && m.index > segStart) parts.push(inner.slice(segStart, m.index))
          if (depth === 0) segStart = m.index
          depth++
        }
      }
      if (segStart < inner.length) parts.push(inner.slice(segStart))
      return parts.map((part) => {
        const open = /<div\b[^>]*>/.exec(part)
        if (!open) return part
        const child = node.children && node.children[kidIdx]
        kidIdx++
        const kidCss = child ? kids.get(child.id) : null
        if (!kidCss) return part
        const attrs = open[0]
        const mm = /style="([^"]*)"/.exec(attrs)
        if (!mm) return part
        const decls = mm[1]
          .split(';')
          .map((x) => x.trim())
          .filter(Boolean)
          .filter((d) => !/^(position|left|top):/.test(d))
        const newStyle = decls.join(';') + (decls.length ? ';' : '') + kidCss
        return part.replace(attrs, attrs.replace(/ style="[^"]*"/, ` style="${newStyle}"`))
      }).join('')
    }

    // ctx 工厂：emit(css, inner) → 拆 class + inline；flow 模式容器级流式化
    function makeCtx() {
      return {
        emit(css, inner, node) {
          const flowed = tryFlowize(css, inner, node)
          if (flowed) {
            const { inline, cls } = pageCollector.split(flowed.css)
            const clsAttr = cls ? ` class="${cls}"` : ''
            const styleAttr = inline ? ` style="${inline}"` : ''
            return `<div${clsAttr}${styleAttr}>${flowed.inner}</div>`
          }
          const { inline, cls } = pageCollector.split(css)
          const clsAttr = cls ? ` class="${cls}"` : ''
          const styleAttr = inline ? ` style="${inline}"` : ''
          return `<div${clsAttr}${styleAttr}>${inner}</div>`
        }
      }
    }

    // ---- 组装 ----
    // icon 级顶层图层不生成页面（尺寸过小，图标走切图 slices/），
    // mobile/other 各生成独立页并按类分组到 pages/<category>/。
    const pages = []
    const seenSlug = new Map()
    ;(dsl.pages || []).forEach((page) => {
      ;(page.layers || []).forEach((l) => {
        count(l)
        // 隐藏画板（isVisible:false / isHidden）不出页面——否则导出空页（如同名画板的 -2 副本）
        if (l.isVisible === false || l.isHidden) return
        const w = round(l.width || 375), h = round(l.height || 812)
        const cat = classifyBoard(w, h)
        stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1
        if (cat === 'icon') return
        const base = sanitizeName(l.name)
        const n = (seenSlug.get(base) || 0) + 1
        seenSlug.set(base, n)
        const slug = n > 1 ? `${base}-${n}` : base
        pageCollector = createClassCollector()
        const html = renderBoard(l)
        stats.classes += pageCollector.count()
        pages.push({
          slug,
          name: l.name || slug,
          layerId: l.id || '',
          category: cat,
          width: w,
          height: h,
          html
        })
      })
    })

    /** 流式降级原因 Top N（log 用） */
    stats.degradeTop = (n) =>
      Object.entries(stats.degrade)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)

    const assets = {
      'css/main.css': RESET_CSS,
      'js/main.js': opts.js ? BASE_JS : ''
    }
    if (!opts.splitFiles) {
      // 单文件退化：全部内嵌（pages html 已内嵌 style，css 走 main 内嵌）
      assets['css/main.css'] = ''
      assets['js/main.js'] = ''
    }

    // index 导航页：按分类分区（mobile / other），区块标题带数量
    const CAT_LABEL = { mobile: '移动端', other: '其他' }
    const sections = ['mobile', 'other']
      .map((cat) => {
        const list = pages.filter((p) => p.category === cat)
        if (!list.length) return ''
        const cards = list
          .map(
            (p) => `<a class="index-card" href="pages/${encodeURIComponent(p.category)}/${encodeURIComponent(p.slug)}/index.html" data-layer-id="${p.layerId}">
  <div class="thumb">${(p.name || '?').slice(0, 1).replace(/</g, '&lt;')}</div>
  <div class="meta"><div class="name">${(p.name || '').replace(/</g, '&lt;')}</div>
  <div class="dim">${p.width}×${p.height}</div></div>
</a>`
          )
          .join('\n')
        return `<h2 class="index-cat">${CAT_LABEL[cat]} <small>(${list.length})</small></h2>
<div class="index-grid">
${cards}
</div>`
      })
      .filter(Boolean)
      .join('\n')
    const skippedIcon = stats.byCategory.icon || 0
    const indexHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MasterGo Export</title>
<link rel="stylesheet" href="css/main.css">
</head>
<body>
<div class="board-title">MasterGo 导出 · ${pages.length} 个画板 · 布局:${opts.layout}${skippedIcon ? ` · 图标级已跳过 ${skippedIcon} 个（见切图）` : ''}</div>
${sections}
${opts.js && opts.splitFiles ? '<script src="js/main.js"></script>' : ''}
</body>
</html>`

    return { pages, indexHtml, assets, stats }
  }

  const mgMulti = { renderDslMulti, sanitizeName, hash6, createClassCollector, classifyBoard }
  if (typeof window !== 'undefined') window.mgMulti = mgMulti
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mgMulti
  }
})()
