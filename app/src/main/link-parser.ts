/**
 * 链接解析模块 —— 从用户粘贴的任意文本中提取 MasterGo 链接，
 * 解析 /goto/ 短链（302），提取 fileId / layerId / pageId。
 * 纯 HTTP，无需登录。
 */

export interface MgLink {
  /** 原始链接（短链则为重定向后的目标链接） */
  url: string
  fileId: string
  /** layer_id 优先，缺失回退 page_id */
  layerId?: string
  pageId?: string
  isShortLink: boolean
}

/** 从任意粘贴文本中提取第一个 MasterGo 链接；无则返回 null */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s，,。;；'"<>()（）【】]+/i)
  if (!m) return null
  // 双保险：从匹配结果里再截断到首个非法 URL 字符（中文/空格等），
  // 防止粘贴文本用全角空格或无分隔符导致整个尾段被吞进 URL
  const cut = m[0].search(/[一-鿿　-〿＀-￯\s《》，,。；：]/)
  return cut > 0 ? m[0].slice(0, cut) : m[0]
}

/** 判断是否 mastergo 链接 */
export function isMasterGoUrl(url: string): boolean {
  try {
    return /(^|\.)mastergo\.com$/.test(new URL(url).hostname)
  } catch {
    return false
  }
}


/** 安全 new URL：解析失败返回 null（粘贴文本可能含未截断的中文） */
function safeParseUrl(u: string): URL | null {
  try {
    return new URL(u)
  } catch {
    try {
      return new URL(encodeURI(u))
    } catch {
      return null
    }
  }
}

/** 从 URL 文本里取第一个查询参数值（URL 可能被中文文本截断，用宽松正则） */
export function extractFirstParam(urlText: string, key: string): string | null {
  const m = urlText.match(new RegExp(`[?&]${key}=([^&#\s，,。;；'"<>()（）【】]+)`))
  return m ? m[1] : null
}

/** 从目标 URL 解析 fileId/layerId */
export function parseTargetUrl(targetUrl: string): Omit<MgLink, 'url' | 'isShortLink'> | null {
  const u = new URL(targetUrl)
  // fileId：路径段中第一个纯数字段（/file/202788774176282 或 /prototype/202788774176282）
  const fileId = u.pathname.split('/').find((s) => /^\d{6,}$/.test(s))
  if (!fileId) return null
  // 参数名两种风格都兼容：设计页用 layer_id/page_id，原型预览页用 layerId/pageId（驼峰）
  const layerId = u.searchParams.get('layer_id') ?? u.searchParams.get('layerId') ?? undefined
  const pageId = u.searchParams.get('page_id') ?? u.searchParams.get('pageId') ?? undefined
  return { fileId, layerId, pageId }
}

/**
 * 原型预览页（/prototype/xxx）与设计页（/file/xxx）打开同一个文件，
 * 但原型页的 masterkit 桥 getLayerData 返回瘦身数据（无 fills，图标/背景全丢）。
 * 提取一律归一化到设计页 URL，渲染所需的全量填充只在设计页有。
 */
export function normalizeToDesignUrl(targetUrl: string): string | null {
  const u = safeParseUrl(targetUrl)
  if (!u) return null
  const parsed = parseTargetUrl(u.href)
  if (!parsed) return null
  const url2 = new URL(`https://mastergo.com/file/${parsed.fileId}`)
  if (parsed.layerId) url2.searchParams.set('layer_id', parsed.layerId)
  if (parsed.pageId) url2.searchParams.set('page_id', parsed.pageId)
  return url2.href
}

/**
 * 解析入口：输入可能是纯链接或带中文邀请语的长文本。
 * 短链 /goto/xxx 会发一次不跟随重定向的请求拿 Location。
 * @param fetchImpl 可注入的 fetch（主进程用 electron net 或 undici，走代理）
 */
export async function resolveMasterGoLink(
  text: string,
  fetchImpl: typeof fetch
): Promise<MgLink> {
  const raw = extractUrl(text)
  if (!raw) throw new Error('未在输入中找到链接，请粘贴包含 mastergo.com 链接的内容')

  if (!isMasterGoUrl(raw)) throw new Error(`不是 MasterGo 链接：${raw}`)

  // 短链：请求一次拿重定向目标。
  // 兼容两种 fetch 实现：redirect:'manual' 时从 Location 头取；
  // Electron net.fetch 强制 follow 时从 res.url（最终 URL）取。
  if (raw.includes('/goto/')) {
    const res = await fetchImpl(raw, { redirect: 'manual' })
    const loc = res.headers.get('location')
    const target = loc ? new URL(loc, raw).href : res.url

    // 有些短码会 301 到 /404（短码已过期或仅邀请语场景）。
    // 此时如果粘贴文本里带了 file=xxx 参数，直接用它兜底拼出目标链接。
    const targetUrl = safeParseUrl(target)
    if (targetUrl && /\/404$/.test(targetUrl.pathname)) {
      const fallback = extractFirstParam(raw, 'file')
      if (fallback) {
        const layerId = extractFirstParam(raw, 'layer_id')
        const pageId = extractFirstParam(raw, 'page_id')
        const url2 = new URL(`https://mastergo.com/file/${fallback}`)
        if (layerId) url2.searchParams.set('layer_id', layerId)
        if (pageId) url2.searchParams.set('page_id', pageId)
        const parsed2 = parseTargetUrl(url2.href)
        if (parsed2) return { url: url2.href, isShortLink: true, ...parsed2 }
      }
      throw new Error('短链已失效（跳转到 404），且文本中未找到 file= 参数')
    }

    if (!target || target === raw) throw new Error('短链解析失败：未获得重定向地址')
    const parsed = parseTargetUrl(target)
    if (!parsed) throw new Error(`重定向地址中未找到文件 ID：${target}`)
    return { url: target, isShortLink: true, ...parsed }
  }

  const parsed = parseTargetUrl(raw)
  if (!parsed) throw new Error(`链接中未找到文件 ID：${raw}`)
  // 原型预览页归一化到设计页（原型页桥返回瘦身数据，fills 全丢）
  const designUrl = normalizeToDesignUrl(raw)
  return { url: designUrl ?? raw, isShortLink: false, ...parsed }
}
