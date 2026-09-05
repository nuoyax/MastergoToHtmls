/**
 * 通用视觉回归：用 Electron 渲染导出的 index.html 并截图。
 * 用法: node tests/screenshot.mjs <zip或index.html路径> [outPng] [boardIndex] [scale]
 * 默认取 download/ 最新 zip，整页截图到 tmp-shot.png。
 * 截图后用图像对比（人读或 compare-regions.mjs）与官方切图核对。
 */
import electron from 'electron'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const { app, BrowserWindow } = electron

const arg = process.argv[2]
const out = process.argv[3] || 'tmp-shot.png'
const boardIndex = parseInt(process.argv[4] || '-1', 10)

function latestZip() {
  const dir = path.resolve('download')
  const zips = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort()
  return zips.length ? path.join(dir, zips[zips.length - 1]) : null
}

let src = arg || latestZip()
if (!src) {
  console.error('没有可用的 zip / html')
  process.exit(1)
}
src = path.resolve(src)
let htmlPath = src
if (src.endsWith('.zip')) {
  const tmp = path.resolve('.tmp-shot')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  execSync(`unzip -q -o "${src}" index.html`, { cwd: tmp })
  htmlPath = path.join(tmp, 'index.html')
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1200,
    show: false,
    webPreferences: { offscreen: true }, // javascript 必须开，否则 board 定位 executeJavaScript 拿不到结果
  })
  await win.loadFile(htmlPath)
  await new Promise((r) => setTimeout(r, 1500)) // 等 CDN 图
  if (boardIndex >= 0) {
    // 只截某个画板卡片
    const rect = await win.webContents
    .executeJavaScript(
      `(function(){const b=document.querySelectorAll('.mg-board')[${boardIndex}];` +
        `if(!b)return null;const r=b.getBoundingClientRect();` +
        `return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
      true
    )
    .catch(() => null)
    if (rect) {
      let img = await win.webContents.capturePage(rect)
      // offscreen 渲染偶发首帧空图：重试一次
      if (!img.toPNG().length) {
        await new Promise((r) => setTimeout(r, 800))
        img = await win.webContents.capturePage(rect)
      }
      fs.writeFileSync(path.resolve(out), img.toPNG())
      console.log('board#' + boardIndex + ' →', path.resolve(out), rect.width + 'x' + rect.height)
      app.quit()
      return
    }
  }
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.resolve(out), img.toPNG())
  console.log('full →', path.resolve(out))
  app.quit()
})
