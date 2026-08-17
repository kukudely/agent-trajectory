#!/usr/bin/env node
/**
 * Render an official Claude Code transcript JSONL to a standalone HTML timeline.
 *
 *   node scripts/render-transcript.mjs <transcript.jsonl> [out.html]
 *
 * With no out.html, the HTML is printed to stdout.
 * Useful when you do not want to install the plugin at all.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const [file, out] = process.argv.slice(2)
if (!file) {
  console.error('usage: node scripts/render-transcript.mjs <transcript.jsonl> [out.html]')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && b.text != null ? b.text : '')).join('\n')
  return ''
}
const jsonPre = (v) => {
  if (v == null) return ''
  try {
    return esc(JSON.stringify(v, null, 2))
  } catch {
    return esc(String(v))
  }
}

// Full tool results, keyed by tool use id, attached after the pass below.
const results = new Map()
for (const line of lines) {
  if (line.type === 'tool_result') results.set(line.tool_use_id, { text: textOf(line.content), isError: line.is_error })
}

const items = []
for (const line of lines) {
  if (line.type === 'system') {
    if (line.subtype === 'init') items.push({ kind: 'system', text: Array.isArray(line.content) ? line.content.join('') : '' })
  } else if (line.type === 'user') {
    items.push({ kind: 'user', text: textOf(line.content) })
  } else if (line.type === 'assistant') {
    const blocks = Array.isArray(line.content) ? line.content : []
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
    if (text.trim()) items.push({ kind: 'assistant', text })
    for (const b of blocks.filter((b) => b.type === 'tool_use')) {
      const r = results.get(b.id) || {}
      items.push({ kind: 'tool', tool: b.name, input: b.input, result: r.text, isError: r.isError })
    }
  } else if (line.type === 'summary') {
    items.push({ kind: 'system', text: '摘要：' + String(line.summary ?? '').slice(0, 400) })
  }
}

const css = `
body { margin:0; font:14px/1.6 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background:#f6f7f9; color:#1f2328; }
main { max-width:960px; margin:0 auto; padding:20px; }
h1 { font-size:18px; }
.card { background:#fff; border:1px solid #e4e6eb; border-left:3px solid #9ca3af; border-radius:8px; padding:10px 14px; margin:10px 0; }
.card.user { border-left-color:#2563eb; } .card.assistant { border-left-color:#111827; } .card.tool { border-left-color:#7c3aed; }
.card.system { background:#fafafa; color:#6b7280; }
.badge { font-size:11px; padding:1px 8px; border-radius:999px; color:#fff; }
.badge.user { background:#2563eb; } .badge.assistant { background:#111827; } .badge.tool { background:#7c3aed; } .badge.end { background:#9ca3af; }
pre { background:#f6f8fa; border:1px solid #e4e6eb; border-radius:6px; padding:8px; overflow:auto; max-height:340px; font:12px/1.5 ui-monospace, Consolas, monospace; white-space:pre-wrap; }
.body { white-space:pre-wrap; word-break:break-word; }
.meta { color:#6b7280; font-size:12px; }
code { font-family:ui-monospace, Consolas, monospace; font-size:12px; background:#f0f1f3; padding:1px 5px; border-radius:4px; }
`

const body = items
  .map((it) => {
    if (it.kind === 'user') return '<div class="card user"><span class="badge user">你</span><div class="body">' + esc(it.text) + '</div></div>'
    if (it.kind === 'assistant') return '<div class="card assistant"><span class="badge assistant">Claude</span><div class="body">' + esc(it.text) + '</div></div>'
    if (it.kind === 'tool') {
      return '<div class="card tool"><span class="badge tool">工具</span> <code>' + esc(it.tool) + '</code>' +
        '<pre>' + jsonPre(it.input) + '</pre>' +
        (it.result != null ? '<pre>' + esc(it.result) + '</pre>' : '') +
        '</div>'
    }
    if (it.kind === 'system') return '<div class="card system"><span class="badge end">系统</span><div class="body">' + esc(it.text).slice(0, 800) + '</div></div>'
    return ''
  })
  .join('\n')

const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>' + esc(basename(file)) + '</title><style>' + css + '</style></head><body><main><h1>' + esc(basename(file)) + '</h1>' + body + '</main></body></html>'

if (out) {
  writeFileSync(out, html)
  console.log('rendered', out)
} else {
  process.stdout.write(html)
}
