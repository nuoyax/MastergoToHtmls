/**
 * 切图/HTML 导出效果回归：解析最新 ZIP 的 index.html，
 * 断言 1:1 结构指标（画板数、文本、背景、SVG），配合日志发现回归。
 * 运行: node tests/compare-zip.mjs [zip路径]
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { execSync } from 'child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const dir = path.join(ROOT, 'download')
const zips = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort()
if (!zips.length) { console.error('NO_ZIP'); process.exit(2) }
const zipPath = path.join(dir, process.argv[2] || zips[zips.length - 1])
console.log('ZIP:', path.basename(zipPath))

// 用 unzip（git bash 自带）解出 index.html
const tmp = path.join(ROOT, '.tmp-zip')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
execSync(`unzip -o -q "${zipPath}" index.html -d "${tmp}"`)
const html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf-8')

const checks = []
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail })

const boards = (html.match(/class="mg-page"/g) || []).length
ok('画板数>=9', boards >= 9, 'boards=' + boards)
ok('标签外置(不覆盖画板)', !/<div class="mg-page"[^>]*><div class="mg-page-label"/.test(html))
ok('无scale(0,0)', !html.includes('scale(0,0)'))
ok('无undefined样式', !/style="[^"]*undefined/.test(html))
const texts = (html.match(/white-space:nowrap;display:flex;">[^<]+<\/div>/g) || []).length
ok('文本节点>80', texts > 80, 'texts=' + texts)
const svgs = (html.match(/data:image\/svg\+xml/g) || []).length
ok('SVG背景>100', svgs > 100, 'svgs=' + svgs)
// 切图目录存在
let sliceCount = 0
try { sliceCount = execSync(`unzip -l "${zipPath}" "slices/*" | grep -c "slices/"`, { encoding: 'utf-8' }).trim() } catch {}
ok('含切图', +sliceCount > 0, 'slices=' + sliceCount)

let fail = 0
for (const c of checks) {
  console.log((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '  [' + c.detail + ']' : ''))
  if (!c.pass) fail++
}
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
