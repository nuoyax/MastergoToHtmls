/**
 * webview 注入脚本 —— 在 mastergo.com 页面里运行，做两件事：
 *  1. 拦截 /data/ 响应，把原始二进制报告给主进程（留档/调试）
 *  2. 从页面里钩取 masterkit 解码后的图层树（多策略尝试），导出 JSON
 * 通过 window.__MG_EXTRACT__ 与 preload 通信。
 * 注意：本文件以 .js 直接 executeJavaScript 注入，禁止任何 TypeScript 语法！
 */
;(() => {
  if (window.__MG_EXTRACT_INSTALLED__) return
  window.__MG_EXTRACT_INSTALLED__ = true

  const post = (type, payload) => {
    window.postMessage({ __mg_channel__: true, type, payload }, '*')
  }

  // 诊断日志：透传到宿主窗口 → 主进程 → download/debug-render.log
  // webview 里的 console.log 用户看不到，排查提取问题全靠这条链路
  window.__mgLog = (msg) => {
    try { window.parent.postMessage({ __mg_diag_log__: String(msg) }, '*') } catch (e) {}
    try { console.log('[mg-inject]', msg) } catch (e) {}
  }
  window.addEventListener('message', (ev) => {
    const d = ev.data
    if (d && d.__mg_channel__ && d.type === 'injected') {
      window.__mgLog && window.__mgLog('injected @ ' + location.href)
    }
  })

  // ---------- 策略1：拦截 /data/ 响应 ----------
  const origFetch = window.fetch
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args)
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? ''
      if (url.includes('/data/')) {
        const clone = res.clone()
        const buf = await clone.arrayBuffer()
        post('data-response', {
          url,
          size: buf.byteLength,
          head: Array.from(new Uint8Array(buf.slice(0, 64)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        })
      }
    } catch {
      /* 拦截失败不影响页面 */
    }
    return res
  }

  // ---------- 策略2：定时探测图层树对象 ----------
  // 真正的图层树特征：节点有 layerType/type/id/name/children/fill 等字段，
  // 且体量较大。浅层的 DOCUMENT 壳（只有 id/name/children）不算。
  function scoreNode(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0
    const keys = Object.keys(obj)
    if (keys.length < 5) return 0
    let hit = 0
    for (const k of ['layerType', 'type', 'id', 'name', 'FillPaint', 'bounds', 'children', 'nodeMap', 'fill', 'stroke', 'absoluteBoundingBox', 'size', 'transform']) {
      if (k in obj) hit++
    }
    return hit
  }

  function looksLikeNodeMap(obj) {
    return scoreNode(obj) >= 5
  }

  function tryFindDsl() {
    // 2a. 常见全局挂载点
    for (const key of ['__MG_DSL__', '__masterkit__', 'masterkit', '__MG_BRIDGE__']) {
      if (window[key]) return window[key]
    }
    // 2b. 深度搜索 window（限深），挑"得分最高且最大"的对象
    const seen = new Set()
    let best = null
    let bestScore = 0
    const search = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return
      seen.add(obj)
      const s = scoreNode(obj)
      if (s >= 5) {
        let size = 0
        try { size = JSON.stringify(obj).length } catch { size = 0 }
        if (s > bestScore || (s === bestScore && best && size > JSON.stringify(best).length)) {
          best = obj
          bestScore = s
        }
      }
      try {
        for (const k of Object.keys(obj)) {
          const v = obj[k]
          if (v && typeof v === 'object') search(v, depth + 1)
        }
      } catch {
        /* 跨域/受保护对象 */
      }
    }
    search(window, 0)
    return best
  }

  // ---------- 策略3：拦截 /data/ 二进制响应并缓存原始数据 ----------
  // 官方前端拿到二进制后交给 masterkit.wasm 解码；我们截下原始字节留档，
  // 后续可在主进程/Node 侧重放解码，或作为图层树提取失败的兜底
  window.__MG_DATA_RESPONSES__ = []
  const origFetch2 = window.fetch
  window.fetch = async function (...args) {
    const res = await origFetch2.apply(this, args)
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? ''
      if (url.includes('/data/')) {
        const clone = res.clone()
        const buf = await clone.arrayBuffer()
        const entry = {
          url,
          size: buf.byteLength,
          head: Array.from(new Uint8Array(buf.slice(0, 64)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        }
        window.__MG_DATA_RESPONSES__.push(entry)
        post('data-response', entry)
      }
    } catch {
      /* 拦截失败不影响页面 */
    }
    return res
  }

  // ---------- 策略4：webpack 桥 —— 劫持 webpackJsonp 拿 __webpack_require__，
  // 在模块缓存里找持有 masterkit Module（有 getLayerData 等方法）的模块，
  // 然后直接调用官方内部 API 遍历页面图层树（逆向自 app.40d4e689.js）。
  // bridge 方法清单（wasm 导出）：getPageListVal / getAllChildren / getLayerData /
  // getLayerPropertyById / getPageData / getLayerDetail / encodeSelectLayers ...
  let __mgRequire = null
  function captureWebpackRequire() {
    if (__mgRequire) return true
    if (!Array.isArray(window.webpackJsonp)) return false
    // 劫持一次 push：webpack 加载 chunk 时会调用 push([chunkIds, modules, executeIds])
    // 我们塞一个假模块进去，运行时拿到 require
    const fakeChunkId = '__mg_probe_' + Date.now()
    // webpack4 标准格式: push([[chunkIds],{modules},[entryIds]])，
    // entryIds 会立即执行，从而拿到 __webpack_require__
    try {
      // 实测（逆向 runtime.1816cebb.js）：mastergo 是标准 webpack4，模块签名为
      // function(module, exports, __webpack_require__) —— require 是第 3 个参数！
      window.webpackJsonp.push([[fakeChunkId], { [fakeChunkId]: function () {
        const req = arguments[2]
        __mgRequire = typeof req === 'function' ? req : null
      } }, [[fakeChunkId]]])
    } catch (e) { /* push 劫持失败则放弃该策略 */ }
    return !!__mgRequire
  }

  function findMasterkitBridge() {
    if (!captureWebpackRequire()) {
      window.__mgLog && window.__mgLog('[bridge] webpackJsonp 劫持失败（webpackJsonp 不存在？）')
      return null
    }
    const isBridge = (o) => o && typeof o === 'object' &&
      typeof o.getLayerData === 'function' && typeof o.getPageListVal === 'function'
    try {
      // 首选：按逆向得到的模块 ID 直接 require（fcaa.b = bridge, fcaa.c = masterInstance）
      for (const mid of ['fcaa', 'ae3a']) {
        try {
          const exp = __mgRequire(mid)
          if (!exp) { window.__mgLog && window.__mgLog('[bridge] require(' + mid + ')=null'); continue }
          if (isBridge(exp)) { window.__mgLog && window.__mgLog('[bridge] 命中 ' + mid + ' 直连'); return exp }
          for (const k of Object.keys(exp)) {
            const v = exp[k]
            if (isBridge(v)) { window.__mgLog && window.__mgLog('[bridge] 命中 ' + mid + '.' + k); return v }
            if (v && typeof v === 'object' && isBridge(v.bridge)) { window.__mgLog && window.__mgLog('[bridge] 命中 ' + mid + '.' + k + '.bridge'); return v.bridge }
            if (v && typeof v === 'object' && isBridge(v.Module)) { window.__mgLog && window.__mgLog('[bridge] 命中 ' + mid + '.' + k + '.Module'); return v.Module }
          }
          window.__mgLog && window.__mgLog('[bridge] ' + mid + ' keys=' + Object.keys(exp).slice(0, 12).join(','))
        } catch (e) { window.__mgLog && window.__mgLog('[bridge] ' + mid + ' 异常: ' + String(e).slice(0, 80)) }
      }
      // 兜底：遍历模块缓存
      let hit = null
      const cache = __mgRequire.c || {}
      window.__mgLog && window.__mgLog('[bridge] 遍历缓存 cacheSize=' + Object.keys(cache).length)
      for (const id of Object.keys(cache)) {
        const mod = cache[id]
        const exp = mod && mod.exports
        if (!exp) continue
        if (isBridge(exp)) { hit = exp; window.__mgLog && window.__mgLog('[bridge] 缓存命中 ' + id); break }
        for (const k of Object.keys(exp)) {
          const v = exp[k]
          if (isBridge(v)) { hit = v; window.__mgLog && window.__mgLog('[bridge] 缓存命中 ' + id + '.' + k); break }
          if (v && typeof v === 'object' && isBridge(v.bridge)) { hit = v.bridge; window.__mgLog && window.__mgLog('[bridge] 缓存命中 ' + id + '.' + k + '.bridge'); break }
          if (v && typeof v === 'object' && isBridge(v.Module)) { hit = v.Module; window.__mgLog && window.__mgLog('[bridge] 缓存命中 ' + id + '.' + k + '.Module'); break }
        }
        if (hit) break
      }
      return hit
    } catch (e) { window.__mgLog && window.__mgLog('[bridge] 遍历异常: ' + String(e).slice(0, 80)); return null }
  }

  function buildLayerTree(bridge, maxNodes) {
    // 大文件（如 6 页/17k+ 节点的组件库稿）会撞默认 2 万上限：截断后部分画板
    // children 丢失 → 渲染缺块。上限提到 20 万；真超限时标记 __truncated 供上层提示。
    maxNodes = maxNodes || 200000
    let count = 0
    let truncated = false
    const seen = new Set()
    const typeCount = {}
    const result = { pages: [] }

    function nodeData(id) {
      if (count >= maxNodes) { truncated = true; return null }
      if (seen.has(id)) return null
      seen.add(id)
      let d = null
      try { d = bridge.getLayerData(id) } catch (e) { return null }
      if (!d) return null
      count++
      typeCount[d.type] = (typeCount[d.type] || 0) + 1
      const out = JSON.parse(JSON.stringify(d, (k, v) => {
        // 掉 ArrayBuffer / 函数等不可序列化字段
        if (typeof v === 'function' || v instanceof ArrayBuffer) return undefined
        if (v instanceof Uint8Array) return '[bytes:' + v.length + ']'
        return v
      }))
      out.id = id
      // 子节点：getLayerData 返回的 children 是 id 数组，递归展开
      if (d.children && Array.isArray(d.children) && d.children.length) {
        out.children = d.children.map((c) => nodeData(typeof c === 'object' ? c.id : c)).filter(Boolean)
      }
      return out
    }

    let pageIds = []
    try {
      const pages = bridge.getPageListVal()
      pageIds = (pages || []).map((p) => (typeof p === 'object' ? p.id : p)).filter(Boolean)
      window.__mgLog && window.__mgLog('[tree] getPageListVal → ' + (pages ? JSON.stringify(pages).slice(0, 200) : 'null'))
    } catch (e) { window.__mgLog && window.__mgLog('[tree] getPageListVal 异常: ' + String(e).slice(0, 120)) }
    if (!pageIds.length) pageIds = ['M']
    // 抽样验证 getLayerData 可用性：根 id 与 page id 各试一个
    try {
      const probeId = pageIds[0]
      const pd = bridge.getLayerData(probeId)
      window.__mgLog && window.__mgLog('[tree] getLayerData(' + probeId + ') → ' + (pd ? ('keys=' + Object.keys(pd).slice(0, 15).join(',') + ' children=' + (pd.children ? pd.children.length : 'n/a')) : 'null'))
    } catch (e) { window.__mgLog && window.__mgLog('[tree] getLayerData(page) 异常: ' + String(e).slice(0, 120)) }

    // 图层定位模式：URL 带 layer_id 时（如 /file/xxx?page_id=:16745&layer_id=0:109977），
    // 用户要的是「该图层作为一个页面」而非整个画布。定位该节点作为唯一顶层根。
    // URL 编码的冒号（%3A）由 searchParams 自动解码。
    let focusLayerId = null
    try { focusLayerId = new URLSearchParams(location.search).get('layer_id') } catch (e) {}
    if (focusLayerId) {
      const n = nodeData(focusLayerId)
      if (n) {        window.__mgLog && window.__mgLog('[tree] 图层定位模式: layer_id=' + focusLayerId + ' name=' + (n.name || '') + ' t' + n.type)
        const pid = new URLSearchParams(location.search).get('page_id') || pageIds[0] || 'M'
        const page = { pageId: pid, layers: [n] }
        result.pages.push(page)
        result.__nodeCount = count
        result.__typeCount = typeCount
        result.__focusLayerId = focusLayerId
        window.__mgLog && window.__mgLog('[tree] nodes=' + count + ' types=' + JSON.stringify(typeCount))
        return result
      }
      window.__mgLog && window.__mgLog('[tree] layer_id=' + focusLayerId + ' 定位失败（getLayerData 返回空），pageIds=' + JSON.stringify(pageIds) + '，尝试遍历子树查找…')
      // 兜底：layer_id 直查失败（wasm 可能尚未索引该节点或 id 形态不同），
      // 从 page 根逐层 getAllChildren 找 id 匹配节点再取数据
      const found = (function findInTree() {
        for (const pid of pageIds) {
          try {
            const kids = bridge.getAllChildren(pid) || []
            window.__mgLog && window.__mgLog('[tree] getAllChildren(' + pid + ') → ' + kids.length + ' 个')
            if (kids.some((k) => (typeof k === 'object' ? k.id : k) === focusLayerId)) {
              return nodeData(focusLayerId)
            }
          } catch (e) { window.__mgLog && window.__mgLog('[tree] getAllChildren(' + pid + ') 异常: ' + String(e).slice(0, 120)) }
        }
        return null
      })()
      if (found) {
        window.__mgLog && window.__mgLog('[tree] 子树查找命中 layer_id=' + focusLayerId)
        const pid = new URLSearchParams(location.search).get('page_id') || pageIds[0] || 'M'
        result.pages.push({ pageId: pid, layers: [found] })
        result.__nodeCount = count
        result.__typeCount = typeCount
        result.__focusLayerId = focusLayerId
        return result
      }
    }

    // 状态栏（电池/信号/时间"9:41"）用户最终决定保留，不剪枝
    for (const pid of pageIds) {
      try {
        const childIds = bridge.getAllChildren(pid) || []
        const page = { pageId: pid, layers: [] }
        for (const cid of childIds) {
          const n = nodeData(typeof cid === 'object' ? cid.id : cid)
          if (n) page.layers.push(n)
        }
        result.pages.push(page)
      } catch (e) { result.pages.push({ pageId: pid, error: String(e) }) }
    }
    result.__nodeCount = count
    result.__typeCount = typeCount
    if (truncated) {
      result.__truncated = true
      window.__mgLog && window.__mgLog('[tree] ⚠ 节点数撞上限 ' + maxNodes + '，树被截断（__truncated）')
    }
    window.__mgLog && window.__mgLog('[tree] nodes=' + count + ' types=' + JSON.stringify(typeCount))
    return result
  }

  // 切图导出：官方 bundle 模块 0152（逆向确认）导出 b=Ae(id)→SVG 字符串、
  // e=Ee(ids)→多选 SVG。对无填充数据的矢量/图标节点（type 33/35，fills 为空）
  // 用它拿 SVG，转 dataURI 塞进节点 __svgData，渲染器直接当背景图用。
  function findSvgExportModule() {
    if (!captureWebpackRequire()) return null
    try {
      const exp = __mgRequire('0152')
      if (exp && typeof exp.b === 'function') return exp
    } catch (e) {}
    // 兜底：遍历缓存找「入参 id 返回含 <svg 字符串」的模块
    const cache = __mgRequire.c || {}
    for (const id of Object.keys(cache)) {
      const exp = cache[id] && cache[id].exports
      if (exp && typeof exp.b === 'function' && typeof exp.e === 'function') {
        try {
          // 探测签名：不给真实 id，仅确认不抛「非函数」类错误
          if (exp.b.length <= 3) return exp
        } catch (e) {}
      }
    }
    return null
  }

  /** 通用选择算法：官方 SVG 是权威视觉，凡是"形状承载视觉"的节点都应走官方
   *  导出，CSS 还原（fill/border/radius 拼装）只做兜底。判定标准与具体控件无关：
   *  ① type 33/35 矢量节点：必导；
   *  ② type 12 圆形：CSS 只能画纯色圆，渐变/描边细节丢失，必导；
   *  ③ type 9/13 且 ≤240px（组件级尺寸）且带可见 fill/stroke/cornerRadius：
   *     小组件的视觉由形状定义（滑块轨道、按钮底、胶囊），一律导整图。
   *  >240px 的大容器是布局载体（页面背景、卡片），仍走 CSS 以保留文本/图片。
   *  排除项：官方 b(id) 导出的 SVG 只含矢量形状，不含文本与图片。因此
   *  子树含文本/图片的容器不能整体拍平——否则白底/灰底 rect 替代了真实
   *  内容（头像被剪成白块、"透明裁剪容器被涂白"）。矢量叶子不受影响。 */
  function nodeNeedsSvgExport(n, depth) {
    if (!n || typeof n !== 'object') return false
    if (depth <= 0) return false // 顶层画板是布局载体，不整体拍平
    const t = n.type
    if (t === 33 || t === 35) return true
    if (t === 9 || t === 12 || t === 13) {
      if (subtreeHasRichContent(n)) return false
      // 组内任意深度含矢量子节点（电源开关=圆+弧+竖线、图标按钮=圆底+符号
      // 这类"整体图标"）：整组一张官方 SVG 直接展示，与 MasterGo 前端一致；
      // 不再逐叶子拼装（圆底一张图、符号又一张图，各自画布/居中基准不同，
      // 叠起来必错位——用户视角这就是把一个图标拆成两半写）。官方 SVG 已含
      // 子树全部形状，导出后剪掉 children。深查而非只查直接孩子：图标按钮
      // 结构常是 组(底框+符号框) 两层嵌套。≤240px 保证只拍平组件级容器。
      if (t === 9) {
        const w0 = n.width || 0
        const h0 = n.height || 0
        // 先标低置信度（含 type13 退化矩阵的加号组），再走常规矢量组拍平
        const lc9 = lowConfidenceStructure(n)
        if (lc9) {
          n.__lowConf = lc9
          window.__mgLog && window.__mgLog('[lowconf] ' + n.id + '(' + (n.name || '') + ' t' + t + ') ' + lc9)
          return true
        }
        if (w0 <= 240 && h0 <= 240 && subtreeHasVector(n)) return true
      }
      // 低置信度结构（多层蒙版/高密度矢量/退化矩阵矢量）CSS 无法拼装，不限尺寸一律官方 SVG
      const lc = lowConfidenceStructure(n)
      if (lc) {
        n.__lowConf = lc
        window.__mgLog && window.__mgLog('[lowconf] ' + n.id + '(' + (n.name || '') + ' t' + t + ') ' + lc)
        return true
      }
      const w = n.width || 0
      const h = n.height || 0
      if (w > 240 || h > 240) return false
      if (t === 12) return true
      if (hasVisualPaint(n)) return true
    }
    return false
  }
  /** 低置信度结构（通用判定，与具体控件无关）：
   *  ① 子树蒙版 ≥ 2 —— 多层蒙版/蒙版套蒙版的合成视觉，CSS 只有 overflow:hidden
   *     一层裁剪，还原必错；
   *  ② 子树矢量叶（33/35）≥ 8 —— 高密度矢量组合（描边细节、布尔运算结果），
   *     fill/border 拼装只能近似；
   *  ③ 子树任一节点矩阵退化（scale 0 + skew≠0，即 90° 旋转被矩阵分解压扁）
   *     —— 不限 type：加号竖条是 type 13 矩形带退化矩阵；仅查 33/35 会漏掉，
   *     官方单叶 SVG 虽可自带 transform，但整组（圆钮+符号）一张 SVG 更稳。
   *  前提：子树无文本/图片（官方 SVG 承载不了），由调用方 subtreeHasRichContent 保证 */
  function lowConfidenceStructure(n) {
    let masks = 0, vectors = 0, degenerate = false
    const isDegenerate = (x) => {
      const m = x.m_relativeMatrix || {}
      const sx = m.scaleX !== undefined ? m.scaleX : 1
      const sy = m.scaleY !== undefined ? m.scaleY : 1
      return (sx === 0 || sy === 0) && !(m.skewX === 0 && m.skewY === 0)
    }
    const walk = (x) => {
      if (!x || typeof x !== 'object' || (masks >= 2 && vectors >= 8) || degenerate) return
      if (x.isMask === true) masks++
      if (isDegenerate(x)) { degenerate = true; return }
      if (x.type === 33 || x.type === 35) {
        vectors++
      }
      if (masks >= 2 || vectors >= 8) return
      ;(x.children || []).forEach(walk)
    }
    walk(n)
    if (masks >= 2) return 'multi-mask'
    if (vectors >= 8) return 'dense-vector'
    if (degenerate) return 'degenerate-vector'
    return null
  }
  /** 子树是否含文本或图片（官方 SVG 无法承载的内容）——含则禁拍平 */
  function subtreeHasRichContent(n) {
    if (fillHasImage(n)) return true
    const kids = n.children || []
    for (const c of kids) {
      if (!c) continue
      if (c.type === 25) return true
      if (fillHasImage(c)) return true
      if (subtreeHasRichContent(c)) return true
    }
    return false
  }
  /** 子树任意深度含"视觉由形状承载"的节点 —— "整体图标"判定依据。
   *  不只查矢量（33/35）：按钮内外圈（t12 椭圆+描边）、形状叶子（带 fill/stroke
   *  的 t9/t13 叶）这类结构 CSS 只能逐件拼装，圆底一张、内圈一张、符号又一张，
   *  各自画布基准不同叠起来必错位/拆散视觉整体。只要子树有形状类节点，整组
   *  一张官方 SVG 才与 MasterGo 前端一致（前提：无文本/图片，调用方已保证）。 */
  function subtreeHasVector(n) {
    const kids = n.children || []
    for (const c of kids) {
      if (!c) continue
      if (c.type === 33 || c.type === 35 || c.type === 12) return true
      // 形状叶子：无孩子的 t9/t13 且带可见填充/描边（如 Combined Shape、加号竖条）
      if ((c.type === 9 || c.type === 13) && !(c.children && c.children.length) && hasVisualPaint(c)) return true
      if (subtreeHasVector(c)) return true
    }
    return false
  }
  function fillHasImage(n) {
    // imageRef 非空才算真图片；渐变/纯色填充的 image 字段是空壳（imageRef=""）
    return (n.fills || []).some((f) => f && f.image && f.image.imageRef)
  }
  function hasVisualPaint(n) {
    if (Array.isArray(n.fills) && n.fills.some((f) => f && f.isVisible !== false)) return true
    if (Array.isArray(n.strokes) && n.strokes.some((s) => s && s.isVisible !== false)) return true
    let cr = n.cornerRadius
    if (Array.isArray(cr)) cr = cr[0]
    if (typeof cr === 'object' && cr) cr = cr.topLeft ?? cr.radius
    return typeof cr === 'number' && cr > 0
  }

  function exportMissingSvgs(tree) {
    /** SVG 是否带真实几何：官方导出对拿不到矢量数据的节点（组件实例符号、
     *  嵌套 frame 叶）会返回 <path d=""> 空壳 —— 算导出成功但画不出东西，
     *  若盖 __svgData 渲染器会把它当权威视觉剪掉孩子，图标凭空消失。
     *  通用判定：任一 path 的 d 为空即视为"不完整"（官方完整图形不会含空
     *  path；空 path 意味着某个子形状的几何没拿到，如 +/- 圆钮里的符号），
     *  其余形状标签出现即可 */
    function svgHasRealGeometry(svg) {
      if (/<path\b[^>]*?\bd=""[^>]*\/?>/.test(svg) || /<path\b[^>]*?\bd=''/ .test(svg)) return false
      if (/<path\b[^>]*?\bd="[^"][^"]*"/.test(svg)) return true
      return /<(rect|ellipse|circle|polygon|polyline|line|image)\b/.test(svg)
    }
    let exp
    try { exp = findSvgExportModule() } catch (e) { return { tried: 0, ok: 0 } }
    if (!exp) {
      window.__mgLog && window.__mgLog('[svg-export] module 0152 未找到，全部图标走 div 还原')
      return { tried: 0, ok: 0, reason: 'module-0152-not-found' }
    }
    const MAX_TRY = 2500
    // 两阶段：先收集候选，再按面积升序导出——小图标（+/-、功能色标）优先，
    // 避免大容器/状态栏 path 先占满额度导致加号/摆风整组漏导
    const candidates = []
    const collect = (n, depth, ancestors) => {
      if (!n || typeof n !== 'object') return
      if (nodeNeedsSvgExport(n, depth)) {
        const area = Math.max(1, (n.width || 0) * (n.height || 0))
        // 含退化矩阵 / 低置信度的整组加权提前（面积视作更小）
        let lc = n.__lowConf
        if (!lc) {
          lc = lowConfidenceStructure(n)
          if (lc) n.__lowConf = lc
        }
        const boost = lc ? 0.01 : 1
        candidates.push({ n, depth, ancestors: (ancestors || []).slice(), area: area * boost })
      }
      if (n.children) n.children.forEach((c) => collect(c, (depth || 0) + 1, (ancestors || []).concat(n)))
    }
    for (const p of tree.pages || []) (p.layers || []).forEach((l) => collect(l, 0, []))
    candidates.sort((a, b) => a.area - b.area)

    let tried = 0, ok = 0
    const failSamples = []
    const stampedIds = new Set()
    for (const { n, ancestors } of candidates) {
      if (tried >= MAX_TRY) break
      if (stampedIds.has(n.id)) continue
      // 祖先已整组导出并剪掉子树时，跳过后代
      if (ancestors.some((a) => a.__svgData && !a.children)) continue
      tried++
      let stamped = false
      try {
        const svg = exp.b(n.id)
        if (typeof svg === 'string' && svg.indexOf('<svg') >= 0 && svgHasRealGeometry(svg)) {
          n.__svgData = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
          ok++
          stamped = true
          stampedIds.add(n.id)
          // 容器级 SVG：子树形状已包含，剪掉 children 防止 div 双重叠加
          if (n.type === 9 || n.type === 13) n.children = undefined
        } else if (Array.isArray(ancestors)) {
          // 单叶空几何：自底向上找第一个"导出有真实几何、子树无文本/图片"
          // 的祖先，整组件一张 SVG 替代（该祖先会剪掉整棵子树，叶子随之覆盖）
          for (const a of ancestors) {
            if (stampedIds.has(a.id)) { stamped = true; break }
            const w = a.width || 0, h = a.height || 0
            if (w > 240 || h > 240) break // 超出组件级尺寸的祖先不拍平
            try {
              const asvg = exp.b(a.id)
              if (typeof asvg === 'string' && asvg.indexOf('<svg') >= 0 && svgHasRealGeometry(asvg) && !subtreeHasRichContent(a)) {
                a.__svgData = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(asvg)
                a.children = undefined
                ok++
                stamped = true
                stampedIds.add(a.id)
                window.__mgLog && window.__mgLog('[svg-export] 叶空几何→祖先兜底: ' + n.id + '(' + (n.name || '') + ') ← ' + a.id + '(' + (a.name || '') + ')')
                break
              }
            } catch (e) { /* 试下一个祖先 */ }
          }
        }
        if (!stamped && failSamples.length < 15) {
          failSamples.push(n.id + '(' + (n.name || '') + ' t' + n.type + ' ' + (n.width || 0) + 'x' + (n.height || 0) + (svg && svg.indexOf('<svg') >= 0 ? ' empty-geom' : '') + ')')
        }
      } catch (e) {
        if (failSamples.length < 15) failSamples.push(n.id + ' EX:' + String(e).slice(0, 40))
      }
    }
    window.__mgLog && window.__mgLog('[svg-export] tried=' + tried + ' ok=' + ok + ' candidates=' + candidates.length + ' fails: ' + failSamples.join(' | '))
    return { tried, ok, candidates: candidates.length }
  }

  // 切图批量导出：对切图节点拿官方 SVG，并按格式/倍图栅格化（canvas）。
  // format: 'svg'|'png'|'jpg'|'webp'；scales: [1,2,3]（svg 忽略倍图）
  function collectSliceNodes(tree, max) {
    max = max || 500
    const out = []
    const seen = new Set()
    const walk = (n, frame) => {
      if (!n || typeof n !== 'object' || out.length >= max) return
      // 矢量组（type 33 含 children）＝完整图标；type 33 无 children（散碎
      // path）若被上层组导过就跳过——靠官方 SVG 以树为单位的包含关系判断：
      // 只要某祖先已被收集，后代不再重复收集
      // 整体图标规则与渲染侧一致（nodeNeedsSvgExport）：type 9/12/13 的
      // 小尺寸矢量组（≤240px、子树有矢量、无富文本）也按"一个完整图标"
      // 收集切图，避免彩色图标组（如 自/定/宠/重）漏导出只出散碎 path
      const wholeIconGroup =
        (n.type === 9 || n.type === 12 || n.type === 13) &&
        (n.width || 0) <= 240 &&
        (n.height || 0) <= 240 &&
        subtreeHasVector(n) &&
        !subtreeHasRichContent(n)
      // exports 标记只在组件级尺寸（≤240px）可信：实测 bridge 返回的树里
      // 连 375x812 的整块画板都带 exports=true，若无条件采信，整个页面会
      // 被当成一张切图导出，真正的图标反而不下钻收集。大容器一律视为
      // 画板/布局载体，继续下钻。
      const small = (n.width || 0) <= 240 && (n.height || 0) <= 240
      const isSlice =
        n.type === 35 ||
        (Array.isArray(n.exports) && n.exports.length > 0 && small) ||
        (n.type === 33 && n.children && n.children.length >= 1) ||
        wholeIconGroup
      const isFrame = n.type === 9 && (n.width || 0) > 100
      if (isFrame) frame = n
      if (isSlice && (n.width || 0) >= 2 && (n.height || 0) >= 2 && !seen.has(n.id)) {
        seen.add(n.id)
        n.__frameName = frame && frame !== n ? sanitizeName(frame.name) : ''
        out.push(n)
        // 该节点子树整体由官方 SVG 渲染，不再下钻收集散碎 path
        return
      }
      if (n.children) n.children.forEach((c) => walk(c, frame))
    }
    for (const p of tree.pages || []) (p.layers || []).forEach((l) => walk(l, null))
    return out
  }

  function sanitizeName(s) {
    return String(s || 'slice').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 60)
  }

  function rasterizeSvg(svgText, w, h, scale, format) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const vw = Math.max(1, Math.ceil(w * scale))
      const vh = Math.max(1, Math.ceil(h * scale))
      img.onload = () => {
        try {
          const cv = document.createElement('canvas')
          cv.width = vw; cv.height = vh
          const ctx = cv.getContext('2d')
          if (!ctx) return reject(new Error('no 2d ctx'))
          if (format === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, vw, vh) }
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, 0, 0, vw, vh)
          const mime = format === 'jpg' ? 'image/jpeg' : 'image/' + format
          resolve(cv.toDataURL(mime, 0.92).split(',')[1])
        } catch (e) { reject(e) }
      }
      img.onerror = () => reject(new Error('svg image decode failed'))
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText)
    })
  }

  // 对外暴露给主进程调用的提取函数
  window.__MG_EXTRACT__ = {
    extractDsl() {
      // 优先：webpack 桥直调官方 API（最可靠）
      try {
        const bridge = findMasterkitBridge()
        if (bridge) {
          const tree = buildLayerTree(bridge)
          if (tree && tree.__nodeCount > 0) {
            tree.__source = 'webpack-bridge'
            try {
              const r = exportMissingSvgs(tree)
              tree.__svgExport = r
              console.log('[mg-extract] 切图 SVG 导出:', JSON.stringify(r))
            } catch (e) { tree.__svgExport = { error: String(e) } }
            return tree
          }
        }
      } catch (e) { /* fallthrough */ }
      // 兜底：window 深搜
      return tryFindDsl()
    },
    /**
     * 切图批量导出（在 webview 内执行，返回可传输的纯数据）。
     * @param {{format:'svg'|'png'|'jpg'|'webp', scales:number[]}} opts
     * @returns {Promise<{slices:{name,dir,files:{file,b64}[]}[], failed:string[], moduleFound:boolean}>}
     */
    async exportSlices(opts) {
      opts = opts || {}
      const format = opts.format || 'svg'
      const scales = format === 'svg' ? [1] : (opts.scales && opts.scales.length ? opts.scales : [1, 2])
      const bridge = findMasterkitBridge()
      if (!bridge) return { slices: [], failed: ['bridge-not-found'], moduleFound: false }
      const expMod = findSvgExportModule()
      if (!expMod) return { slices: [], failed: ['svg-export-module-not-found'], moduleFound: false }
      // 用上一次提取的树？不行——注入脚本无状态，重新建树（只收集切图节点，不整树序列化）
      const tree = buildLayerTree(bridge)
      const nodes = collectSliceNodes(tree)
      const usedNames = new Map()
      const slices = []
      const failed = []
      for (const n of nodes) {
        let svgText = null
        try {
          svgText = expMod.b(n.id)
          if (typeof svgText !== 'string' || svgText.indexOf('<svg') < 0) svgText = null
        } catch (e) { svgText = null }
        if (!svgText) { failed.push(n.id + ':' + (n.name || '')); continue }
        let name = sanitizeName(n.name)
        const c = usedNames.get(name) || 0
        usedNames.set(name, c + 1)
        if (c > 0) name = name + '_' + c
        const files = []
        for (const sc of scales) {
          const suffix = scales.length > 1 ? '@' + sc + 'x' : ''
          const file = name + suffix + '.' + format
          try {
            if (format === 'svg') {
              files.push({ file, b64: btoa(unescape(encodeURIComponent(svgText))) })
            } else {
              const b64 = await rasterizeSvg(svgText, n.width || 20, n.height || 20, sc, format)
              files.push({ file, b64 })
            }
          } catch (e) { failed.push(file + ':' + String(e).slice(0, 60)) }
        }
        // 目录：归属画板/切图名；清单里体现
        slices.push({ name, dir: (n.__frameName ? n.__frameName + '/' : '') + name, files })
      }
      return { slices, failed: failed.slice(0, 50), moduleFound: true, total: nodes.length }
    },
    /** 诊断：window 深搜的命中统计 */
    /** webpack 桥单独探测（诊断用） */
    probeBridge() {
      try {
        const b = findMasterkitBridge()
        if (b) return { found: true, methods: ['getLayerData','getPageListVal','getAllChildren','getDirectChild'].filter((m)=>typeof b[m]==='function') }
        // 细化诊断：require 有了但缓存里找不到桥 —— 看缓存规模和 fcaa 是否在
        const out = { found: false, hasWebpack: !!window.webpackJsonp, requireCaptured: !!__mgRequire }
        if (__mgRequire) {
          out.requireType = typeof __mgRequire
          const cache = __mgRequire.c || {}
          out.cacheSize = Object.keys(cache).length
          out.fcaaInCache = !!cache['fcaa']
          out.ae3aInCache = !!cache['ae3a']
          // 直接 require fcaa 看导出形态
          try {
            const exp = __mgRequire('fcaa')
            out.fcaaKeys = exp ? Object.keys(exp) : null
            if (exp && exp.b) out.fcaaBProto = Object.getPrototypeOf(exp.b)?.constructor?.name ?? null
            if (exp && exp.b) out.fcaaBMethods = ['getLayerData','getPageListVal','getAllChildren'].filter((m)=>typeof exp.b[m]==='function')
          } catch (e) { out.fcaaRequireError = String(e).slice(0, 120) }
        }
        return out
      } catch (e) { return { error: String(e) } }
    },
    diag() {
      const seen = new Set()
      let candidates = 0
      let maxDepth = 0
      const stats = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return
        seen.add(obj)
        maxDepth = Math.max(maxDepth, depth)
        if (scoreNode(obj) >= 3) candidates++
        try {
          for (const k of Object.keys(obj)) {
            const v = obj[k]
            if (v && typeof v === 'object') stats(v, depth + 1)
          }
        } catch {}
      }
      stats(window, 0)
      return { scanned: seen.size, candidates, maxDepth, dataResponses: (window.__MG_DATA_RESPONSES__ || []).length }
    },
    probe() {
      return {
        hasMasterkit: !!window.masterkit || !!window.__masterkit__,
        dslFound: !!tryFindDsl(),
        dslSize: (() => { try { const d = tryFindDsl(); return d ? JSON.stringify(d).length : 0 } catch { return 0 } })(),
        dataResponses: (window.__MG_DATA_RESPONSES__ || []).map((r) => ({ url: r.url, size: r.size })),
      }
    },
  }

  post('injected', { href: location.href })
  console.log('[mg-extract] 注入完成')
})()
