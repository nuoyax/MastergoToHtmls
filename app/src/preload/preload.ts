/**
 * preload —— 渲染进程与主进程/webview 的安全桥
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mgApi', {
  resolveLink: (text: string) => ipcRenderer.invoke('mg:resolve-link', text),
  getInjectScript: () => ipcRenderer.invoke('mg:get-inject-script'),
  openDesign: (url: string) => ipcRenderer.invoke('mg:open-design', url),
  extractDsl: () => ipcRenderer.invoke('mg:extract-dsl'),
  exportHtml: (html: string, slices?: any[]) => ipcRenderer.invoke('mg:export', html, slices),
  exportMulti: (payload: any) => ipcRenderer.invoke('mg:export-multi', payload),
  attachDebugger: () => ipcRenderer.invoke('mg:attach-debugger'),
  getCaptured: () => ipcRenderer.invoke('mg:get-captured'),
  saveCaptured: (reqId: string, filePath?: string) => ipcRenderer.invoke('mg:save-captured', reqId, filePath),
  clearCaptured: () => ipcRenderer.invoke('mg:clear-captured'),
  saveDsl: (raw: string) => ipcRenderer.invoke('mg:save-dsl', raw),
  showInFolder: (p: string) => ipcRenderer.invoke('mg:show-in-folder', p),
  clearCookies: () => ipcRenderer.invoke('mg:clear-cookies'),
  // 诊断日志：渲染进程把排查日志发给主进程落盘（debug-render.log）
  logFile: (line: string) => ipcRenderer.send('mg:log-file', line),
  onLoadUrl: (cb: (url: string) => void) => {
    ipcRenderer.on('mg:load-url', (_e, url: string) => cb(url))
  },
})
