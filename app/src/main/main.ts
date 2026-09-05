/**
 * 主进程入口 —— Electron 应用
 * 职责：创建窗口、内置 webview（登录+解析 mastergo 页面）、IPC 路由
 */
import { app, BrowserWindow, ipcMain, net, session, dialog, webContents, shell } from 'electron'
import * as path from 'path'
import { resolveMasterGoLink, MgLink } from './link-parser'

let mainWindow: BrowserWindow | null = null

// 默认直连；MG_PROXY 显式设置时才走代理（代理进程挂了会导致 webview 整页空白）
const PROXY = process.env.MG_PROXY || ''
const DIRECT = !PROXY

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    autoHideMenuBar: true,
    title: 'MasterGo转HTML',
    icon: path.join(__dirname, '../../icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })
  mainWindow.loadFile(path.join(__dirname, '../../src/renderer/index.html'))
  // 页面 <title> 会覆盖窗口标题，setWindowTitle 锁定为应用名
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault()
    mainWindow?.setTitle('MasterGo转HTML')
  })

  // 全部流量走代理（MG_PROXY 设置时）；默认直连
  if (PROXY) app.commandLine.appendSwitch('proxy-server', PROXY)

  // 允许 webview 内嵌 mastergo
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
  })
}

// IPC：解析链接（主进程原生 fetch，走 7890 代理）
// 不用 net.fetch：它不支持 redirect:'manual'，且 follow 后 res.url 也拿不到中间 301 目标；
// Node 原生 fetch 的 manual 模式会返回 opaqueredirect，但 Location 头可见（已实测）
ipcMain.handle('mg:resolve-link', async (_e, text: string): Promise<MgLink> => {
  const proxiedFetch: typeof fetch = (url, init) =>
    fetch(url, { ...init, redirect: 'manual' })
  return resolveMasterGoLink(text, proxiedFetch)
})

// IPC：加载设计稿到 webview，注入提取脚本
ipcMain.handle('mg:open-design', async (_e, targetUrl: string) => {
  const wc = mainWindow?.webContents
  if (!wc) return
  wc.send('mg:load-url', targetUrl)
})

// IPC：返回注入脚本源码
ipcMain.handle('mg:get-inject-script', async () => {
  const fs = await import('fs')
  return fs.readFileSync(path.join(__dirname, '../../src/main/mg-inject.js'), 'utf-8')
})

// IPC：webview 注入脚本调用 —— 提取图层树
ipcMain.handle('mg:extract-dsl', async (e) => {
  const wc = e.sender
  try {
    const script = `(window.__MG_EXTRACT__ ? JSON.stringify(window.__MG_EXTRACT__.extractDsl()) : null)`
    const raw = await wc.executeJavaScript(script, true)
    if (!raw) {
      // 诊断：注入脚本在不在？探测状态如何？
      const diag = await wc
        .executeJavaScript(
          `(window.__MG_EXTRACT__ ? JSON.stringify(window.__MG_EXTRACT__.probe()) : 'NO_INJECT')`,
          true
        )
        .catch(() => 'EXEC_FAIL')
      console.log('[mg:extract-dsl] 诊断:', diag)
      return { ok: false, diag }
    }
    return { ok: true, dsl: JSON.parse(raw) }
  } catch (err: any) {
    console.error('[mg:extract-dsl] 异常:', err?.message ?? err)
    return { ok: false, diag: 'EXCEPTION: ' + (err?.message ?? err) }
  }
})

// IPC：附加 CDP 调试器到指定 webContents，抓取 /data/ XHR 的响应体
async function attachDebugger(wc: Electron.WebContents, tag: string) {
  try {
    wc.debugger.attach('1.3')
  } catch (e: any) {
    if (!/attached/.test(e?.message ?? '')) throw e
  }
  if (!wc.debugger.isAttached()) return
  try {
    await wc.debugger.sendCommand('Network.enable', { maxPostDataSize: 65536 })
    console.log('[debugger] attached:', tag)
  } catch (e: any) {
    console.error('[debugger] enable failed:', e?.message)
  }
}

// 全局记录：请求Id -> {url, wcTag}；响应体存 Buffer
const pendingRequests = new Map<string, { url: string; wc: Electron.WebContents }>()
const capturedResponses = new Map<string, { url: string; body: Buffer }>()

function handleDebuggerEvent(wc: Electron.WebContents, method: string, params: any) {
  if (method === 'Network.requestWillBeSent') {
    const url: string = params?.request?.url ?? ''
    if (url.includes('/data/')) {
      pendingRequests.set(params.requestId, { url, wc })
      console.log('[cdp] request:', url.slice(0, 140))
    }
  } else if (method === 'Network.loadingFinished') {
    const pending = pendingRequests.get(params.requestId)
    if (!pending) return
    pendingRequests.delete(params.requestId)
    ;(wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }) as any)
      .then((res: any) => {
        if (!res) return
        const body: Buffer = res.base64Encoded ? Buffer.from(res.body, 'base64') : Buffer.from(res.body, 'utf-8')
        capturedResponses.set(params.requestId, { url: pending.url, body })
        console.log('[cdp] captured:', pending.url.slice(0, 140), 'size=', body.length,
          'head=', body.slice(0, 32).toString('hex'))
      })
      .catch(() => {})
  }
}

// 给 webview 的 webContents 挂调试器（渲染进程通过 IPC 触发）
ipcMain.handle('mg:attach-debugger', async (e) => {
  const hostWc = e.sender
  // webview 的 guest webContents：通过宿主页 executeJavaScript 拿不到，
  // 但 webview tag 的 guest 可以通过 session 拦截。这里改用：
  // 宿主窗口的所有 frame 中找 mastergo 的 guest webContents
  const allWc = (webContents as any).getAllWebContents() as Electron.WebContents[]
  const guests = allWc.filter((w) => w.hostWebContents && w.session === hostWc.session)
  const target = guests.length ? guests : allWc.filter((w) => w !== hostWc)
  for (const g of target) {
    try {
      await attachDebugger(g, `guest-${g.id}`)
      g.debugger.on('message', (_ev, method, params) => handleDebuggerEvent(g, method, params))
      g.debugger.on('detach', () => console.log('[debugger] detached'))
    } catch (err: any) {
      console.error('[debugger] attach failed guest', g.id, err?.message)
    }
  }
  return target.map((g) => g.id)
})

// IPC：取已捕获的 /data/ 响应体（渲染进程轮询）
ipcMain.handle('mg:get-captured', async (_e) => {
  const out = Array.from(capturedResponses.entries()).map(([id, r]) => ({
    id,
    url: r.url,
    size: r.body.length,
  }))
  return out
})

// IPC：按 id 取响应体（base64），并可选保存
ipcMain.handle('mg:save-captured', async (_e, reqId: string, filePath?: string) => {
  const cap = capturedResponses.get(reqId)
  if (!cap) return null
  if (filePath) {
    const fs = await import('fs')
    fs.writeFileSync(filePath, cap.body)
    return { saved: filePath, size: cap.body.length }
  }
  return { data: cap.body.toString('base64'), size: cap.body.length }
})

ipcMain.handle('mg:clear-captured', async () => {
  capturedResponses.clear()
  return true
})

// IPC：落盘最近一次提取的 DSL（冒烟回归用：tests/smoke.mjs 读 download/dsl-latest.json）
ipcMain.handle('mg:save-dsl', async (_e, raw: string) => {
  try {
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(process.cwd(), 'download')
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, 'dsl-latest.json')
    fs.writeFileSync(f, raw)
    return f
  } catch (err: any) {
    return 'ERR: ' + (err?.message ?? err)
  }
})

ipcMain.handle('mg:show-in-folder', async (_e, p: string) => {
  if (p) shell.showItemInFolder(p)
  return true
})

// 诊断日志落盘：log/debug-render.log（renderer/webview 里 console.log 看不到时用）
ipcMain.on('mg:log-file', (_e, line: string) => {
  try {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const dir = path.join(process.cwd(), 'log')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'debug-render.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* 日志失败不影响主流程 */ }
})

// 主进程 console.log 走同步管道写 stdout；终端关闭/管道断开（如后台 npm start
// 被杀）时 EPIPE 会变成未捕获异常弹窗。全部兜底吞掉——日志失败不影响主流程
process.stdout?.on?.('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') return
  throw e
})
process.stderr?.on?.('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') return
  throw e
})

// IPC：导出 ZIP（index.html + slices/ 切图目录 + 清单）
// 免对话框：直接写入项目 download/ 目录，文件名带时间戳
ipcMain.handle('mg:export', async (_e, html: string, slices?: any[]) => {
  const fs = await import('fs')
  const path = await import('path')
  const outDir = path.join(process.cwd(), 'download')
  fs.mkdirSync(outDir, { recursive: true })
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const filePath = path.join(outDir, `mastergo-export-${ts}.zip`)
  const archiver = (await import('archiver') as any).default ?? (await import('archiver') as any)
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', () => {
      console.log('[export] zip written:', filePath, archive.pointer(), 'bytes')
      resolve(filePath)
    })
    archive.on('error', reject)
    archive.pipe(output)
    archive.append(html, { name: 'index.html' })
    // 附加导出元信息（DSL 摘要，便于复查/二次处理）
    const dsl = (globalThis as any).__mgLastDsl
    if (dsl) {
      archive.append(JSON.stringify({ nodeCount: dsl.__nodeCount, source: dsl.__source }, null, 2), {
        name: 'meta.json',
      })
    }
    // 切图：slices/<画板>/<切图名>/<文件>@Nx.<fmt>，倍图同目录；清单 MANIFEST.md
    const sliceList = Array.isArray(slices) ? slices : []
    if (sliceList.length) {
      const lines = [
        `# 切图清单`,
        ``,
        `| 切图 | 所在目录 | 文件 |`,
        `| --- | --- | --- |`,
      ]
      for (const s of sliceList) {
        const dir = `slices/${s.dir}`
        for (const f of s.files) {
          archive.append(Buffer.from(f.b64, 'base64'), { name: `${dir}/${f.file}` })
          lines.push(`| ${s.name} | ${dir} | ${f.file} |`)
        }
      }
      archive.append(lines.join('\n'), { name: 'slices/MANIFEST.md' })
    }
    archive.finalize()
  })
})

// IPC：多页导出 ZIP（index.html + pages/<分类>/<slug>/index.html + css/ + js/ + slices/ + meta.json）
// 分类：mobile（移动端屏幕）/ other（横幅、组件片段）；icon 级不出页（走切图）
ipcMain.handle('mg:export-multi', async (_e, payload: any) => {
  const fs = await import('fs')
  const path = await import('path')
  const outDir = path.join(process.cwd(), 'download')
  fs.mkdirSync(outDir, { recursive: true })
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const filePath = path.join(outDir, `mastergo-multi-${ts}.zip`)
  const archiver = (await import('archiver') as any).default ?? (await import('archiver') as any)
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', () => {
      console.log('[export-multi] zip written:', filePath, archive.pointer(), 'bytes')
      resolve(filePath)
    })
    archive.on('error', reject)
    archive.pipe(output)
    // 导航页
    archive.append(payload.indexHtml ?? '', { name: 'index.html' })
    // 每画板独立页（category: mobile | other；旧数据无 category 时归 other）
    for (const p of payload.pages ?? []) {
      const cat = p.category === 'mobile' || p.category === 'other' ? p.category : 'other'
      archive.append(p.html, { name: `pages/${cat}/${p.slug}/index.html` })
    }
    // 拆分资产（css/main.css、js/main.js …）
    for (const [name, content] of Object.entries(payload.assets ?? {})) {
      if (content) archive.append(String(content), { name })
    }
    // meta.json：mode + boards 清单（slug→画板信息，与 slices 目录名对齐）
    archive.append(JSON.stringify({ ...(payload.meta ?? {}), slicesDir: 'slices' }, null, 2), { name: 'meta.json' })
    // 切图（与 classic 相同结构）
    const sliceList = Array.isArray(payload.slices) ? payload.slices : []
    if (sliceList.length) {
      const lines = [`# 切图清单`, ``, `| 切图 | 所在目录 | 文件 |`, `| --- | --- | --- |`]
      for (const s of sliceList) {
        const dir = `slices/${s.dir}`
        for (const f of s.files) {
          archive.append(Buffer.from(f.b64, 'base64'), { name: `${dir}/${f.file}` })
          lines.push(`| ${s.name} | ${dir} | ${f.file} |`)
        }
      }
      archive.append(lines.join('\n'), { name: 'slices/MANIFEST.md' })
    }
    archive.finalize()
  })
})

// IPC：清除 MasterGo 登录态（webview 出现 500/avatar 报错时，会话 Cookie 残缺导致）
ipcMain.handle('mg:clear-cookies', async () => {
  try {
    // 主窗口 session（webview 与宿主共用 defaultSession）
    const ses = session.defaultSession
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    })
    console.log('[clear-cookies] mastergo 登录态已清除')
    return true
  } catch (err: any) {
    console.error('[clear-cookies] 失败:', err?.message)
    return false
  }
})

app.whenReady().then(() => {
  if (PROXY) session.defaultSession.setProxy({ proxyRules: PROXY }).catch(() => {})
  // 诊断：主进程侧观察 webview 发出的所有请求，找 /data/ 与 wasm 的真实通道
  const seenReq = new Set<string>()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url
    if (!seenReq.has(u) && (u.includes('/data/') || u.includes('wasm') || u.includes('masterkit') || u.includes('/file/2'))) {
      seenReq.add(u)
      console.log('[webRequest]', details.resourceType, u.slice(0, 160))
    }
    callback({})
  })
  // 关键：去掉 UA 里的 Electron 标识，否则 mastergo 前端会走"官方桌面客户端"分支
  // 调用 window.require（nodeIntegration），导致 500 / window.require is not a function
  const ua = session.defaultSession.getUserAgent().replace(/Electron\/[\d.]+\s/i, '')
  session.defaultSession.setUserAgent(ua)
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
