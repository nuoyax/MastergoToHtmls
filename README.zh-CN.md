# MasterGo → HTML 导出工具

[English](README.md)

许可证：[MIT](LICENSE)

Electron 桌面工具：在内置 webview 中打开 MasterGo 设计稿，通过页面自身渲染引擎提取完整图层树（DSL），渲染为高保真的独立 `index.html`，并把全部图标切图打包成带时间戳的 ZIP。

## 功能特性

- **粘贴即用**：从任意粘贴文本中识别 MasterGo 链接，自动跟随 `/goto/` 短链（302）提取 `fileId` / `layerId` / `pageId`——解析无需登录。
- **应用内登录**：设计稿在内置 webview 中打开，登录一次 mastergo.com 后会话保持。
- **图层树提取（DSL）**：向 webview 注入提取脚本，劫持页面 webpack 运行时，定位内部 `masterkit`（WASM）桥，调用官方 `getLayerData` API 递归重建完整图层树——与 MasterGo 编辑器渲染所用的同一份数据。
- **官方 SVG 图标导出**：无填充数据的矢量/图标节点走 MasterGo 官方 SVG 导出模块（模块 `0152`），图标在 HTML 中与设计稿完全一致，而不是线条状的散碎路径。
- **高保真 HTML 渲染**：绝对定位、自包含的单文件 HTML——填充（纯色/图片）、描边、圆角、透明度、内/外阴影、模糊、旋转/缩放、多段富文本、SVG 图标背景。
- **多页导出（可选模式）**：每个画板独立一个 HTML 页 + 导航 `index.html`，html/css/js 拆分为独立文件。两种布局引擎：
  - **流式布局推断**（`mg-flow.js`）：按兄弟节点包围盒推断每个容器的 flex 方向 / gap / padding / 对齐 / wrap，保守降级——旋转、镜像、兄弟重叠 >15%、蒙版子节点、缺尺寸、子节点 >40 任一命中即该容器回退绝对定位（对齐 Anima / FigmaToCode 的「容器级 flex + 降级」工程实践）。
  - **绝对定位**：同样拆分文件结构，位置完全保真。
  - 共享 `css/main.css`，视觉样式进 hash 去重 class（位置留 inline）；`js/main.js` 基础脚本（图片失败降级 + `?debug=1` 点击高亮图层）；`meta.json` 画板清单。
- **切图导出**：按「完整图标」为单位批量导出（不拆散碎子路径），界面可选格式——SVG / PNG / JPG / WebP，支持 1x–4x 倍图。
- **时间戳 ZIP 导出**：免路径弹窗，每次导出写入 `download/mastergo-export-YYYYMMDD-HHMMSS.zip`，内含：
  - `index.html` — 渲染好的原型页面
  - `slices/<画板>/<切图名>/<名称>@Nx.<格式>` — 按画板和切图名分目录，同一图标的各倍图放在同一目录
  - `slices/MANIFEST.md` — 清单表格：每个切图对应的目录与文件
- 多页模式导出为 `download/mastergo-multi-YYYYMMDD-HHMMSS.zip`，结构：`index.html`（导航页）、`pages/<画板>/index.html`、`css/main.css`、`js/main.js`、`meta.json`、`slices/`（与单文件模式一致）。
- **传输列表**：下载图标角标每次导出 +1，点击条目可直接在资源管理器中打开文件。

## 工作原理

```
粘贴链接 ──► link-parser（302 解析）──► webview 加载设计稿 ──► 注入 mg-inject.js
    │                                                                        │
    │         webpack require 劫持 ──► masterkit 桥（WASM）                   │
    │         getLayerData 递归遍历 ──► 图层树 JSON + __svgData（官方 SVG）     │
    │                                                                        ▼
    └─────────── mg-render.js（DSL → 绝对定位 HTML）◄──── extractDsl()
                                                 │
                                  exportSlices() ──► canvas 栅格化（PNG/JPG/WebP）
                                                 ▼
                              IPC mg:export ──► archiver ──► 时间戳 ZIP
```

提取策略（`app/src/main/mg-inject.js`，按优先级）：

1. **Fetch/XHR 拦截** — 包装 `window.fetch` 与 XHR，记录 `/data/` 二进制响应（诊断用）。
2. **CDP 调试器** — 附加到 webview 的 guest webContents，抓取 `/data/` 响应体（兜底路径）。
3. **Webpack 桥（主路径）** — 劫持 `webpackJsonp.push` 拿到 `__webpack_require__`，按逆向得到的模块 ID（`fcaa` / `ae3a`）取得 masterkit 桥，然后 `getPageListVal` → `getAllChildren` → `getLayerData` 递归重建图层树。

渲染器（`app/src/renderer/mg-render.js`）将图层树转为内联样式的绝对定位 HTML：颜色同时兼容 `{red,green,blue,alpha}` 与 `{r,g,b,a}` 两种字段风格；文本颜色从块级 style 兜底到节点填充色；多段文本按段用 `<span>` 渲染各自颜色/字号；字体栈在 Windows 上回退（PingFang SC → 微软雅黑）；支持阴影/模糊/描边/圆角/透明度。

多页导出（`app/src/renderer/mg-multi.js` + `mg-flow.js`）通过 `ctx.emit` 钩子复用 `mg-render.renderNode`：每个画板独立成页，节点样式串拆为 hash 去重 class（位置留 inline）进共享 `css/main.css`；flow 模式下每个含 children 的容器经 `mg-flow.inferLayout` 判定——可推断的容器改为 flex 布局（方向/gap/padding/对齐/wrap），子节点脱离绝对定位；推断不出的保持现状并把降级原因计入 `stats.degrade`。

## 项目结构

```
app/
  src/
    main/
      main.ts          # Electron 入口：窗口、IPC 路由、ZIP 导出（archiver）
      link-parser.ts   # URL 提取 + /goto/ 短链解析（fileId/layerId/pageId）
      mg-inject.js     # 注入 webview 的脚本：webpack 劫持、masterkit 桥、DSL 遍历、
                       #   官方 SVG 导出、切图收集与栅格化
    preload/
      preload.ts       # contextBridge：mgApi（resolveLink/openDesign/extractDsl/exportHtml/...）
    renderer/
      index.html       # 操作界面：链接输入、步骤按钮、切图格式/倍图选择、日志
      renderer.js      # 步骤编排：解析 → 加载 → 提取 → 导出
      mg-render.js     # DSL → HTML 渲染器（绝对定位、内联 CSS）
      mg-flow.js       # 流式布局推断：包围盒 flex 判定 + 降级规则
      mg-multi.js      # 多页导出：每画板独立页、class 去重、导航页、资产组装
      transfer.js      # 传输列表 UI（导出角标计数）
  tsconfig.json
docs/                  # 技术架构文档（docx）+ 架构图
download/              # 导出产物（已 gitignore）
```

## 快速开始

```bash
npm install
npm start        # 编译（tsc）并启动 Electron
```

1. 粘贴邀请链接（如 `https://mastergo.com/goto/XXXX?page_id=M&layer_id=3:865`），点 **1. 解析链接**。
2. 在右侧内置 webview 登录 mastergo.com，点 **2. 加载设计稿**。
3. 点 **3. 提取图层树 DSL**（页面导航后自动注入提取脚本）。
4. 选择导出模式——**单文件（绝对定位，默认）** / **多页+拆分（流式布局）** / **多页+拆分（绝对定位）**——以及切图格式（SVG/PNG/JPG/WebP）与倍图（1x–4x），点 **4. 导出 HTML**。
5. 在 `download/` 目录下取 ZIP；传输列表角标每次导出 +1。

### 代理

主进程与 webview 的全部流量走 `MG_PROXY`，默认 `http://127.0.0.1:7890`。可在启动前自定义：

```bash
MG_PROXY=http://127.0.0.1:1080 npm start
```

### 视觉回归

导出 HTML 截图 → 与基线逐像素对比（pixelmatch），改动渲染规则后跑一遍防止回归：

```bash
npm run shot -- download/mastergo-export-XXXX.zip tmp-new.png   # 截图
npm run diff -- tmp-base.png tmp-new.png                        # 差异>0 生成 tmp-diff.png，退出码 1
```

冒烟测试（DSL 渲染结构断言，含 classic 与多页模式）：`node tests/smoke.mjs`；ZIP 渲染核对：`node tests/compare-zip.mjs`。

### 说明与限制

- 需要有邀请/分享权限的 MasterGo 文件链接，并在 webview 内登录。
- webpack 模块 ID（`fcaa`/`ae3a`、SVG 导出模块 `0152`）逆向自 MasterGo 前端 bundle，网站更新后可能变化；注入脚本在 ID 失效时会回退为遍历模块缓存自动查找。
- 图片填充直接引用 MasterGo CDN（`image-resource.mastergo.com`），离线查看导出的 HTML 时照片类内容需要联网。
- 实际仅支持 Windows（代理开关 + 资源管理器集成）；字体在缺失时由字体栈映射（PingFang SC → 微软雅黑）。

## 文档

- [技术架构文档](docs/技术架构文档.docx) — 架构图 / 时序图 / 流程图（`docs/arch_diagram.png`、`docs/seq_parse_export.png`、`docs/flow_export_pipeline.png`），规格见 `docs/diagrams.json`，可用 `python tools/gen_diagrams.py` 重新生成。

### 架构图

![架构图](docs/arch_diagram.png)

### 核心时序图

![核心时序图](docs/seq_parse_export.png)

### 导出流水线流程图

![导出流水线流程图](docs/flow_export_pipeline.png)

## 免责声明

本项目**仅用于学习参考，不能用于商业目的**。项目依赖 MasterGo 非官方内部接口，接口随时可能变化，使用本项目产生的任何后果由使用者自行承担，作者不承担任何责任。相关商标归各自权利人所有。
