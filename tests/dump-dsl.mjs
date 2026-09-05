/**
 * 从最新导出 ZIP 的 meta 无法还原 DSL —— DSL 需要从应用内落盘。
 * 这里读取渲染进程保存的 window.__dsl__ 快照：应用内提取后按 Ctrl+S 落盘。
 * 兜底：直接检查 log 中最近一次提取的统计与 ZIP 里的 HTML 一致性。
 */
