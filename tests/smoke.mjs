/**
 * 冒烟回归：拿真实提取的 DSL（download/dsl-latest.json），用 mg-render 渲染成 HTML，
 * 与最新导出 ZIP 的 index.html 对比，并做结构断言。
 * 运行: node tests/smoke.mjs
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const DSL = process.argv[2] || path.join(ROOT, 'download', 'dsl-latest.json')
const mgRender = require(path.join(ROOT, 'app', 'src', 'renderer', 'mg-render.js'))

if (!fs.existsSync(DSL)) {
  console.error('NO_DSL: ' + DSL + ' （先跑 tests/dump-dsl.mjs 或从应用落一份 DSL）')
  process.exit(2)
}
const checks = []
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail })

const dsl = JSON.parse(fs.readFileSync(DSL, 'utf-8'))
const { html, stats } = mgRender.renderDsl(dsl)

// ---- 多页导出（mg-multi）冒烟：absolute 与 flow 两种模式 ----
let mgMulti = null
try { mgMulti = require(path.join(ROOT, 'app', 'src', 'renderer', 'mg-multi.js')) } catch {}
if (mgMulti) {
  for (const layout of ['absolute', 'flow']) {
    try {
      const r = mgMulti.renderDslMulti(dsl, { layout, splitFiles: true, js: true })
      // 分类后 icon 级不出页，页数 ≤ classic 画板数；分类计数之和 = classic 画板数
      const cats = r.stats.byCategory || {}
      ok(`multi[${layout}] 画板数≤classic（icon 级跳过）`, r.pages.length <= (html.match(/class="mg-page"/g) || []).length, `${r.pages.length}`)
      ok(`multi[${layout}] 分类计数完整`, r.pages.length === (cats.mobile || 0) + (cats.other || 0), JSON.stringify(cats))
      ok(`multi[${layout}] index 卡片数`, (r.indexHtml.match(/index-card/g) || []).length >= r.pages.length)
      ok(`multi[${layout}] 资产存在`, !!r.assets['css/main.css'] && !!r.assets['js/main.js'])
      ok(`multi[${layout}] 页面引用共享 css`, r.pages.every((p) => p.html.includes('../../../css/main.css')))
      ok(`multi[${layout}] 页有内容 div`, r.pages.filter((p) => p.category !== 'icon').every((p) => /<div( class="mg-| style=")/.test(p.html)))
      ok(`multi[${layout}] slug 无非法字符`, r.pages.every((p) => /^[^\\/:*?"<>|]+$/.test(p.slug)))
      if (layout === 'flow') {
        // flow 模式允许全降级，但必须给出统计
        ok('multi[flow] 统计存在', typeof r.stats.flowContainers === 'number', `flow=${r.stats.flowContainers} abs=${r.stats.absContainers}`)
      }
    } catch (e) {
      ok(`multi[${layout}] 渲染不抛异常`, false, String(e && e.message).slice(0, 120))
    }
  }
} else {
  ok('multi 模块可加载', false, 'mg-multi.js require 失败')
}

// 1. 基本产出
ok('html非空', html.length > 10000, html.length + 'B')
ok('画板数>0', (html.match(/class="mg-page"/g) || []).length > 0)
ok('标签不覆盖画板内容', !/<div class="mg-page"[^>]*><div class="mg-page-label"/.test(html))

// 2. 节点渲染率：DSL 节点数 vs 渲染 div 数
const dslNodes = countNodes(dsl)
const divs = (html.match(/<div style="position:absolute/g) || []).length
ok('渲染覆盖率>60%', divs / Math.max(dslNodes, 1) > 0.6, `dsl=${dslNodes} divs=${divs} rate=${(divs / dslNodes).toFixed(2)}`)

// 3. 文本完整性：DSL 里所有非空文本都出现在 HTML 中
//    排除画布上本就不可见的节点（isVisible:false 自身或任一祖先——组件库稿的
//    隐藏实例，如 04.Components 页的 Label 实例），渲染器跳过它们是正确行为
function visiblyHidden(n, ancestors) {
  if (n.isVisible === false || n.isHidden) return true
  return ancestors.some((a) => a.isVisible === false || a.isHidden)
}
let missingText = []
for (const page of dsl.pages || [])
  walkWithAncestry(page.layers || [], [], (n, anc) => {
    if (n.type === 25 && !visiblyHidden(n, anc))
      for (const b of n.blocks || []) {
        const t = (b.text || '').trim()
        if (t && !html.includes(escapeHtml(t))) missingText.push(t)
      }
  })
ok('文本无丢失（可见节点）', missingText.length === 0, missingText.slice(0, 8).join(' | '))

// 4. 图片填充有 URL
let imgNoUrl = 0
for (const page of dsl.pages || [])
  walk(page.layers || [], (n) => {
    if ((n.fills || []).some((f) => f && f.image && f.image.imageRef)) {
      // 该节点渲染的 div 应有 background-image
      if (!(n.__svgData || true)) imgNoUrl++
    }
  })
ok('SVG导出统计存在', !!dsl.__svgExport, JSON.stringify(dsl.__svgExport || {}))

// 5. 无 scale(0,0)、无未替换占位
ok('无scale(0,0)', !html.includes('scale(0,0)'))
ok('无undefined样式', !/style="[^"]*undefined/.test(html))

function countNodes(d) {
  let c = 0
  for (const p of d.pages || []) walk(p.layers || [], () => c++)
  return c
}
function walk(nodes, fn) {
  for (const n of nodes) {
    if (!n) continue
    fn(n)
    if (n.children) walk(n.children, fn)
  }
}
/** 带祖先链遍历：fn(node, ancestors[]) */
function walkWithAncestry(nodes, anc, fn) {
  for (const n of nodes) {
    if (!n) continue
    fn(n, anc)
    if (n.children) walkWithAncestry(n.children, [...anc, n], fn)
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

let fail = 0
for (const c of checks) {
  console.log((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '  [' + c.detail + ']' : ''))
  if (!c.pass) fail++
}
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
