/**
 * 视觉回归：两张截图逐像素 diff（pixelmatch）。
 * 用法: node tests/visual-diff.mjs <a.png> <b.png> [阈值0~1=0.1]
 * 输出: 控制台差异百分比；差异 >0 时生成 tmp-diff.png（红标差异像素）。
 * 退出码: 完全一致=0，有差异=1（供 CI / 回归脚本判断）。
 */
import fs from 'fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const [aPath, bPath] = process.argv.slice(2)
const threshold = parseFloat(process.argv[4] || '0.1')
if (!aPath || !bPath || !fs.existsSync(aPath) || !fs.existsSync(bPath)) {
  console.error('用法: node tests/visual-diff.mjs <a.png> <b.png> [阈值0~1]')
  process.exit(2)
}

const a = PNG.sync.read(fs.readFileSync(aPath))
const b = PNG.sync.read(fs.readFileSync(bPath))
// 尺寸不一致时取公共区域（截图工具偶发 1~2px 画布差异）
const w = Math.min(a.width, b.width)
const h = Math.min(a.height, b.height)
const diff = new PNG({ width: w, height: h })
const total = w * h
const mismatched = pixelmatch(
  stripAlpha(a, w, h), stripAlpha(b, w, h),
  diff.data, w, h,
  { threshold, includeAA: false }
)
fs.writeFileSync('tmp-diff.png', PNG.sync.write(diff))
const pct = ((mismatched / total) * 100).toFixed(3)
console.log(`尺寸 ${a.width}x${a.height} vs ${b.width}x${b.height}（比对 ${w}x${h}）`)
console.log(`差异像素 ${mismatched}/${total} = ${pct}%  (threshold=${threshold})`)
console.log(mismatched > 0 ? '差异图: tmp-diff.png' : '完全一致 ✅')
process.exit(mismatched > 0 ? 1 : 0)

/** 尺寸不齐时裁掉多余行（pngjs 行Stride按原宽，需重排） */
function stripAlpha(png, w, h) {
  if (png.width === w && png.height === h) return png.data
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    png.data.copy(out, y * w * 4, y * png.width * 4, y * png.width * 4 + w * 4)
  }
  return out
}
