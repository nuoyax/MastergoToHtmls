/**
 * DSL → HTML 渲染器（里程碑④，绝对定位保真版）
 * 输入：webpack 桥提取的图层树 JSON（masterkit getLayerData 结构）
 * 输出：自包含 index.html（内联 CSS，绝对定位还原）
 *
 * 节点字段约定（逆向自 masterkit，见技术架构文档 §2.1）：
 *  - type: 9=Frame 25=Text 13=Rectangle 35=Image/Icon 12=Oval 33=Vector Path
 *  - m_relativeMatrix: {transX, transY, scaleX, scaleY, ...} 相对父节点定位
 *  - fills: [{type, isVisible, color:{r,g,b,a}, image:{imageRef, scaleMode}}]
 *  - type=25 的文本在 blocks: [{text, style:{fontSize, fontFamily, ...}}]
 *  - groupType 2/3 为分组容器；isHidden/isVisible 控制显隐
 */
;(function () {
  /** masterkit color {red,green,blue,alpha 0~1} → css rgba
   *  兼容 {r,g,b,a} 简写字段、CSS 字符串、0~255 数值区间 */
  function toColor(c, alphaOverride) {
    if (!c) return null
    if (typeof c === 'string') return c
    const r = c.red ?? c.r
    const g = c.green ?? c.g
    const b = c.blue ?? c.b
    if (r === undefined || g === undefined || b === undefined) return null
    const scale = r > 1 || g > 1 || b > 1 ? 1 : 255
    const a = alphaOverride !== undefined ? alphaOverride : (c.alpha ?? c.a ?? 1)
    return `rgba(${Math.round(r * scale)},${Math.round(g * scale)},${Math.round(b * scale)},${Number(a).toFixed(3)})`
  }

  /** fills → css background（取第一个可见填充；type 0 纯色、type 有 imageRef 的图片） */
  /** 渐变填充（type 1）→ css linear-gradient
   *  gradientHandlePositions: [起点, 终点(, 宽度)] 归一化 0~1；
   *  gradientStops: [{position 0~1, color:{red,green,blue,alpha 0~1}}] */
  function gradientToCss(f) {
    const g = f.gradient || {}
    const stops = g.gradientStops || []
    if (!stops.length) return ''
    const rgb = (c) => {
      const col = toColor(c, c.alpha !== undefined ? c.alpha : 1)
      return col || 'rgba(0,0,0,1)'
    }
    const parts = stops
      .map((s) => `${rgb(s.color)} ${Math.round((s.position || 0) * 1000) / 10}%`)
      .join(',')
    // 句柄方向 → 角度（默认自上而下 180deg）
    let deg = 180
    const hp = g.gradientHandlePositions
    if (hp && hp.length >= 2) {
      const dx = (hp[1].x || 0) - (hp[0].x || 0)
      const dy = (hp[1].y || 0) - (hp[0].y || 0)
      if (dx || dy) deg = Math.round((Math.atan2(dx, dy) * 180) / Math.PI)
    }
    return `background-image:linear-gradient(${deg}deg,${parts});`
  }

  function fillToCss(fills) {
    if (!Array.isArray(fills)) return ''
    for (const f of fills) {
      if (!f || f.isVisible === false) continue
      const im = f.image
      if (im && im.imageRef) {
        // MasterGo 图片 CDN；scaleMode 0=fill(fit cover) 1=fit(contain)
        const url = `https://image-resource.mastergo.com/${im.imageRef}`
        const mode = im.scaleMode === 1 ? 'contain' : 'cover'
        return `background-image:url('${url}');background-size:${mode};background-position:center;background-repeat:no-repeat;`
      }
      // 渐变（type 1）：真视觉在 gradient.gradientStops；f.color 只是首色兜底
      if (f.type === 1) {
        const g = gradientToCss(f)
        if (g) return g
      }
      // 真透明度在 color.alpha（如滑条底 4% 黑）；顶层 f.alpha 常是 1 的冗余字段，
      // 不能反过来覆盖 color 内的值 —— 仅当 color 自身缺 alpha 时才用 f.alpha 兜底
      const col = toColor(f.color, f.color && f.color.alpha !== undefined ? undefined : f.alpha)
      if (col) return `background-color:${col};`
    }
    return ''
  }

  /** 阴影/模糊 effects → css box-shadow（内外阴影、drop-shadow） */
  function effectsToCss(effects) {
    if (!Array.isArray(effects) || !effects.length) return ''
    const shadows = []
    for (const e of effects) {
      if (!e || e.isVisible === false) continue
      const col = toColor(e.color) || 'rgba(0,0,0,0.25)'
      const off = `${round(e.offset?.x || 0)}px ${round(e.offset?.y || 0)}px`
      const blur = `${round(e.radius || 0)}px`
      const spread = e.spread !== undefined ? ` ${round(e.spread)}px` : ''
      // type: 0=INNER_SHADOW 内阴影 1=DROP_SHADOW 外阴影 2=LAYER_BLUR 3=BACKGROUND_BLUR
      if (e.type === 0) shadows.push(`inset ${off} ${blur}${spread} ${col}`)
      else if (e.type === 1) shadows.push(`${off} ${blur}${spread} ${col}`)
      else if (e.type === 2 && e.radius) return `filter:blur(${round(e.radius)}px);`
    }
    return shadows.length ? `box-shadow:${shadows.join(',')};` : ''
  }

  /** 笔画 → css border（简化：取第一个可见 stroke 纯色）
   *  线条型节点（宽或高 ≤3px，如分隔线）：形状本身就是一条线，再加 border 会
   *  叠出一根明显的黑线（设计稿常是 10% 透明度的发丝线）。此时不用 border，
   *  改用描边色做背景色还原线的视觉。 */
  function strokeToCss(node) {
    const w = node.strokeWeight ?? node.strokeWidth
    const strokes = node.strokes
    if (!w || !Array.isArray(strokes)) return ''
    const lineLike = (node.height ?? 0) <= 3 || (node.width ?? 0) <= 3
    for (const s of strokes) {
      if (!s || s.isVisible === false) continue
      // 与 fillToCss 一致：真透明度在 color.alpha（如分隔线 10% 黑）；
      // 顶层 s.alpha 常是 1 的冗余字段，用来覆盖会把发丝线涂成实黑条
      const col = toColor(
        s.color,
        s.color && s.color.alpha !== undefined ? undefined : s.alpha
      )
      if (col) {
        if (lineLike) return `background-color:${col};`
        return `border:${w}px solid ${col};box-sizing:border-box;`
      }
    }
    return ''
  }

  /** 无官方 SVG 的矢量叶（Line/路径）→ CSS 近似。
   *  不能画成 border 方块（右箭头会变成俩小方框）。细长盒当实线；
   *  接近方形的 Line 工具笔画是包围盒对角线，用 linear-gradient 画斜线。 */
  function vectorStrokeLeafCss(node) {
    const nw = node.width || 0
    const nh = node.height || 0
    if (nw < 0.5 || nh < 0.5) return ''
    const name = String(node.name || '')
    // Oval/矩形等封闭形无 SVG 时不要画成斜线（会毁掉电源弧等）
    if (/oval|ellipse|圆|矩形|rectangle|polygon|多边形|星|star/i.test(name) && !/line|直线/i.test(name)) {
      return ''
    }
    let col = null
    let sw = Number(node.strokeWeight ?? node.strokeWidth ?? 1) || 1
    for (const s of node.strokes || []) {
      if (!s || s.isVisible === false) continue
      col = toColor(s.color, s.color && s.color.alpha !== undefined ? undefined : s.alpha)
      if (col) break
    }
    if (!col) return ''
    if (nh <= 3 || nw <= 3) return `background-color:${col};`
    // 对角线：CSS 渐变角 0deg=向上、90deg=向右；atan2(h,w) 是从 +x 轴起的数学角
    const mathDeg = (Math.atan2(nh, nw) * 180) / Math.PI
    const cssDeg = round(90 - mathDeg)
    const half = Math.max(sw / 2, 0.5)
    return (
      `background:linear-gradient(${cssDeg}deg,transparent calc(50% - ${half}px),` +
      `${col} calc(50% - ${half}px),${col} calc(50% + ${half}px),transparent calc(50% + ${half}px));`
    )
  }

  /** 右箭头组件组：仅按名称识别（next/folds）。
   *  不靠「两条 Line」推断——弹窗关闭的 × 也是两条 Line，会误画成 › */
  function isChevronIconGroup(node) {
    const name = String(node.name || '')
    return /next|folds|chevron|arrow|箭头|展开|收起/i.test(name)
  }

  /** 关闭/取消的 ×：小尺寸组，恰好两条对角 Line（常一条 scaleX=-1） */
  function isCloseXIconGroup(node) {
    if (!node || (node.width || 0) > 28 || (node.height || 0) > 28) return false
    const name = String(node.name || '')
    if (/next|folds|chevron|arrow|箭头/i.test(name)) return false
    if (/close|cancel|关闭|取消|删除|delete/i.test(name)) return true
    const lines = []
    const walk = (n, d) => {
      if (!n || d > 4 || lines.length > 2) return
      if (n.type === 33 && /^(line|直线)/i.test(String(n.name || '').trim())) lines.push(n)
      ;(n.children || []).forEach((c) => walk(c, d + 1))
    }
    walk(node, 0)
    if (lines.length !== 2) return false
    // 两条线尺寸接近且覆盖组盒 → ×；右箭头的 Line 在 folds 子组里更扁
    const [a, b] = lines
    const aw = a.width || 0, ah = a.height || 0
    const bw = b.width || 0, bh = b.height || 0
    if (Math.abs(aw - bw) > 2 || Math.abs(ah - bh) > 2) return false
    const aspect = aw / Math.max(ah, 0.1)
    return aspect > 0.7 && aspect < 1.4
  }

  function chevronStrokeColor(node) {
    let found = null
    const walk = (n, d) => {
      if (!n || d > 5 || found) return
      for (const s of n.strokes || []) {
        if (!s || s.isVisible === false) continue
        found = toColor(s.color, s.color && s.color.alpha !== undefined ? undefined : s.alpha)
        if (found) return
      }
      ;(n.children || []).forEach((c) => walk(c, d + 1))
    }
    walk(node, 0)
    return found
  }

  /** 字体栈：设计稿字体（PingFangSC 等 mac 字体）在 Windows 上映射到可用近似字体 */
  const FONT_FALLBACK = `'PingFang SC','HarmonyOS Sans SC','Microsoft YaHei','Noto Sans SC',sans-serif`
  function fontFamilyCss(raw) {
    const f = String(raw || '').trim()
    if (!f) return FONT_FALLBACK
    // 名字里可能带 zip/编号（如 "PingFangSC-Regular"），按主名判断
    const low = f.toLowerCase()
    const stack = []
    if (/pingfang|lantinghei|heiti|source\s?han|noto\s?sans\s?s[c]|思源/i.test(f)) {
      stack.push(`'${f}'`, `'PingFang SC'`, `'Noto Sans SC'`)
    } else if (/yahei|微软雅黑/i.test(f)) {
      stack.push(`'${f}'`, `'Microsoft YaHei'`)
    } else if (/songti|simsun|宋/i.test(f)) {
      stack.push(`'${f}'`, `'SimSun'`, `serif`)
    } else if (/kaiti|楷/i.test(f)) {
      stack.push(`'${f}'`, `'KaiTi'`)
    } else if (/arial|helvetica/i.test(low)) {
      stack.push(`'Arial'`, `'Helvetica Neue'`)
    } else if (/din|bebas|barlow|montserrat|roboto|inter/i.test(low)) {
      stack.push(`'${f}'`) // 西文设计字体，无则退 sans
    } else {
      stack.push(`'${f}'`)
    }
    stack.push('sans-serif')
    // 去重
    const uniq = [...new Set(stack)]
    return `font-family:${uniq.join(',')};`
  }

  /** 文本节点（type 25）→ 内联 HTML + 样式 */
  function renderText(node, ctx) {
    const blocks = node.blocks || []
    const st0 = (blocks[0] && blocks[0].style) || {}
    // 文字可能有多个 style 块（同节点多段），用 span 分段渲染颜色/字号
    const st = st0
    const html = blocks
      .map((b) => {
        const s = b.style || {}
        const c = toColor(s.color) || ''
        let seg = (b.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        if (!seg) return ''
        // 与块级默认样式一致才不用 span，减少冗余
        const sameColor = !c || toColor(s.color) === toColor(st0.color)
        const sameSize = !s.fontSize || s.fontSize === st0.fontSize
        const sameWeight = String(s.fontWeight || s.fontStyle || '') === String(st0.fontWeight || st0.fontStyle || '')
        if (sameColor && sameSize && sameWeight) return seg
        let spanCss = ''
        if (c && !sameColor) spanCss += 'color:' + c + ';'
        if (s.fontSize && !sameSize) spanCss += 'font-size:' + s.fontSize + 'px;'
        if (s.fontWeight && !sameWeight) spanCss += 'font-weight:' + s.fontWeight + ';'
        return `<span style="${spanCss}">${seg}</span>`
      })
      .join('<br>')
    const alignMap = { 1: 'left', 2: 'center', 3: 'right' }
    // 文本颜色：优先 block style.color；兜底节点自身 fills（设计稿文字颜色在节点填充里）
    let color = toColor(st.color)
    if (!color && Array.isArray(node.fills)) {
      for (const f of node.fills) {
        if (f && f.isVisible !== false && f.color) { color = toColor(f.color, f.alpha); break }
      }
    }
    // 再兜底 paints[].textLayerColor（文字真实颜色在 paints 里，fills 常为 null）
    if (!color && Array.isArray(node.paints)) {
      for (const p of node.paints) {
        const tl = p && (p.textLayerColor || p.color)
        const arr = Array.isArray(tl) ? tl : []
        for (const t of arr) {
          if (t && t.color) { color = toColor(t.color, t.alpha ?? p.alpha); break }
        }
        if (color) break
      }
    }
    let css = `color:${color || '#000'};`
    if (st.fontSize) css += `font-size:${st.fontSize}px;`
    css += fontFamilyCss(st.fontFamily)
    // fontWeight：数值型（100~900）；fontStyle 含 bold 也是加粗信号
    const fw = parseInt(st.fontWeight, 10)
    if (st.fontStyle && /bold/i.test(st.fontStyle)) css += 'font-weight:bold;'
    else if (!isNaN(fw) && fw >= 500) css += `font-weight:${fw};`
    if (st.italic || (st.fontStyle && /italic/i.test(st.fontStyle))) css += 'font-style:italic;'
    if (st.letterSpacing) css += `letter-spacing:${st.letterSpacing}px;`
    if (st.decoration === 1) css += 'text-decoration:underline;'
    const ta = alignMap[node.textAlignHorizontal]
    if (ta) css += `text-align:${ta};`
    // lineHeight：fontHeightOverride 时用 style.height；否则用 fontDefaultLineHeight
    // 行数推断：节点高度 ≤ 1.2 行高视为单行文本 —— 用 nowrap，避免 Windows
    // 字体偏宽导致 "16"、价格等短文本被 word-break 折行成竖排（温度错乱元凶）
    const lhRaw = st.fontHeightOverride && st.height !== 'Auto' ? st.height : st.fontDefaultLineHeight
    const singleLine = node.height && lhRaw && node.height <= Number(lhRaw) * 1.25
    // 单行文本行高超过节点盒高（fontHeightOverride 撑大行盒，如 18px 字配 34px
    // 行高、节点盒仅 20px 高）：行盒垂直溢出会被 clip 祖先裁掉下半截（视觉即
    // 文字下沉/错位）。压到节点盒高 —— MasterGo 的节点盒本就是字形包围盒，
    // 单行时行盒=节点盒才能垂直居中
    let lh = lhRaw
    if (singleLine && node.height && Number(lhRaw) > node.height) lh = node.height
    if (lh && lh !== 'Auto') css += `line-height:${round(Number(lh))}px;`
    css += singleLine
      ? 'white-space:nowrap;display:flex;'
      : 'white-space:pre-wrap;word-break:break-word;display:flex;'
    const va = { 1: 'flex-start', 2: 'center', 3: 'flex-end' }[node.textAlignVertical]
    if (va) css += `align-items:${va};`
    return emitDiv(css, html || '&nbsp;', ctx)
  }

  /** 矩阵 → position css（相对父节点，绝对定位保真；ox/oy 页面级平移） */
  function posCss(node, ox, oy) {
    const m = node.m_relativeMatrix || {}
    const x = (m.transX || 0) - (ox || 0)
    const y = (m.transY || 0) - (oy || 0)
    let css = `position:absolute;left:${round(x)}px;top:${round(y)}px;`
    if (node.width) css += `width:${round(node.width)}px;`
    if (node.height) css += `height:${round(node.height)}px;`
    // 旋转（度）→ css transform；缩放并进 scale
    const sx = m.scaleX !== undefined ? m.scaleX : 1
    const sy = m.scaleY !== undefined ? m.scaleY : 1
    // 矩阵退化（scale 0 + skew≠0）：不是不可见，是 90° 旋转被矩阵分解压扁了
    // （如 音量条 18x2.57 横条 skew(-1,1) → 节点 2.57x18 竖条）。有官方 SVG 时
    // SVG 是权威视觉：按 SVG 原始宽高渲染 + 90° 旋转归位到节点包围盒。
    if (sx === 0 || sy === 0) {
      if (m.skewX === 0 && m.skewY === 0) return null // 无 skew 的纯 scale 0 = 真隐藏
      // 无官方 SVG 的退化容器（图标分组壳，如摆风 Group 7）：孩子坐标在
      // 旋转前局部系。以前丢掉线性变换只留盒子 → 竖线/色块错位乱飞。
      // 补上 matrix(sx,skewY,skewX,sy) + origin(0,0)，与 MasterGo 矩阵一致。
      if (!node.__svgData && (node.children || []).length) {
        const kx = m.skewX || 0
        const ky = m.skewY || 0
        css += `transform-origin:0 0;transform:matrix(${sx},${ky},${kx},${sy},0,0);`
        return css
      }
      const sz = svgSize(node)
      const sw = sz && sz.w
      const sh = sz && sz.h
      if (sw && sh) {
        // 90° 旋转被矩阵分解压扁：真实视觉盒是"转置后的包围盒"。用矩阵对节点
        // 盒四角做全变换求视觉包围盒（含正确的翻转方向），不能直接沿用未转置的
        // w/h —— 否则中心点错位（+ 号竖条被画到盒外，父级 overflow:hidden 裁没）
        // 例：14x1.5 横条 skew(-1,1)+trans(7.75,0) → 视觉盒 1.5x14 @ (6.25,0)
        const corners = [
          [0, 0],
          [node.width || 0, 0],
          [0, node.height || 0],
          [node.width || 0, node.height || 0],
        ]
        // 变换：x' = scaleX*px + skewX*py + transX；y' = skewY*px + scaleY*py + transY
        const tx = (p) => sx * p[0] + m.skewX * p[1] + (m.transX || 0) - (ox || 0)
        const ty = (p) => m.skewY * p[0] + sy * p[1] + (m.transY || 0) - (oy || 0)
        const xs2 = corners.map(tx)
        const ys2 = corners.map(ty)
        const vx = Math.min(...xs2)
        const vy = Math.min(...ys2)
        const vw = Math.max(...xs2) - vx
        const vh = Math.max(...ys2) - vy
        css =
          `position:absolute;left:${round(vx)}px;top:${round(vy)}px;width:${round(vw)}px;height:${round(vh)}px;overflow:hidden;`
        // 内层 SVG 按原始尺寸（长边已与视觉盒长边一致）居中摆放，无需再旋转
        css += `--mgdeg:0deg;`
        return css
      }
      return null
    }
    const rot = node.rotation || 0
    // 官方 SVG + 纯轴对齐翻转（矩阵已含完整线性变换）：按视觉包围盒落位，
    // 不再套 CSS scale/rotate。加号圆钮底 scaleX:-1+transX:48（另带冗余
    // rotation:180），再套 transform 会把 border-box 翻出父级被裁掉。
    if (
      node.__svgData &&
      !(m.skewX || m.skewY) &&
      (sx === -1 || sy === -1) &&
      (sx === 1 || sx === -1) &&
      (sy === 1 || sy === -1)
    ) {
      let vx = (m.transX || 0) - (ox || 0)
      let vy = (m.transY || 0) - (oy || 0)
      if (sx === -1) vx += -1 * (node.width || 0)
      if (sy === -1) vy += -1 * (node.height || 0)
      return `position:absolute;left:${round(vx)}px;top:${round(vy)}px;width:${round(node.width || 0)}px;height:${round(node.height || 0)}px;`
    }
    if (rot || sx !== 1 || sy !== 1) {
      css += `transform-origin:0 0;transform:rotate(${rot}deg) scale(${sx},${sy});`
    }
    return css
  }

  /** 官方 SVG dataURI 里的原始 width/height */
  function svgSize(node) {
    if (!node.__svgData) return null
    const s = decodeURIComponent(node.__svgData)
    const m = s.match(/width="([\d.]+)"\s+height="([\d.]+)"/)
    return m ? { w: +m[1], h: +m[2] } : null
  }

  /** CSS background 里 SVG 的 filter 偶发把整组（含白底圆）吃掉，只剩路径残片
   *  （电源按钮变成「方框+顶竖线」）。去掉 filter 引用，阴影用盒子近似即可。 */
  function svgDataForPaint(node) {
    if (!node.__svgData) return null
    try {
      let s = decodeURIComponent(node.__svgData.split(',').slice(1).join(','))
      if (!/\sfilter="url\(/.test(s)) return node.__svgData
      s = s.replace(/\sfilter="url\([^"]+\)"/g, '')
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s)
    } catch (e) {
      return node.__svgData
    }
  }

  /** SVG 是否有可绘制元素（空壳 SVG 如 <svg></svg> 不算 —— 画它不如画孩子）。
   *  path 必须带非空 d（官方导出对拿不到矢量数据的组件实例会返回 <path d="">，
   *  算有形状但画不出任何东西，会让节点被当成权威视觉剪掉孩子 → 图标消失） */
  function svgHasShape(node) {
    if (!node.__svgData) return false
    const s = decodeURIComponent(node.__svgData)
    return /<path\b[^>]*?\bd="[^"][^"]*"/.test(s) ||
      /<(rect|ellipse|circle|polygon|polyline|line|image|text)\b/.test(s)
  }

  /** SVG 画布宽高比是否与节点盒大致一致。
   *  官方导出偶发把细长描边条（如摆风图标里 8.7×1 的横线）导成近正方形
   *  画布（6.8×6.8），当背景拉伸/居中后变成竖条/色块乱线。退化矩阵节点
   *  （scale0+skew）的 SVG 画布本来就是转置后的，交给 --mgdeg 分支处理。 */
  function svgAspectSane(node) {
    const sz = svgSize(node)
    const nw = node.width || 0
    const nh = node.height || 0
    if (!sz || !nw || !nh) return true
    const m = node.m_relativeMatrix || {}
    const sx = m.scaleX !== undefined ? m.scaleX : 1
    const sy = m.scaleY !== undefined ? m.scaleY : 1
    if (sx === 0 || sy === 0) return true
    const na = nw / nh
    const sa = sz.w / sz.h
    if (!isFinite(na) || !isFinite(sa) || na <= 0 || sa <= 0) return true
    const skew = Math.max(na / sa, sa / na)
    // 描边出血常见 ≤1.5；超过 2.5 基本是导出错位，弃用该 SVG
    return skew < 2.5
  }

  /** 取 SVG 里第一个 ellipse/circle 的圆心（画布坐标系） */
  function svgShapeCenter(node) {
    if (!node.__svgData) return null
    const m = decodeURIComponent(node.__svgData).match(/<(ellipse|circle)\b[^>]*?\bcx="([-\d.]+)"[^>]*?\bcy="([-\d.]+)"/)
    return m ? { x: +m[2], y: +m[3] } : null
  }

  /** SVG 是否只是"一块满铺纯色矩形"（提取 fill 与占画布比例），用于重复视觉去重。
   *  支持两种形状：rect 元素（直接读 x/y/width/height）与 path 元素（官方导出的
   *  纯色/渐变填充矩形常以 path 表达，如滑块蓝色渐变填充 10×48 的
   *  "M0 0...L10 48..."——无圆弧指令时把 d 的数字按 x/y 交替解出包围盒） */
  function svgFullRect(s) {
    const szm = s.match(/width="([\d.]+)"\s+height="([\d.]+)"/)
    if (!szm) return null
    // 取最后一个非 none 填充的形状（描边 rect 是 fill=none，不算底色）
    const shapes = s.match(/<(rect|path)\b[^>]*>/g) || []
    let at = null, fm = null, tag = null
    for (const r of shapes) {
      const f = (r.match(/\bfill="([^"]+)"/) || [])[1]
      if (f && f !== 'none') { at = r; fm = f; tag = r.match(/^<(rect|path)/)[1] }
    }
    if (!at) return null
    const get = (k) => { const m = at.match(new RegExp('\\b' + k + '="([\\d.]+)"')); return m ? +m[1] : 0 }
    const W = +szm[1], H = +szm[2]
    let x, y, w, h
    if (tag === 'rect') {
      x = get('x'); y = get('y'); w = get('width'); h = get('height')
    } else {
      // path：无圆弧(A)指令时数字近似按 x,y 交替排列，取整体包围盒。
      // 贝塞尔控制点只会外扩包围盒（覆盖≥实际），满铺判断依然成立
      const d = (at.match(/\bd="([^"]+)"/) || [])[1] || ''
      if (!d || /[Aa]/.test(d.replace(/[^AHaag]/g, ''))) {
        if (/[Aa]/.test(d)) return null
      }
      const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
      if (nums.length < 4) return null
      const xs = [], ys = []
      for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(+nums[i]); ys.push(+nums[i + 1]) }
      x = Math.min(...xs); y = Math.min(...ys)
      w = Math.max(...xs) - x; h = Math.max(...ys) - y
    }
    if (!w || !h) return null
    // 覆盖画布 ≥90% 才算"满铺矩形"
    if (w < W * 0.9 || h < H * 0.9) return null
    return { fill: fm, w, h, cover: (w * h) / (W * H) }
  }

  function round(n) {
    return Math.round(n * 100) / 100
  }

  /** 常用图形属性 */
  function shapeCss(node, skipStroke) {
    let css = ''
    // cornerRadius 可能是数值、数组（四角 [左上,右上,右下,左下]）或对象；
    // 卡片常拆成上下两半拼合（[14,14,0,0] / [0,0,14,14]），只取首角会把
    // 14px 圆角全丢 —— 数组按四角输出 CSS border-radius（顺序恰好一致）
    const cr = node.cornerRadius
    if (typeof cr === 'number' && cr > 0) {
      css += `border-radius:${round(cr)}px;`
    } else if (Array.isArray(cr) && cr.some((v) => v > 0)) {
      css += `border-radius:${cr.map((v) => `${round(v)}px`).join(' ')};`
    } else if (typeof cr === 'object' && cr) {
      const tl = cr.topLeft ?? cr.radius ?? null
      if (typeof tl === 'number' && tl > 0) css += `border-radius:${round(tl)}px;`
    }
    if (node.opacity !== undefined && node.opacity < 1) css += `opacity:${round(node.opacity)};`
    if (node.clip) css += 'overflow:hidden;'
    if (!skipStroke) css += strokeToCss(node)
    return css
  }

  /** 诊断日志：命中蒙版跳过规则 / 被剪枝的 SVG 子树时落盘（download/debug-render.log） */
  function diagLog(msg) {
    try { if (window.mgApi && window.mgApi.logFile) window.mgApi.logFile('[render] ' + msg) } catch (e) {}
    try { console.log('[mg-render]', msg) } catch (e) {}
  }

  /** 顶层节点输出包装：所有「整节点一个 div」的返回点统一走这里。
   *  无 ctx（classic 模式）时与旧版输出逐字节一致；多页导出模式传 ctx，
   *  由 ctx.emit(css, inner, node) 负责拆 class + inline / flow 化（见 mg-multi.js） */
  function emitDiv(css, inner, ctx, node) {
    if (!ctx || typeof ctx.emit !== 'function') return `<div style="${css}">${inner}</div>`
    return ctx.emit(css, inner, node)
  }

  /** 递归渲染节点 → HTML 字符串（ox/oy 为页面级平移原点；ctx 可选，多页导出时由
   *  mg-multi.js 传入，负责把整节点 style 串拆成 class + inline） */
  function renderNode(node, depth, ox, oy, ctx) {
    if (!node || node.isVisible === false || node.isHidden) return ''
    const type = node.type
    const isText = type === 25 && (node.blocks || []).length
    const isOval = type === 12
    // type 33 矢量/布尔组：自身 fills 是"子 path 并集"的填充，不能当容器背景
    // 整块涂色（会变成一大坨黑块盖住内容），形状交给子 path / SVG 渲染
    const maskLike = isMaskLikeFill(node)
    if (maskLike && depth <= 6) {
      diagLog('蒙版跳过: ' + (node.name || '') + ' t' + type + ' ' + (node.width || 0) + 'x' + (node.height || 0) + ' kids=' + (node.children || []).length)
    }

    // isMask 节点（蒙版）：官方 SVG 不画（白色矩形 SVG 会盖住被裁剪的图片），
    // 但自身纯色填充要画 —— MasterGo 蒙版的填充是渲染的（模式/自动模式卡片
    // 的白色圆角背景就是蒙版矩形的 fill），且蒙版恒为组内最底层兄弟，先画的
    // 底色会被后续兄弟覆盖，不会产生遮挡
    const isMask = node.isMask === true
    if (isMask && depth <= 6) {
      diagLog('isMask蒙版跳过SVG保留fill: ' + (node.name || '') + ' t' + type + ' ' + (node.width || 0) + 'x' + (node.height || 0))
    }

    // 布尔 Subtract（booleanOperation=4）：结果 = 首操作数 − 其余操作数。
    // 当其余操作数包围盒几乎完全覆盖首操作数（同尺寸相框式相减，如整屏
    // Subtract：375×812 灰矩形 − 375×812 圆角矩形 = 4 个角切片，视觉趋近于零），
    // 按子节点逐个平铺会把满铺灰/白 SVG + 组底色盖在全部内容之上 —— 导出
    // 「只剩背景」的根因。此时整组跳过不画（角切片损失可忽略）。
    // 挖洞式 Subtract（洞在首操作数内部、包围盒更小）不受影响，仍走原路径。
    if (type === 9 && node.booleanOperation === 4) {
      const visKids = (node.children || []).filter((c) => c && c.isVisible !== false && !c.isHidden)
      const firstOp = visKids[0]
      if (firstOp && visKids.length > 1) {
        const bx = (n) => ({
          x: (n.m_relativeMatrix || {}).transX || 0,
          y: (n.m_relativeMatrix || {}).transY || 0,
          w: n.width || 0,
          h: n.height || 0,
        })
        const fb = bx(firstOp)
        const u = visKids.slice(1).reduce((acc, c) => {
          const b = bx(c)
          return {
            x: Math.min(acc.x, b.x), y: Math.min(acc.y, b.y),
            x2: Math.max(acc.x + acc.w, b.x + b.w), y2: Math.max(acc.y + acc.h, b.y + b.h),
          }
        }, bx(visKids[1]))
        if (
          fb.w > 0 && fb.h > 0 &&
          u.x <= fb.x + 1 && u.y <= fb.y + 1 &&
          u.x2 >= fb.x + fb.w - 1 && u.y2 >= fb.y + fb.h - 1
        ) {
          if (depth <= 6) diagLog('布尔Subtract满铺相减跳过: ' + (node.name || '') + ' t9 ' + round(fb.w) + 'x' + round(fb.h) + '（角切片残差忽略）')
          return ''
        }
      }
    }

    // type 33 矢量：自身 fills 是 path 并集色/默认色，不能当盒子背景；
    // 叶子无 children 时若再叠 border，右箭头/关闭图标的 Line 会变成俩小方框
    const skipOwnFill =
      type === 33 ||
      maskLike ||
      isIconShapeGroup(node)

    let pos = posCss(node, ox, oy)
    if (pos === null) return '' // scale 为 0 的不可见节点
    // 退化矩阵矢量（lowConf=degenerate-vector）：整组已导出官方 SVG（画布为
    // 组的正确视觉），走 hasSvg 分支，不再按叶子分别拼装（单叶 SVG 停在旋转前
    // 坐标系，旋转救不回被裁掉的内容）
    if (/--mgdeg:/.test(pos) && node.__lowConf) {
      node.m_relativeMatrix = { ...(node.m_relativeMatrix || {}), scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 }
      pos = posCss(node, ox, oy)
    }
    // 矩阵退化+官方SVG：外层按节点包围盒裁剪，内层按 SVG 原始尺寸旋转 90° 归位
    if (/--mgdeg:/.test(pos)) {
      const sz = svgSize(node)
      const deg = /(\d+)deg/.exec(pos)[1]
      const paint = svgDataForPaint(node)
      const inner =
        `<div style="position:absolute;left:50%;top:50%;width:${round(sz.w)}px;height:${round(sz.h)}px;` +
        `transform:translate(-50%,-50%) rotate(${deg}deg);background-image:url('${paint}');` +
        `background-size:100% 100%;background-position:center;background-repeat:no-repeat;"></div>`
      if (depth <= 6) diagLog('退化矩阵还原: ' + (node.name || '') + ' t' + type + ' svg=' + sz.w + 'x' + sz.h + ' → 节点' + node.width + 'x' + node.height)
      node.children = undefined
      return emitDiv(pos, inner, ctx)
    }
    // 通用规则：有官方 SVG 时 SVG 是权威视觉，节点自身 fill/stroke 全部弃用
    // （设计的轨道/按钮 fill 常是蒙版用的纯黑，真视觉在 SVG 里；CSS 拼装只会
    // 涂出黑块）。位置/尺寸/圆角仍用节点值保证布局不跑偏。
    // 蒙版节点例外：SVG 背景不画（会盖住被裁剪的图片），纯色 fill 照画（卡片白底）
    // 空壳 SVG（无任何可绘制元素）不算权威视觉 —— 画它不如画孩子（挡位图标）
    // 低置信度节点（提取侧标记 __lowConf：多层蒙版/高密度矢量）：CSS 拼装必错，
    // 官方 SVG 是唯一权威 —— 即使 SVG 看似空壳也强制走 SVG 分支
    // 官方 SVG 是权威视觉时节点自身 fill/stroke 弃用（skipStroke）：SVG 已含
    // 描边形状，再叠 strokeToCss 的 background-color 会把半透明细线涂成实黑块
    //（如卡片分隔线：SVG 是 10% 黑的 1px 细条，节点 stroke 黑 0.5px → border/
    // background 叠出一条明显的黑线）。位置/尺寸/圆角仍用节点值保证布局不跑偏。
    // 蒙版节点例外：SVG 背景不画（会盖住被裁剪的图片），纯色 fill 照画（卡片白底）
    // 空壳 SVG（无任何可绘制元素）不算权威视觉 —— 画它不如画孩子（挡位图标）
    // 低置信度节点（提取侧标记 __lowConf：多层蒙版/高密度矢量）：CSS 拼装必错，
    // 官方 SVG 是唯一权威 —— 即使 SVG 看似空壳也强制走 SVG 分支
    const hasSvg = !!node.__svgData && !isMask && (svgHasShape(node) || node.__lowConf) && (node.__lowConf || svgAspectSane(node))
    if (node.__svgData && !hasSvg && !isMask && depth <= 6 && svgHasShape(node) && !svgAspectSane(node)) {
      diagLog('SVG宽高比异常弃用: ' + (node.name || '') + ' t' + type + ' node=' + (node.width || 0) + 'x' + (node.height || 0))
    }
    let css = pos + shapeCss(node, hasSvg) + (skipOwnFill || hasSvg ? '' : fillToCss(node.fills)) + effectsToCss(node.effects)
    if (hasSvg) {
      css = css.replace(/border:[^;]+;box-sizing:border-box;/g, '')
      // SVG 内部已写 opacity 时，节点 opacity 再乘会过淡（电源按钮 0.3×0.3）
      if (node.opacity !== undefined && node.opacity < 1) {
        try {
          const raw = decodeURIComponent(node.__svgData)
          if (/opacity\s*[:=]/.test(raw)) css = css.replace(/opacity:[^;]+;/g, '')
        } catch (e) { /* keep */ }
      }
      const sz = svgSize(node)
      const nw = round(node.width || 0)
      const nh = round(node.height || 0)
      // SVG 画布尺寸 ≠ 节点尺寸时（SVG 常含 drop-shadow/描边出血），100% 拉伸
      // 会把圆钮缩小、图形压扁。按 SVG 原始尺寸画在内层 div，居中偏移回节点盒，
      // 节点盒 overflow:hidden 裁掉出血 —— 图标与开关旋钮共用此规则
      if (sz && nw && nh && (Math.abs(sz.w - nw) > 0.5 || Math.abs(sz.h - nh) > 0.5)) {
        let dx = round((nw - sz.w) / 2)
        let dy = round((nh - sz.h) / 2)
        // 画布中心 ≠ 形状中心时（如旋钮 ellipse cy=17.017 在 36.03 画布里），
        // 以形状中心对齐节点盒中心，否则圆钮整体偏 1px 出圈
        const sc = svgShapeCenter(node)
        if (sc) {
          const sdx = sc.x - sz.w / 2
          const sdy = sc.y - sz.h / 2
          if (Math.abs(sdx) > 0.2) dx = round((nw / 2 - sc.x))
          if (Math.abs(sdy) > 0.2) dy = round((nh / 2 - sc.y))
        }
        if (depth <= 6) diagLog('SVG原尺寸居中: ' + (node.name || '') + ' node=' + nw + 'x' + nh + ' svg=' + sz.w + 'x' + sz.h + ' offset=' + dx + ',' + dy)
        // 画布多出的边距是描边/圆头/阴影的出血（如电源符号竖线节点盒 0.8 宽、
        // 线条实画 2px 宽），裁掉会切细线条、切平圆头 —— 出血属于设计本身，不裁
        css += `position:absolute;`
        const paint = svgDataForPaint(node)
        const inner =
          `<div style="position:absolute;left:${dx}px;top:${dy}px;width:${round(sz.w)}px;height:${round(sz.h)}px;` +
          `background-image:url('${paint}');background-size:100% 100%;background-repeat:no-repeat;"></div>`
        node.children = undefined
        if (isOval) css += 'border-radius:50%;'
        return emitDiv(css, inner, ctx)
      }
      css += `background-image:url('${svgDataForPaint(node)}');background-size:100% 100%;background-position:center;background-repeat:no-repeat;`
      // SVG 已含整个子树的形状与描边，剪掉 children 防止 div 双重叠加
      if (depth <= 6) diagLog('SVG剪枝: ' + (node.name || '') + ' t' + type + ' node=' + (node.width || 0) + 'x' + (node.height || 0) + ' kids剪掉=' + ((node.children || []).length))
      node.children = undefined
      if (isOval) css = css.replace(/border-radius:[^;]+;/, '') + 'border-radius:50%;'
      return emitDiv(css, isText ? renderText(node, ctx) : '', ctx)
    }
    // 无官方 SVG 的矢量叶（type 33 Line/路径）：绝不能走 fill+border 方块，
    // 否则 common_icon_next / 弹窗关闭 的两条 Line 会渲染成「俩小方框」。
    // MasterGo Line 工具的笔画是包围盒对角线 —— 用渐变条近似。
    if (type === 33 && !(node.children || []).length) {
      // 带可见填充的矢量叶不是「线条」：图片占位矩形（App Previews 预览墙 6188 个
      // type33 图片填充叶）走 fill 方块路径；vectorStrokeLeafCss 只服务描边线条。
      const hasVisibleFill = (node.fills || []).some((f) => f && f.isVisible !== false)
      const leaf = hasVisibleFill ? null : vectorStrokeLeafCss(node)
      if (!leaf && !hasVisibleFill) return ''
      if (!leaf) {
        // 填充叶：走通用 fill+shape 路径（与普通矩形一致）。skipOwnFill 已把
        // type 33 自身 fill 弃用（矢量组 fills 是子 path 并集色）—— 但这里已
        // 判定是「孤立填充叶」（无子 path 可托付形状），再弃色只能输出空盒。
        // 小图标圆圈内的白色符号叶（≤80px 图标组内、无官方 SVG）唯一视觉就是
        // 自身 fill：用 fill 色画方块 —— 至少形状/位置保真，不致图标整体消失
        if (!css) return ''
        const leafCol = firstFillColor(node)
        if (leafCol && !css.includes('background-color:')) css += `background-color:${leafCol};`
        if (depth <= 6) diagLog('矢量叶填充回退: ' + (node.name || '') + ' ' + (node.width || 0) + 'x' + (node.height || 0))
        return emitDiv(css, '', ctx, node)
      }
      let css2 = pos
      if (node.opacity !== undefined && node.opacity < 1) css2 += `opacity:${round(node.opacity)};`
      css2 += leaf
      if (depth <= 6) diagLog('矢量叶对角线近似: ' + (node.name || '') + ' ' + (node.width || 0) + 'x' + (node.height || 0))
      return emitDiv(css2, '', ctx)
    }
    // 右箭头组（common_icon_next）：退化矩阵 + 无整组 SVG 时子 Line 拼装必错。
    // 按矩阵求视觉包围盒落位，居中画 CSS ›。
    if (!hasSvg && type === 9 && isChevronIconGroup(node)) {
      const m = node.m_relativeMatrix || {}
      const sx0 = m.scaleX !== undefined ? m.scaleX : 1
      const sy0 = m.scaleY !== undefined ? m.scaleY : 1
      const kx0 = m.skewX || 0
      const ky0 = m.skewY || 0
      const nw0 = node.width || 16
      const nh0 = node.height || 16
      let left = (m.transX || 0) - (ox || 0)
      let top = (m.transY || 0) - (oy || 0)
      let bw = nw0
      let bh = nh0
      // 退化矩阵：节点 w/h 是局部盒，视觉盒由线性变换决定（如 ty=16 实际画在 y=0）
      if ((sx0 === 0 || sy0 === 0) && (kx0 || ky0)) {
        const corners = [
          [0, 0],
          [nw0, 0],
          [0, nh0],
          [nw0, nh0],
        ]
        const xs = corners.map((p) => sx0 * p[0] + kx0 * p[1] + (m.transX || 0) - (ox || 0))
        const ys = corners.map((p) => ky0 * p[0] + sy0 * p[1] + (m.transY || 0) - (oy || 0))
        left = Math.min(...xs)
        top = Math.min(...ys)
        bw = Math.max(...xs) - left
        bh = Math.max(...ys) - top
      }
      let css2 = `position:absolute;left:${round(left)}px;top:${round(top)}px;width:${round(bw)}px;height:${round(bh)}px;`
      if (node.opacity !== undefined && node.opacity < 1) css2 += `opacity:${round(node.opacity)};`
      const col = chevronStrokeColor(node) || 'rgba(0,0,0,0.80)'
      const arm = Math.max(5, Math.min(round(Math.min(bw, bh) * 0.4), 8))
      const sw = 1.5
      const inner =
        `<div style="position:absolute;left:50%;top:50%;width:${arm}px;height:${arm}px;` +
        `margin-left:${round(-arm / 2 - sw / 2)}px;margin-top:${round(-arm / 2)}px;` +
        `border-right:${sw}px solid ${col};border-bottom:${sw}px solid ${col};` +
        `transform:rotate(-45deg);box-sizing:border-box;"></div>`
      if (depth <= 6) diagLog('右箭头CSS还原: ' + (node.name || '') + ' ' + round(bw) + 'x' + round(bh))
      return emitDiv(css2, inner, ctx)
    }
    // 关闭 ×（弹窗左上角两条对角 Line）：无整组 SVG 时画 CSS 叉号
    if (!hasSvg && type === 9 && isCloseXIconGroup(node)) {
      const m = node.m_relativeMatrix || {}
      const left = (m.transX || 0) - (ox || 0)
      const top = (m.transY || 0) - (oy || 0)
      const bw = node.width || 13
      const bh = node.height || 13
      let css2 = `position:absolute;left:${round(left)}px;top:${round(top)}px;width:${round(bw)}px;height:${round(bh)}px;`
      if (node.opacity !== undefined && node.opacity < 1) css2 += `opacity:${round(node.opacity)};`
      const col = chevronStrokeColor(node) || 'rgba(36,36,36,1)'
      const sw = 1.5
      const arm = Math.max(8, Math.min(bw, bh) * 0.85)
      const line =
        `position:absolute;left:50%;top:50%;width:${round(arm)}px;height:${sw}px;` +
        `margin-left:${round(-arm / 2)}px;margin-top:${round(-sw / 2)}px;background:${col};border-radius:1px;`
      const inner =
        `<div style="${line}transform:rotate(45deg);"></div>` +
        `<div style="${line}transform:rotate(-45deg);"></div>`
      if (depth <= 6) diagLog('关闭叉号CSS还原: ' + (node.name || '') + ' ' + round(bw) + 'x' + round(bh))
      return emitDiv(css2, inner, ctx)
    }
    // 切图：提取阶段官方 API 导出的 SVG（矢量图标/无填充节点）当背景图还原
    // 注意：style 属性用双引号包裹，这里 url 必须用单引号，否则 HTML 截断失效
    if (isOval) css = css.replace(/border-radius:[^;]+;/, '') + 'border-radius:50%;'

    let inner = ''
    if (isText) {
      inner = renderText(node, ctx)
      return emitDiv(css, inner, ctx)
    }
    // 重复视觉去重：官方 SVG 常被"拆成两层同视觉图层"（开关轨道 t35 白底圆角
    // 矩形 + 兄弟 t13 White/Green Background 同色矩形），两层都画会叠出双描边。
    // 规则：孩子的 SVG 是"满铺纯色矩形"，且其盒子被更早兄弟完全覆盖（1px 容差）、
    // 兄弟 SVG 同色满铺 → 该孩子是冗余底色，跳过。hasSvg 分支剪枝的孩子也算
    // （switch 轨道 case：兄弟剪枝后渲染的是各自 SVG，视觉重复依旧要去重）
    const kidsSrc = (node.children || []).filter((c) => c && c.isVisible !== false && !c.isHidden)
    const covered = (a, b) =>
      a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1
    const boxOf = (n) => {
      const m = n.m_relativeMatrix || {}
      return { x: m.transX || 0, y: m.transY || 0, w: n.width || 0, h: n.height || 0 }
    }
    // 圆角继承（通用规则）：自身无圆角的填充矩形，若完全落在某个带圆角兄弟的
    // 盒子内且与其边缘齐平，齐平的角继承兄弟的圆角。DSL 里这类"进度条/滑块填充"
    // 矩形 cornerRadius 恒为 [0,0,0,0]（如滑轨 207×48 r24 + 蓝色渐变填充 120×48），
    // MasterGo 渲染时被轨道形状裁出圆角；不继承就会画出方角蓝块。
    // 覆盖整盒（齐平四边）→ 四角全继承；只齐左边 → 左上/左下继承，右角保持方角。
    const radiusOf = (n) => {
      const r = n.cornerRadius
      if (typeof r === 'number') return [r, r, r, r]
      if (Array.isArray(r) && r.length === 4) return r
      return [0, 0, 0, 0]
    }
    const hasRadius = (n) => radiusOf(n).some((v) => v > 0)
    const hasFill = (n) => (n.fills || []).some((f) => f && f.isVisible !== false)
    // 蒙版裁剪（通用规则）：isMask 兄弟（如滑轨 207×48 r24 白色药丸蒙版）定义了
    // 组内可见区域的形状，MasterGo 渲染时组内所有填充/图形都被它裁剪。CSS 侧用
    // 蒙版的盒子+圆角生成 border-radius 容器不现实（蒙版与被裁孩子非父子关系），
    // 通用做法：蒙版的圆角/形状"抄给"与其边缘齐平且被其覆盖的填充兄弟——
    // 滑块蓝色渐变填充 10×48 与蒙版左缘齐平 → 左上/左下角继承蒙版 r24 → 左端
    // 半圆帽还原。复杂形状蒙版（SVG 非满铺矩形）暂不支持，回退现状。
    for (const m of kidsSrc) {
      if (m.isMask !== true) continue
      const mr = radiusOf(m)
      if (!mr.some((v) => v > 0)) continue
      const mb = boxOf(m)
      for (const c of kidsSrc) {
        if (c === m || c.isMask) continue
        const frM = c.__svgData && !c.__lowConf ? svgFullRect(decodeURIComponent(c.__svgData)) : null
        if (hasRadius(c) || !hasFill(c) || (c.__svgData && !frM)) continue
        const cb = boxOf(c)
        if (!covered(cb, mb)) continue
        const flushL = cb.x <= mb.x + 1
        const flushR = cb.x + cb.w >= mb.x + mb.w - 1
        const flushT = cb.y <= mb.y + 1
        const flushB = cb.y + cb.h >= mb.y + mb.h - 1
        const cap = Math.min(cb.w, cb.h) / 2
        const nr = mr.map((v) => Math.min(v, cap))
        const out = [0, 0, 0, 0]
        if (flushT && flushL) out[0] = nr[0]
        if (flushT && flushR) out[1] = nr[1]
        if (flushB && flushR) out[2] = nr[2]
        if (flushB && flushL) out[3] = nr[3]
        if (out.some((v) => v > 0)) {
          if (depth <= 6) diagLog('蒙版裁剪圆角: ' + (c.name || '') + ' ← mask ' + (m.name || '') + ' r=' + out.join(','))
          c.cornerRadius = out
        }
      }
    }
    const seenRects = [] // {box, fill}
    for (const c of kidsSrc) {
      // 自带 __svgData 的孩子：复杂形状的 SVG 是真实轮廓，不能叠兄弟圆角；
      // 但"满铺纯色矩形"的 SVG（svgFullRect 能解出单一矩形填充）视觉上等价于
      // 普通填充矩形（如滑块蓝色渐变填充 10×48，节点 cornerRadius 恒 [0,0,0,0]），
      // 仍应继承带圆角兄弟（滑轨 r24）的圆角，否则左端画出方角
      const frSelf = c.__svgData && !c.__lowConf ? svgFullRect(decodeURIComponent(c.__svgData)) : null
      if (hasRadius(c) || !hasFill(c) || (c.__svgData && !frSelf)) continue
      const cb = boxOf(c)
      if (!cb.w || !cb.h) continue
      for (const s of kidsSrc) {
        if (s === c || !hasRadius(s)) continue
        const sb = boxOf(s)
        if (!covered(cb, sb)) continue
        const sr = radiusOf(s)
        // 半径不超过自身短边一半（矩形尺寸与兄弟不同时长边角不炸）
        const cap = Math.min(cb.w, cb.h) / 2
        const nr = sr.map((v) => Math.min(v, cap))
        // 每个角仅在相邻两条边都齐平时继承（右上角齐平只看上+右两条边），
        // 中途截断的边（进度条右缘）保持方角
        const out = [0, 0, 0, 0] // [tl, tr, br, bl]
        const flushL = cb.x <= sb.x + 1
        const flushR = cb.x + cb.w >= sb.x + sb.w - 1
        const flushT = cb.y <= sb.y + 1
        const flushB = cb.y + cb.h >= sb.y + sb.h - 1
        if (flushT && flushL) out[0] = nr[0]
        if (flushT && flushR) out[1] = nr[1]
        if (flushB && flushR) out[2] = nr[2]
        if (flushB && flushL) out[3] = nr[3]
        if (out.some((v) => v > 0)) {
          if (depth <= 6) diagLog('圆角继承: ' + (c.name || '') + ' ← ' + (s.name || '') + ' r=' + out.join(','))
          c.cornerRadius = out
        }
        break
      }
    }
    const kids = kidsSrc
      .map((c) => {
        // 低置信度节点的 SVG 是复杂合成视觉，不参与"满铺矩形"去重
        //（去重规则只针对纯色底色矩形，复杂 SVG 被误删会整块丢视觉）
        const fr = c.__svgData && !c.__lowConf ? svgFullRect(decodeURIComponent(c.__svgData)) : null
        if (fr && fr.fill) {
          const cb = boxOf(c)
          if (seenRects.some((s) => s.fill === fr.fill && covered(cb, s.box))) {
            if (depth <= 6) diagLog('重复底色去重: ' + (c.name || '') + ' t' + c.type + ' fill=' + fr.fill)
            return ''
          }
          seenRects.push({ box: cb, fill: fr.fill })
        }
        return renderNode(c, depth + 1, 0, 0, ctx) // 子节点坐标相对父节点，ox/oy 只在顶层用一次
      })
      .join('')
    if (!kids && !css) return ''
    return emitDiv(css, kids, ctx, node)
  }

  function fillHasImage(node) {
    return (node.fills || []).some((f) => f && f.image && f.image.imageRef)
  }

  /** 图标级造型组：小尺寸、无富文本、子树含矢量/几何形状。
   *  这类 Frame 的 fills 不应作为 CSS 背景（见 skipOwnFill） */
  function isIconShapeGroup(node) {
    if (!node || node.type !== 9) return false
    const w = node.width || 0
    const h = node.height || 0
    if (w > 80 || h > 80 || w < 1 || h < 1) return false
    const kids = (node.children || []).filter((c) => c && c.isVisible !== false && !c.isHidden)
    if (!kids.length) return false
    if (iconGroupHasRichContent(node)) return false
    const shapeTypes = new Set([12, 13, 33, 35])
    const hasShape = (n) => {
      if (!n || n.isVisible === false || n.isHidden) return false
      if (shapeTypes.has(n.type)) return true
      return (n.children || []).some(hasShape)
    }
    return kids.some(hasShape)
  }
  function iconGroupHasRichContent(n) {
    if (fillHasImage(n)) return true
    for (const c of n.children || []) {
      if (!c) continue
      if (c.type === 25) return true
      if (fillHasImage(c)) return true
      if (iconGroupHasRichContent(c)) return true
    }
    return false
  }

  /** 蒙版型容器识别：clip 容器（无圆角）自身 fill 与其全部可见直接子节点的
   *  fill 完全同色 —— 设计稿布尔/蒙版结构给容器塞了与形状相同的冗余底色，
   *  画出来会把 icon 变成一整块色块（如送风图标的 4 根竖条外多出一块黑底），
   *  跳过容器 fill，形状由子节点还原 */
  function isMaskLikeFill(node) {
    const kids = (node.children || []).filter((c) => c && c.isVisible !== false && !c.isHidden)
    if (!node.clip || !kids.length || node.cornerRadius) return false
    const parentCol = firstFillColor(node)
    if (!parentCol) return false
    return kids.every((k) => firstFillColor(k) === parentCol)
  }
  function firstFillColor(n) {
    for (const f of n.fills || []) {
      if (f && f.isVisible !== false) return toColor(f.color, f.alpha)
    }
    return null
  }

  /**
   * 主入口：DSL → 完整 HTML 文档
   * @returns {{html: string, stats: {nodes: number, rendered: number, images: number, texts: number}}}
   */
  function renderDsl(dsl) {
    let stats = { nodes: 0, rendered: 0, images: 0, texts: 0 }
    function count(node) {
      if (!node) return
      stats.nodes++
      if (node.type === 25 && (node.blocks || []).length) stats.texts++
      if (fillHasImage(node)) stats.images++
      ;(node.children || []).forEach(count)
    }
    const pagesHtml = (dsl.pages || [])
      .map((page) => {
        // MasterGo 一个「页面」的画布上平铺多个顶层画板（如 9 个手机屏）。
        // 每个画板单独渲染成一张页面卡片（以画板自身原点平移到 0,0），避免
        // 画布绝对坐标互相叠加 + overflow:hidden 把其他画板裁掉只剩一个。
        return (page.layers || [])
          .map((l) => {
            count(l)
            const m = l.m_relativeMatrix || {}
            const ox = m.transX || 0
            const oy = m.transY || 0
            const w = round(l.width || 375)
            const h = round(l.height || 812)
            const inner = renderNode(l, 0, ox, oy)
            const label = (l.name || '').replace(/</g, '&lt;')
            return (
              `<div class="mg-board">` +
              (label ? `<div class="mg-page-label">${label}</div>` : '') +
              `<div class="mg-page" style="width:${w}px;height:${h}px;" data-layer-id="${l.id || ''}">` +
              inner +
              `</div></div>`
            )
          })
          .join('\n')
      })
      .join('\n')

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MasterGo Export</title>
<style>
  body { margin: 0; background: #f0f0f0; display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; align-items: flex-start; }
  .mg-board { position: relative; flex: none; }
  /* 画板本体裁剪：内部超出画板范围的层（如导航底板高出画板、绝对定位溢出）
     不能外溢渲染，否则会盖到相邻画板 */
  .mg-page { position: relative; background: #fff; flex: none; box-shadow: 0 2px 12px rgba(0,0,0,.12); overflow: hidden; }
  .mg-page-label { position: absolute; top: 0; left: 0; right: 0; z-index: 10; padding: 4px 8px; font: 12px/1.4 sans-serif;
    background: rgba(0,0,0,.55); color: #fff; pointer-events: none; }
  .mg-page > div { flex: none; }
  div { box-sizing: border-box; }
</style>
</head>
<body>
${pagesHtml}
</body>
</html>`
    return { html, stats }
  }

  // 导出（渲染进程 commonjs 风格由打包器处理；此处直接挂 window）
  if (typeof window !== 'undefined') {
    window.mgRender = { renderDsl, renderNode, fillToCss }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderDsl, renderNode, fillToCss }
  }
})()
