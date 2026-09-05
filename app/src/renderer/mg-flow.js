/**
 * 流式布局推断（里程碑⑤ 多页导出 T2）
 * 输入：容器节点（含 children）→ 输出 { flow, containerCss, kids, reason }
 * 策略：保守推断——兄弟包围盒对齐比较，任一降级条件命中即整容器回退绝对定位。
 * 参考 Anima / FigmaToCode / 蓝湖同类「容器级 flex 推断 + 降级」工程实践。
 */
;(function () {
  'use strict'

  const EPS = 2 // 坐标/尺寸容差 px
  const MAX_KIDS = 40 // 子节点数上限，超出降级
  const OVERLAP_MAX = 0.15 // 两两重叠面积占较小者比例上限

  /** 兄弟节点视觉包围盒（宽高缺失视为不可推断） */
  function boxOf(n) {
    const w = n.width, h = n.height
    if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return null
    const m = n.m_relativeMatrix || {}
    const tx = m.transX || 0, ty = m.transY || 0
    const sx = m.scaleX ?? 1, sy = m.scaleY ?? 1
    // 只接受无旋转（skew≈0）、等比正/负缩放（镜像可归一化），否则无法用 flex 表达
    const skew = Math.abs(m.skewX || 0) + Math.abs(m.skewY || 0)
    if (skew > 0.01) return { rot: true }
    return { x: tx, y: ty, w: Math.abs(w * sx), h: Math.abs(h * sy), flip: sx < 0 || sy < 0 }
  }

  /** 是否可流式化。返回 true 或降级原因字符串 */
  function canFlow(node) {
    const kids = (node.children || []).filter((c) => c && !c.isMask)
    if (!kids.length) return 'no-children'
    if (kids.length !== (node.children || []).length) return 'has-mask-child'
    if (kids.length > MAX_KIDS) return 'too-many-children(' + kids.length + ')'
    const boxes = []
    for (const c of kids) {
      if (c.__lowConf) return 'low-conf(' + (c.name || c.id) + ')'
      if (typeof c.width !== 'number' || typeof c.height !== 'number') return 'missing-size(' + (c.name || c.id) + ')'
      const b = boxOf(c)
      if (!b) return 'no-box(' + (c.name || c.id) + ')'
      if (b.rot) return 'rotated(' + (c.name || c.id) + ')'
      if (b.flip) return 'flipped(' + (c.name || c.id) + ')' // flex 表达不了镜像孩子
      boxes.push(b)
    }
    // 两两重叠检测
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ox > 0 && oy > 0) {
          const ov = ox * oy
          const smaller = Math.min(a.w * a.h, b.w * b.h)
          if (smaller > 0 && ov / smaller > OVERLAP_MAX) return 'overlap(' + (kids[i].name || i) + '+' + (kids[j].name || j) + ')'
        }
      }
    return true
  }

  /** y 区间是否同行（重叠超过一半矮者视为同一行） */
  function sameRow(a, b) {
    const ov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return ov > Math.min(a.h, b.h) * 0.5
  }

  /** 方向/wrap 判定：返回 {dir:'row'|'column', wrap:boolean} 或 null */
  function detectDirection(boxes) {
    const sorted = [...boxes].sort((p, q) => p.y - q.y || p.x - q.x)
    // 聚类成行
    const rows = []
    for (const b of sorted) {
      const row = rows.find((r) => sameRow(r[0], b))
      if (row) row.push(b)
      else rows.push([b])
    }
    for (const r of rows) r.sort((p, q) => p.x - q.x)
    const xs = boxes.map((b) => b.x)
    const ys = boxes.map((b) => b.y)
    const allSame = (arr) => arr.every((v) => Math.abs(v - arr[0]) <= EPS)

    if (rows.length === 1) {
      if (allSame(xs)) return { dir: 'column' }
      // 单行 x 严格递增 → row；有重复 x 档位（≥2 列）→ row+wrap 不成立，回退
      const xSorted = [...new Set(xs.map((v) => Math.round(v / EPS) * EPS))]
      if (xSorted.length === boxes.length) return { dir: 'row' }
      return null
    }
    if (rows.length === boxes.length) {
      // 每行一个 → 纵向排列；x 全对齐则 column，否则多列网格降级
      if (allSame(xs)) return { dir: 'column' }
      return null
    }
    // 多行多列：x 档位数 ≈ 每行列数 且每行元素数一致 → row+wrap
    const counts = rows.map((r) => r.length)
    if (allSame(counts.map((c) => c)) && counts[0] > 1) return { dir: 'row', wrap: true }
    return null
  }

  /** 主轴序列分析：gap / padding / space-between。seq = [{p, s}]（起点、尺寸，沿主轴） */
  function detectSpacing(seq, dir) {
    const sorted = [...seq].sort((a, b) => a.p - b.p)
    const first = sorted[0]
    const gaps = []
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].p - (sorted[i - 1].p + sorted[i - 1].s))
    // 负 gap（重叠）已在 canFlow 排除大部分，这里仍防御
    if (gaps.some((g) => g < -EPS)) return null
    const allEq = gaps.length && gaps.every((g) => Math.abs(g - gaps[0]) <= EPS)
    const pad = first.p >= EPS ? Math.round(first.p) : 0
    if (allEq) return { gap: Math.round(gaps[0]), padding: pad, justify: null }
    // 等差递增 → space-between（首起点应为 0）
    if (gaps.length > 2) {
      const d = gaps[1] - gaps[0]
      const isArith = gaps.every((g, i) => i === 0 || Math.abs(g - gaps[i - 1] - d) <= EPS)
      if (isArith && Math.abs(first.p) <= EPS && Math.abs(d) > EPS) return { gap: 0, padding: 0, justify: 'space-between' }
    }
    return null
  }

  /** 交叉轴对齐：返回 'flex-start' | 'center' | 'flex-end' | null */
  function detectAlign(items, containerSize, crossOf) {
    const starts = items.map(crossOf)
    const ends = items.map((it, i) => starts[i] + it.s)
    const allSame = (arr) => arr.every((v) => Math.abs(v - arr[0]) <= EPS)
    if (allSame(starts)) return 'flex-start'
    if (allSame(ends)) return 'flex-end'
    if (containerSize) {
      const centers = items.map((it, i) => starts[i] + it.s / 2)
      if (allSame(centers) && Math.abs(centers[0] - containerSize / 2) <= EPS) return 'center'
      // 容器尺寸未知时，仅中心互相对齐也接受（用 padding 补偿不可行，降级）
    }
    return null
  }

  /** 四舍五入到整数 px（|v|<0.5 → 0），用于 margin 补偿 */
  function mpx(v) {
    return Math.round(v) + 'px'
  }

  /**
   * 推断容器布局。
   * @param node 容器节点（width/height 为容器尺寸，children 坐标相对容器）
   * @returns {flow:boolean, reason:string, containerCss:string, kids:Map<id,string>}
   */
  function inferLayout(node) {
    const verdict = canFlow(node)
    if (verdict !== true) return { flow: false, reason: verdict, containerCss: '', kids: null }
    const kids = node.children.filter((c) => !c.isMask)
    const boxes = kids.map((c) => ({ node: c, box: boxOf(c) }))
    const dirInfo = detectDirection(boxes.map((b) => b.box))
    if (!dirInfo) return { flow: false, reason: 'no-direction', containerCss: '', kids: null }

    const cw = node.width, ch = node.height
    const kidsCss = new Map()
    let css = 'display:flex;'
    const crossKey = dirInfo.dir === 'row' ? 'h' : 'v' // row 交叉轴是高度

    if (dirInfo.dir === 'row') {
      css += 'flex-direction:row;'
      const seq = boxes.map((b) => ({ p: b.box.x, s: b.box.w }))
      const sp = detectSpacing(seq, 'row')
      if (!sp) return { flow: false, reason: 'row-spacing', containerCss: '', kids: null }
      if (sp.gap) css += 'gap:' + sp.gap + 'px;'
      if (sp.padding) css += 'padding-left:' + sp.padding + 'px;'
      if (sp.justify) css += 'justify-content:' + sp.justify + ';'
      if (dirInfo.wrap) css += 'flex-wrap:wrap;'
      const align = detectAlign(boxes.map((b) => ({ s: b.box.h })), ch, (it, i) => boxes[i].box.y)
      if (align && align !== 'flex-start') css += 'align-items:' + align + ';'
      // 子元素偏移补偿（下同）：子 div 剥掉 position/left/top 后在 flex 流内用
      // margin-left 恢复设计 x 偏移（首个孩子的起点由容器 padding 表达）；
      // 交叉轴 y 偏移由 align-items 表达不了的个体差异用 margin-top 补。
      // 例外：y 各异且非整体对齐（如 space-between 的自由纵向散布）已由上面的
      // align 判定兜底——拿不到对齐方式时 align 为 null，y 偏移只能丢给
      // margin-top 逐个补偿，这里统一照做保证落点正确。
      for (const b of boxes) {
        const isRowWrap = !!dirInfo.wrap
        let kid = 'flex-shrink:0;'
        const bx = b.box.x, by = b.box.y
        if (isRowWrap) {
          kid += 'margin-left:' + mpx(bx) + ';margin-top:' + mpx(by) + ';'
        } else {
          if (bx > EPS) kid += 'margin-left:' + mpx(bx) + ';'
          if (by > EPS && align !== 'center' && align !== 'flex-end') kid += 'margin-top:' + mpx(by) + ';'
          else if (by > EPS && align === 'center') kid += 'margin-top:' + mpx(by - (ch - b.box.h) / 2) + ';'
        }
        kidsCss.set(b.node.id, kid)
      }
    } else {
      css += 'flex-direction:column;'
      const seq = boxes.map((b) => ({ p: b.box.y, s: b.box.h }))
      const sp = detectSpacing(seq, 'column')
      if (!sp) return { flow: false, reason: 'column-spacing', containerCss: '', kids: null }
      if (sp.gap) css += 'gap:' + sp.gap + 'px;'
      if (sp.padding) css += 'padding-top:' + sp.padding + 'px;'
      if (sp.justify) css += 'justify-content:' + sp.justify + ';'
      const align = detectAlign(boxes.map((b) => ({ s: b.box.w })), cw, (it, i) => boxes[i].box.x)
      if (align && align !== 'flex-start') css += 'align-items:' + align + ';'
      // column：主轴是 y（首个起点由 padding-top 表达），交叉轴 x 用 margin-left
      for (const b of boxes) {
        let kid = 'flex-shrink:0;'
        const bx = b.box.x, by = b.box.y
        if (by > EPS) kid += 'margin-top:' + mpx(by) + ';'
        if (bx > EPS && align !== 'center' && align !== 'flex-end') kid += 'margin-left:' + mpx(bx) + ';'
        else if (bx > EPS && align === 'center') kid += 'margin-left:' + mpx(bx - (cw - b.box.w) / 2) + ';'
        kidsCss.set(b.node.id, kid)
      }
    }
    return { flow: true, reason: 'ok(' + dirInfo.dir + (dirInfo.wrap ? '+wrap' : '') + ')', containerCss: css, kids: kidsCss }
  }

  const mgFlow = { inferLayout, canFlow, detectDirection, detectSpacing, detectAlign }
  if (typeof window !== 'undefined') window.mgFlow = mgFlow
  if (typeof module !== 'undefined' && module.exports) module.exports = mgFlow
})()
